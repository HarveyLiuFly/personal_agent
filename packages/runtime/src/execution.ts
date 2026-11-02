import { ExecutionLedger, LedgerError, hashInput } from '../../store/src/ledger.ts';
import type { RunToken, RunRecord } from '../../store/src/ledger.ts';
import { StdioRpcClient, RpcFailure, isObject } from '../../codex-adapter/src/rpc.ts';
import type { RpcOptions } from '../../codex-adapter/src/rpc.ts';
import { ThreadProjection } from '../../codex-adapter/src/projection.ts';
import { launchArguments, runtimeEnvironment } from '../../codex-adapter/src/launch.ts';
import type { ThreadStartParams } from '../../codex-adapter/src/generated/v2/ThreadStartParams.ts';
import type { TurnStartParams } from '../../codex-adapter/src/generated/v2/TurnStartParams.ts';
import type { ModelListResponse } from '../../codex-adapter/src/generated/v2/ModelListResponse.ts';
import type { RunSummary, RunView } from '../../contracts/src/views.ts';
import { InteractionBroker } from './interactions.ts';
import type { InteractionContext } from './interactions.ts';

const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
function query(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new LedgerError('INVALID_EXECUTION_QUERY');
  return value;
}
function summary(row: RunRecord): RunSummary {
  const { runId, taskId, title, status, taskStatus, threadId, turnId, blocked } = row;
  return { runId, taskId, title, status, taskStatus, threadId, turnId, blocked };
}
interface Session { token: RunToken; projectId: string; submissionKey: string; rpc?: StdioRpcClient; projection?: ThreadProjection; threadId?: string; turnId?: string; intentId?: string; broker?: InteractionBroker; interrupt?: Promise<void>; stopTimer?: NodeJS.Timeout; turnEnded?: boolean }
export function executionArguments(directory: string): string[] {
  const base = launchArguments(directory);
  // M1 enables local built-in tools only; external connectors and autonomous features have separate gates.
  return [...base.slice(0, -2), ...['mcp_servers={}', 'features.apps=false', 'features.plugins=false', 'features.hooks=false',
    'features.goals=false', 'features.multi_agent=false', 'features.browser_use=false', 'features.computer_use=false'].flatMap(value => ['-c', value]), ...base.slice(-2)];
}
export interface ExecutionOptions {
  executable: string; stateDirectory: string; codexHome?: string; timeoutMs?: number;
  mode?: 'readOnly' | 'workspaceWrite'; interactionTimeoutMs?: number;
  interruptTimeoutMs?: number;
  /** Trusted tests only; no IPC entry point can supply this factory. */
  connect?: (callbacks: Pick<RpcOptions, 'onNotification' | 'onServerRequest' | 'onServerResponse'>) => StdioRpcClient;
}
/** Single foreground execution owner. Queries expose only scoped, bounded display projections. */
export class ForegroundExecution {
  private store: ExecutionLedger;
  private options: ExecutionOptions;
  private session?: Session;
  private completion?: Promise<void>;
  private epoch = 0;
  readonly diagnostics = { clientThreadStarts: 0, clientTurnStarts: 0, notificationCount: 0, serverRequestsDenied: 0, selectedModel: '', externalMcpServers: -1, disabledInheritedMcpServers: 0, failureCode: '', remoteFailureCategory: '', phase: 'idle' };
  constructor(store: ExecutionLedger, options: ExecutionOptions) { this.store = store; this.options = options; }
  get busy(): boolean { return this.session !== undefined; }
  list(input: unknown): RunSummary[] {
    const q = query(input, ['projectId']); if (!identity(q.projectId)) throw new LedgerError('INVALID_EXECUTION_QUERY');
    this.store.workspace(q.projectId); return this.store.runs(q.projectId, { snapshots: false }).map(summary);
  }
  view(input: unknown): RunView {
    const q = query(input, ['projectId','runId']);
    if (!identity(q.projectId) || !identity(q.runId)) throw new LedgerError('INVALID_EXECUTION_QUERY');
    this.store.workspace(q.projectId);
    const run = this.store.runs(q.projectId, { runId: q.runId })[0];
    if (!run) throw new LedgerError('RUN_NOT_IN_PROJECT');
    return { ...summary(run), snapshot: run.snapshot };
  }
  submit(input: unknown): RunSummary {
    const q = query(input, ['projectId','text','submissionKey']);
    if (!identity(q.projectId) || !identity(q.submissionKey) || typeof q.text !== 'string') throw new LedgerError('INVALID_EXECUTION_QUERY');
    if (this.busy) {
      if (this.session?.projectId !== q.projectId || this.session.submissionKey !== q.submissionKey) throw new LedgerError('RUNTIME_BUSY');
      const previous = this.store.beginRun(q.projectId, q.text, q.submissionKey, this.options.mode ?? 'readOnly');
      if (previous.created) throw new LedgerError('RUNTIME_BUSY');
      return summary(this.store.runs(q.projectId, { snapshots: false, runId: previous.token.runId })[0]!);
    }
    const { token, created } = this.store.beginRun(q.projectId, q.text, q.submissionKey, this.options.mode ?? 'readOnly');
    if (created) {
      const session: Session = { token, projectId: q.projectId, submissionKey: q.submissionKey }; this.session = session;
      this.completion = this.execute(session, q.text).finally(() => { if (this.session === session) this.session = undefined; });
    }
    return summary(this.store.runs(q.projectId, { snapshots: false, runId: token.runId })[0]!);
  }
  async wait(): Promise<void> { await this.completion; }
  interactions(input: unknown) {
    const run = this.view(input), q = input as Record<string,string>;
    return this.store.requests(q.projectId!, run.runId);
  }
  reply(input: unknown): void {
    if (!isObject(input) || Object.keys(input).some(key => !['projectId','runId','requestId','decision','answers'].includes(key)) || !identity(input.requestId)) throw new LedgerError('INVALID_INTERACTION_REPLY');
    const run = this.view({ projectId: input.projectId, runId: input.runId });
    if (!this.session || this.session.token.runId !== run.runId || !this.session.broker) throw new LedgerError('STALE_SERVER_REQUEST');
    this.session.broker.reply(input.requestId, input);
  }
  async interrupt(input: unknown): Promise<void> {
    const run = this.view(input), s = this.session;
    if (!s || s.token.runId !== run.runId || !s.rpc) throw new LedgerError('RUN_NOT_ACTIVE');
    if (s.interrupt) return s.interrupt;
    this.store.block(s.token); s.broker?.declineAll();
    s.interrupt = (async () => {
      if (!s.threadId || !s.turnId) { await s.rpc!.close(); return; }
      const params = { threadId: s.threadId, turnId: s.turnId };
      const intent = this.store.prepare(s.token, `interrupt:${s.token.runId}`, 'turn_interrupt', params, s.threadId, s.turnId);
      const rpcId = this.store.sending(s.token, intent.intentId, this.epoch);
      try {
        await s.rpc!.requestWithId(rpcId, 'turn/interrupt', params, this.options.interruptTimeoutMs ?? 5000);
        this.store.accepted(s.token, intent.intentId, { threadId: s.threadId, turnId: s.turnId });
        if (!s.turnEnded) s.stopTimer = setTimeout(() => {
          try { this.store.uncertain(s.token); } catch {}
          void s.rpc!.close();
        }, this.options.interruptTimeoutMs ?? 5000);
      } catch { this.store.uncertain(s.token, intent.intentId); await s.rpc!.close(); }
    })();
    return s.interrupt;
  }
  private async execute(session: Session, text: string): Promise<void> {
    const epoch = ++this.epoch;
    let sequence = 0, failure: unknown, finalTurn: Record<string, unknown> | undefined;
    let resolveTurn!: () => void;
    const completed = new Promise<void>(resolve => { resolveTurn = resolve; });
    let ready!: () => void;
    const turnReady = new Promise<void>(resolve => { ready = resolve; });
    session.broker = new InteractionBroker(this.store, this.options.interactionTimeoutMs);
    let cwd = '';
    const context = (): InteractionContext => ({ token: session.token, connectionEpoch: epoch, projectId: session.projectId,
      threadId: session.threadId!, turnId: session.turnId!, cwd, canWrite: this.options.mode === 'workspaceWrite' });
    let saveTimer: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
    const flush = () => {
      if (!session.projection) return;
      this.store.saveSnapshot(session.token, session.projection.view());
    };
    const callbacks: Pick<RpcOptions, 'onNotification' | 'onServerRequest' | 'onServerResponse'> = {
      onNotification: message => {
        this.diagnostics.notificationCount++;
        if (!session.projection) return;
        session.projection.receive(epoch, ++sequence, message);
        if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = undefined; try { flush(); } catch (error) { failure = error; resolveTurn(); } }, 100);
        if (message.method === 'turn/completed' && isObject(message.params) && message.params.threadId === session.threadId && isObject(message.params.turn)) {
          session.turnEnded = true; clearTimeout(session.stopTimer);
          finalTurn = message.params.turn; resolveTurn();
        }
      },
      onServerRequest: async message => {
        let timer: NodeJS.Timeout | undefined;
        try {
          if (!session.turnId) await Promise.race([turnReady, new Promise<void>(resolve => { timer = setTimeout(resolve,2000); })]);
          if (!session.turnId) throw new RpcFailure('SERVER_REQUEST_SCOPE_MISMATCH');
          return await session.broker!.handle(message, context());
        } catch (error) { this.diagnostics.serverRequestsDenied++; throw error; }
        finally { clearTimeout(timer); }
      },
      onServerResponse: (message, sent) => { if (session.turnId) session.broker!.written(message, sent, context()); },
    };
    const heartbeat = setInterval(() => { try { this.store.heartbeat(session.token); } catch (error) { failure = error; resolveTurn(); void session.rpc?.close(); } }, 10_000);
    try {
      session.rpc = this.options.connect ? this.options.connect(callbacks) : new StdioRpcClient({
        executable: this.options.executable, args: executionArguments(this.options.stateDirectory),
        requestTimeoutMs: 30_000,
        env: { ...runtimeEnvironment(), ...(this.options.codexHome ? { CODEX_HOME: this.options.codexHome } : {}) }, ...callbacks,
        onRemoteError: error => {
          const text = isObject(error) && typeof error.message === 'string' ? error.message : '';
          this.diagnostics.remoteFailureCategory = /experimental|capabilit|opt.?in/i.test(text) ? 'capability_requirement' : /thread.*not.*found|unknown thread/i.test(text) ? 'thread_not_loaded' : /invalid.*param|unknown.*field/i.test(text) ? 'invalid_parameters' : 'unclassified';
        },
      });
      const rpc = session.rpc;
      this.diagnostics.phase = 'initialize';
      await rpc.request('initialize', { clientInfo: { name: 'personal_agent_desktop', version: '0.1.0' }, capabilities: { experimentalApi: false } });
      await rpc.notify('initialized');
      this.diagnostics.phase = 'model/list';
      const catalog = await rpc.request<ModelListResponse>('model/list', {});
      const model = catalog.data?.find(model => model.isDefault && !model.hidden);
      if (!model) throw new RpcFailure('NO_DEFAULT_MODEL');
      this.diagnostics.selectedModel = model.id;
      const workspace = this.store.workspace(session.projectId);
      cwd = workspace.directory;
      this.diagnostics.phase = 'inherited_mcp_inventory';
      const inherited = await rpc.request('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' });
      if (!isObject(inherited) || !Array.isArray(inherited.data) || inherited.nextCursor !== null || inherited.data.length > 100) throw new RpcFailure('MCP_INVENTORY_UNAVAILABLE');
      const disabledMcp: Record<string, false> = {};
      for (const server of inherited.data) {
        if (!isObject(server) || typeof server.name !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(server.name)) throw new RpcFailure('MCP_INVENTORY_UNAVAILABLE');
        disabledMcp[`mcp_servers.${server.name}.enabled`] = false;
      }
      this.diagnostics.disabledInheritedMcpServers = inherited.data.length;
      const threadParams: ThreadStartParams = { cwd: workspace.directory, model: model.id, ephemeral: false, sandbox: this.options.mode === 'workspaceWrite' ? 'workspace-write' : 'read-only', approvalPolicy: 'on-request',
        config: disabledMcp,
        developerInstructions: this.options.mode === 'workspaceWrite' ? 'Work only in the selected workspace. Ask for approval when required. Never claim the host verification has passed.' : 'You are a read-only assistant for this project. Do not modify files or execute external side effects. Never claim the host verification has passed.' };
      this.store.configureManifest(session.token, { developer: hashInput(threadParams.developerInstructions), model: hashInput(model.id) }, hashInput({ mode: this.options.mode ?? 'readOnly', externalConnectors: false, autonomousFeatures: false }));
      const threadIntent = this.store.prepare(session.token, `thread:${session.token.runId}`, 'thread_start', threadParams);
      session.intentId = threadIntent.intentId;
      const threadRpcId = this.store.sending(session.token, threadIntent.intentId, epoch); this.diagnostics.clientThreadStarts++;
      this.diagnostics.phase = 'thread/start';
      const response = await rpc.requestWithId(threadRpcId, 'thread/start', threadParams);
      if (!isObject(response) || !isObject(response.thread) || !identity(response.thread.id) || response.thread.cwd !== workspace.directory) throw new RpcFailure('INVALID_THREAD_RESPONSE', true);
      this.store.accepted(session.token, threadIntent.intentId, { threadId: response.thread.id });
      session.threadId = response.thread.id; session.projection = new ThreadProjection(session.threadId, epoch); sequence = 0;
      this.diagnostics.phase = 'mcpServerStatus/list';
      const inventory = await rpc.request('mcpServerStatus/list', { threadId: session.threadId, limit: 100, detail: 'toolsAndAuthOnly' });
      if (!isObject(inventory) || !Array.isArray(inventory.data) || inventory.nextCursor !== null || inventory.data.some(server =>
        !isObject(server) || server.runtimeStatus !== 'disabled' || !isObject(server.tools) || Object.keys(server.tools).length !== 0)) throw new RpcFailure('EXTERNAL_TOOLS_NOT_DISABLED');
      this.diagnostics.externalMcpServers = 0;
      const turnParams: TurnStartParams = { threadId: session.threadId, input: [{ type: 'text', text, text_elements: [] }],
        approvalPolicy: 'on-request', sandboxPolicy: this.options.mode === 'workspaceWrite' ? { type: 'workspaceWrite', writableRoots: [workspace.directory], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: 'readOnly', networkAccess: false },
        effort: model.supportedReasoningEfforts.some(option => option.reasoningEffort === 'low') ? 'low' : model.defaultReasoningEffort };
      const turnIntent = this.store.prepare(session.token, `turn:${session.token.runId}`, 'turn_start', turnParams, session.threadId);
      session.intentId = turnIntent.intentId;
      const turnRpcId = this.store.sending(session.token, turnIntent.intentId, epoch); this.diagnostics.clientTurnStarts++;
      this.diagnostics.phase = 'turn/start';
      const accepted = await rpc.requestWithId(turnRpcId, 'turn/start', turnParams);
      if (!isObject(accepted) || !isObject(accepted.turn) || !identity(accepted.turn.id)) throw new RpcFailure('INVALID_TURN_RESPONSE', true);
      this.store.accepted(session.token, turnIntent.intentId, { turnId: accepted.turn.id }); session.turnId = accepted.turn.id;
      ready();
      this.diagnostics.phase = 'turn/completed';
      await Promise.race([completed, rpc.waitClosed().then(() => { throw new RpcFailure('PROCESS_EXITED', true); }), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new RpcFailure('TURN_TIMEOUT', true)), this.options.timeoutMs ?? 180_000); })]);
      if (failure) throw failure;
      if (session.interrupt) await session.interrupt;
      if (!finalTurn || finalTurn.id !== session.turnId || !['completed','failed','interrupted'].includes(String(finalTurn.status))) throw new RpcFailure('TURN_RESULT_UNKNOWN', true);
      flush();
      this.store.finish(session.token, finalTurn.status === 'completed' ? 'completed' : finalTurn.status === 'interrupted' ? 'cancelled' : 'failed');
    } catch (error) {
      this.diagnostics.failureCode = error instanceof RpcFailure || error instanceof LedgerError ? error.code : 'HOST_ERROR';
      try {
        if (session.intentId && this.store.intent(session.intentId).state === 'sending') {
          if (error instanceof RpcFailure && ['REMOTE_-32600','REMOTE_-32601','REMOTE_-32602'].includes(error.code)) {
            this.store.rejected(session.token, session.intentId); this.store.finish(session.token, 'failed');
          } else this.store.uncertain(session.token, session.intentId);
        } else if (session.turnId) this.store.uncertain(session.token);
        else this.store.finish(session.token, session.interrupt ? 'cancelled' : 'failed');
        session.projection?.disconnect(); flush();
      } catch { /* A store/owner failure must never trigger transport or duplicate submission. */ }
    } finally {
      ready(); session.broker?.declineAll();
      clearInterval(heartbeat); clearTimeout(saveTimer); clearTimeout(deadline); clearTimeout(session.stopTimer);
      await session.rpc?.close();
    }
  }
  async close(): Promise<void> { this.session?.broker?.declineAll(); await this.session?.rpc?.close(); await this.completion; }
}
