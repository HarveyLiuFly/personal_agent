import { ExecutionLedger, LedgerError, hashInput } from '../../store/src/ledger.ts';
import type { RunToken, RunRecord } from '../../store/src/ledger.ts';
import { StdioRpcClient, RpcFailure, isObject } from '../../codex-adapter/src/rpc.ts';
import type { RpcOptions } from '../../codex-adapter/src/rpc.ts';
import { ThreadProjection } from '../../codex-adapter/src/projection.ts';
import {
  restrictedAppServerArguments,
  runtimeEnvironment,
} from '../../codex-adapter/src/launch.ts';
import type { AppServerRuntime } from '../../codex-adapter/src/app-server.ts';
import type { ThreadStartParams } from '../../codex-adapter/src/generated/v2/ThreadStartParams.ts';
import type { ThreadResumeParams } from '../../codex-adapter/src/generated/v2/ThreadResumeParams.ts';
import type { TurnStartParams } from '../../codex-adapter/src/generated/v2/TurnStartParams.ts';
import type { ModelListResponse } from '../../codex-adapter/src/generated/v2/ModelListResponse.ts';
import type { RunSummary, RunView } from '../../contracts/src/views.ts';
import { InteractionBroker } from './interactions.ts';
import { codeInput } from '../../verification/src/verification.ts';
import type { CodeTaskSpec } from '../../contracts/src/views.ts';
import type { InteractionContext } from './interactions.ts';

const identity = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
function query(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !isObject(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new LedgerError('INVALID_EXECUTION_QUERY');
  return value;
}
function summary(row: RunRecord): RunSummary {
  const { runId, taskId, title, status, taskStatus, threadId, turnId, blocked, mode, errorCode } =
    row;
  return { runId, taskId, title, status, taskStatus, threadId, turnId, blocked, mode, errorCode };
}
export interface ExecutionRoleProfile {
  role: string;
  developerInstructions: string;
  userContext?: string;
  contextRefs: Array<{ ref: string; revision: string }>;
  outputSchema?: TurnStartParams['outputSchema'];
  ephemeral: boolean;
  tools: 'none' | 'readOnly';
  contextHash: string;
}
interface Session {
  checkpointId?: string;
  contextSourceRefs?: string[];
  profile?: ExecutionRoleProfile;
  token: RunToken;
  projectId: string;
  submissionKey: string;
  mode: 'readOnly' | 'workspaceWrite';
  code?: CodeTaskSpec;
  sourceRunId?: string;
  resumeThreadId?: string;
  abort: AbortController;
  rpc?: StdioRpcClient;
  projection?: ThreadProjection;
  threadId?: string;
  turnId?: string;
  intentId?: string;
  broker?: InteractionBroker;
  interrupt?: Promise<void>;
  stopTimer?: NodeJS.Timeout;
  turnEnded?: boolean;
  usagePending?: Array<{ threadId: string; turnId: string; total: unknown }>;
  usageOverflow?: boolean;
  completion?: Promise<void>;
}
export function executionArguments(
  directory: string,
  noTools = false,
  privateRole = false,
): string[] {
  return restrictedAppServerArguments(directory, noTools);
}
export interface ExecutionOptions {
  executable: string;
  stateDirectory: string;
  codexHome?: string;
  timeoutMs?: number;
  runtime?: AppServerRuntime;
  mode?: 'readOnly' | 'workspaceWrite';
  interactionTimeoutMs?: number;
  interruptTimeoutMs?: number;
  prepareCode?: (token: RunToken, code: CodeTaskSpec, signal: AbortSignal) => Promise<void>;
  prepareContinuation?: (
    token: RunToken,
    sourceRunId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Called after a Run session starts or ends, with the number still running. */
  onSessionsChanged?: (running: number) => void;
  /** Trusted tests only; no IPC entry point can supply this factory. */
  connect?: (
    callbacks: Pick<RpcOptions, 'onNotification' | 'onServerRequest' | 'onServerResponse'>,
  ) => StdioRpcClient;
}
/**
 * Execution owner for every running conversation. Several Runs may execute at once; the ledger
 * admits each one (capacity, one active Run per task, one writer per workspace) in a transaction.
 * Queries expose only scoped, bounded display projections.
 */
export class ForegroundExecution {
  private store: ExecutionLedger;
  private options: ExecutionOptions;
  /** Running sessions by runId. */
  private sessions = new Map<string, Session>();
  private epoch = 0;
  readonly diagnostics = {
    clientThreadStarts: 0,
    clientThreadResumes: 0,
    clientTurnStarts: 0,
    notificationCount: 0,
    serverRequestsDenied: 0,
    selectedModel: '',
    externalMcpServers: -1,
    disabledInheritedMcpServers: 0,
    nativePolicyVerified: false,
    nativeApprovalsReviewer: '',
    failureCode: '',
    remoteFailureCategory: '',
    phase: 'idle',
  };
  constructor(store: ExecutionLedger, options: ExecutionOptions) {
    this.store = store;
    this.options = options;
  }
  /** True while any Run executes (used for Host-wide quiescence such as restore and quit). */
  get busy(): boolean {
    return this.sessions.size > 0;
  }
  /** True when no further Run can be admitted until one finishes. */
  get atCapacity(): boolean {
    return this.sessions.size >= this.store.maxActiveRuns();
  }
  /** True while a Run of this project executes. */
  activeIn(projectId: string): boolean {
    for (const session of this.sessions.values()) if (session.projectId === projectId) return true;
    return false;
  }
  private session(runId: string): Session | undefined {
    return this.sessions.get(runId);
  }
  private launch(session: Session, text: string): void {
    this.sessions.set(session.token.runId, session);
    session.completion = this.execute(session, text).finally(() => {
      this.sessions.delete(session.token.runId);
      this.options.onSessionsChanged?.(this.sessions.size);
    });
    this.options.onSessionsChanged?.(this.sessions.size);
  }
  get supportsQueuedCode(): boolean {
    return Boolean(this.options.prepareCode && this.options.prepareContinuation);
  }
  list(input: unknown): RunSummary[] {
    const q = query(input, ['projectId']);
    if (!identity(q.projectId)) throw new LedgerError('INVALID_EXECUTION_QUERY');
    this.store.workspace(q.projectId);
    return this.store.runs(q.projectId, { snapshots: false }).map(summary);
  }
  view(input: unknown): RunView {
    const q = query(input, ['projectId', 'runId']);
    if (!identity(q.projectId) || !identity(q.runId))
      throw new LedgerError('INVALID_EXECUTION_QUERY');
    this.store.workspace(q.projectId);
    const run = this.store.runs(q.projectId, { runId: q.runId })[0];
    if (!run) throw new LedgerError('RUN_NOT_IN_PROJECT');
    return { ...summary(run), snapshot: run.snapshot };
  }
  submit(input: unknown): RunSummary {
    const q = query(
      input,
      isObject(input) && 'code' in input
        ? ['projectId', 'text', 'submissionKey', 'code']
        : ['projectId', 'text', 'submissionKey'],
    );
    const code = q.code === undefined ? undefined : codeInput(q.code);
    if (code && !this.options.prepareCode) throw new LedgerError('CODE_EXECUTION_UNAVAILABLE');
    const mode = code ? 'workspaceWrite' : (this.options.mode ?? 'readOnly');
    if (!identity(q.projectId) || !identity(q.submissionKey) || typeof q.text !== 'string')
      throw new LedgerError('INVALID_EXECUTION_QUERY');
    const { token, created } = this.store.beginRun(
      q.projectId,
      q.text,
      q.submissionKey,
      mode,
      code ? hashInput(code) : undefined,
    );
    if (created) {
      const session: Session = {
        token,
        projectId: q.projectId,
        submissionKey: q.submissionKey,
        mode,
        code,
        abort: new AbortController(),
      };
      this.launch(session, q.text);
    }
    return summary(this.store.runs(q.projectId, { snapshots: false, runId: token.runId })[0]!);
  }
  /** Host-only role execution. No Renderer endpoint accepts profile/instructions/schema. */
  submitRole(
    input: { projectId: string; text: string; submissionKey: string },
    buildProfile: ExecutionRoleProfile | ((token: RunToken) => ExecutionRoleProfile),
    profileKey?: string,
  ): RunSummary {
    const { token, created } = this.store.beginRun(
      input.projectId,
      input.text,
      input.submissionKey,
      'readOnly',
      hashInput(typeof buildProfile === 'function' ? profileKey : buildProfile),
    );
    if (created) {
      try {
        const profile = typeof buildProfile === 'function' ? buildProfile(token) : buildProfile;
        if (
          ![
            'dot-router',
            'dot-chat',
            'research',
            'goal-reviewer',
            'memory-extractor',
            'checkpoint-resume',
          ].includes(profile.role) ||
          !profile.ephemeral ||
          !['none', 'readOnly'].includes(profile.tools) ||
          profile.developerInstructions.length > 32768 ||
          !profile.contextRefs.length ||
          profile.contextRefs.length > 100 ||
          !/^[a-f0-9]{64}$/.test(profile.contextHash)
        )
          throw new LedgerError('INVALID_ROLE_PROFILE');
        this.store.configureRoleManifest(
          token,
          profile.role,
          profile.contextRefs,
          profile.contextHash,
        );
        if (profile.userContext) this.store.bindRoleInput(token, profile.userContext);
        const session: Session = {
          token,
          projectId: input.projectId,
          submissionKey: input.submissionKey,
          mode: 'readOnly',
          profile,
          abort: new AbortController(),
        };
        this.launch(session, profile.userContext ?? input.text);
      } catch (error) {
        this.store.finish(token, 'failed');
        throw error;
      }
    }
    return summary(this.store.runForHost(token.runId));
  }

  rolloverRun(input: unknown): RunSummary {
    const q = query(input, ['projectId', 'runId', 'checkpointId', 'submissionKey']);
    if (!['projectId', 'runId', 'checkpointId', 'submissionKey'].every((k) => identity(q[k])))
      throw new LedgerError('INVALID_ROLLOVER_COMMAND');
    const admitted = this.store.beginRollover({
      projectId: String(q.projectId),
      runId: String(q.runId),
      checkpointId: String(q.checkpointId),
      submissionKey: String(q.submissionKey),
    });
    if (admitted.created) {
      let profile: ExecutionRoleProfile | undefined;
      if (admitted.role !== 'coding') {
        const bundle = this.store.contextForRun(admitted.runId, {
          role: admitted.role === 'dot-chat' ? 'dot-chat' : 'dot-orchestrator',
          mode: 'checkpoint-resume',
          sourceRefs: admitted.sourceRefs,
          checkpointId: admitted.checkpointId,
          maximumInputUnits: 24000,
          framingReserveUnits: 4096,
          capabilities: { model_inference: true, workspace_read: false, workspace_write: false },
        });
        profile = {
          role: admitted.role,
          developerInstructions: bundle.developerInstructions,
          userContext: bundle.userContext,
          contextRefs: bundle.selectedSources,
          contextHash: bundle.manifest.contentHash,
          ephemeral: true,
          tools: 'none',
        };
        this.store.configureRoleManifest(
          admitted.token,
          profile.role,
          profile.contextRefs,
          profile.contextHash,
        );
        this.store.bindRoleInput(admitted.token, bundle.userContext);
      }
      const session: Session = {
        token: admitted.token,
        projectId: String(q.projectId),
        submissionKey: String(q.submissionKey),
        mode: admitted.mode,
        sourceRunId: String(q.runId),
        ...(admitted.code ? { code: admitted.code } : {}),
        checkpointId: admitted.checkpointId,
        contextSourceRefs: admitted.sourceRefs,
        profile,
        abort: new AbortController(),
      };
      this.launch(session, profile?.userContext ?? 'Resume using the Host-validated checkpoint.');
    }
    return summary(this.store.runForHost(admitted.runId));
  }
  /** Resolves when no Run is executing (including Runs started while waiting). */
  async wait(): Promise<void> {
    while (this.sessions.size)
      await Promise.all([...this.sessions.values()].map((session) => session.completion));
  }
  /** Host-only privacy revocation; the old view and dispatch grant are already unavailable. */
  async revokeForPrivacy(
    runIds: string[],
  ): Promise<{ closedRunIds: string[]; unresolvedRunIds: string[] }> {
    const closedRunIds: string[] = [],
      unresolvedRunIds: string[] = [];
    for (const runId of new Set(runIds)) {
      const s = this.session(runId);
      if (s) {
        try {
          this.store.uncertain(s.token);
          s.abort.abort();
          s.broker?.declineAll();
          await s.rpc?.close();
          await s.completion;
          closedRunIds.push(runId);
        } catch {
          unresolvedRunIds.push(runId);
        }
      } else {
        const run = this.store.runForHost(runId);
        // A persisted Unknown from another process is not proof that its executor stopped.
        if (
          ['completed', 'failed', 'cancelled'].includes(run.status) ||
          this.store.executorClosureRecorded(runId)
        )
          closedRunIds.push(runId);
        else unresolvedRunIds.push(runId);
      }
    }
    return { closedRunIds, unresolvedRunIds };
  }
  startTask(input: unknown): RunSummary {
    const q = query(input, ['projectId', 'taskId', 'expectedVersion', 'submissionKey']);
    if (
      !identity(q.projectId) ||
      !identity(q.taskId) ||
      !identity(q.submissionKey) ||
      !Number.isSafeInteger(q.expectedVersion) ||
      Number(q.expectedVersion) < 1
    )
      throw new LedgerError('INVALID_EXECUTION_QUERY');
    const spec = this.store.taskForHost(q.projectId, q.taskId);
    if (
      spec.mode === 'workspaceWrite' &&
      (!this.options.prepareCode || !this.options.prepareContinuation)
    )
      throw new LedgerError('CODE_EXECUTION_UNAVAILABLE');
    const queued = this.store.claimTask(
      q.projectId,
      q.taskId,
      Number(q.expectedVersion),
      q.submissionKey,
    );
    if (queued.created) {
      const session: Session = {
        token: queued.token,
        projectId: q.projectId,
        submissionKey: q.submissionKey,
        mode: spec.mode,
        ...(queued.code ? { code: queued.code } : {}),
        ...(queued.threadId
          ? { resumeThreadId: queued.threadId, sourceRunId: queued.sourceRunId }
          : {}),
        abort: new AbortController(),
      };
      this.launch(session, queued.text);
    }
    return summary(this.store.runForHost(queued.token.runId));
  }
  /** Host-only scheduled admission. No Desktop API forwards trigger IDs to this method. */
  startScheduled(projectId: string, triggerId: string): RunSummary {
    const queued = this.store.claimScheduledTask(projectId, triggerId);
    if (queued.created) {
      const session: Session = {
        token: queued.token,
        projectId,
        submissionKey: queued.submissionKey,
        mode: 'readOnly',
        ...(queued.threadId
          ? { resumeThreadId: queued.threadId, sourceRunId: queued.sourceRunId }
          : {}),
        abort: new AbortController(),
      };
      this.launch(session, queued.text);
    }
    return summary(this.store.runForHost(queued.token.runId));
  }
  continueRun(input: unknown): RunSummary {
    const q = query(input, ['projectId', 'runId', 'text', 'submissionKey']);
    if (
      !identity(q.projectId) ||
      !identity(q.runId) ||
      !identity(q.submissionKey) ||
      typeof q.text !== 'string'
    )
      throw new LedgerError('INVALID_EXECUTION_QUERY');
    const source = this.view({ projectId: q.projectId, runId: q.runId });
    if (source.mode === 'workspaceWrite' && !this.options.prepareContinuation)
      throw new LedgerError('CODE_EXECUTION_UNAVAILABLE');
    const { token, created, threadId, mode } = this.store.beginContinuation(
      q.projectId,
      q.runId,
      q.text,
      q.submissionKey,
    );
    if (created) {
      const plan = this.store.verificationPlan(q.runId),
        code = plan
          ? { profile: 'node-test' as const, target: plan.target, allowedPaths: plan.allowedPaths }
          : undefined;
      const session: Session = {
        token,
        projectId: q.projectId,
        submissionKey: q.submissionKey,
        mode,
        code,
        sourceRunId: q.runId,
        resumeThreadId: threadId,
        abort: new AbortController(),
      };
      this.launch(session, q.text);
    }
    return summary(this.store.runForHost(token.runId));
  }
  interactions(input: unknown) {
    const run = this.view(input),
      q = input as Record<string, string>;
    return this.store.requests(q.projectId!, run.runId);
  }
  reply(input: unknown): void {
    if (
      !isObject(input) ||
      Object.keys(input).some(
        (key) => !['projectId', 'runId', 'requestId', 'decision', 'answers'].includes(key),
      ) ||
      !identity(input.requestId)
    )
      throw new LedgerError('INVALID_INTERACTION_REPLY');
    const run = this.view({ projectId: input.projectId, runId: input.runId }),
      session = this.session(run.runId);
    if (!session?.broker) throw new LedgerError('STALE_SERVER_REQUEST');
    session.broker.reply(input.requestId, input);
  }
  async interrupt(input: unknown): Promise<void> {
    const run = this.view(input),
      s = this.session(run.runId);
    if (!s) throw new LedgerError('RUN_NOT_ACTIVE');
    if (s.turnEnded) return;
    if (s.interrupt) return s.interrupt;
    this.store.block(s.token);
    s.broker?.declineAll();
    if (!s.rpc) {
      s.abort.abort();
      s.interrupt = Promise.resolve();
      return;
    }
    s.interrupt = (async () => {
      if (!s.threadId || !s.turnId) {
        await s.rpc!.close();
        return;
      }
      const params = { threadId: s.threadId, turnId: s.turnId };
      const intent = this.store.prepare(
        s.token,
        `interrupt:${s.token.runId}`,
        'turn_interrupt',
        params,
        s.threadId,
        s.turnId,
      );
      const rpcId = this.store.sending(s.token, intent.intentId, this.epoch);
      try {
        await s.rpc!.requestWithId(
          rpcId,
          'turn/interrupt',
          params,
          this.options.interruptTimeoutMs ?? 5000,
        );
        this.store.accepted(s.token, intent.intentId, { threadId: s.threadId, turnId: s.turnId });
        if (!s.turnEnded)
          s.stopTimer = setTimeout(() => {
            try {
              this.store.uncertain(s.token);
            } catch {}
            void s.rpc!.close();
          }, this.options.interruptTimeoutMs ?? 5000);
      } catch {
        this.store.uncertain(s.token, intent.intentId);
        await s.rpc!.close();
      }
    })();
    return s.interrupt;
  }
  private async execute(session: Session, text: string): Promise<void> {
    const epoch = ++this.epoch;
    this.diagnostics.failureCode = '';
    this.diagnostics.remoteFailureCategory = '';
    this.diagnostics.nativePolicyVerified = false;
    this.diagnostics.nativeApprovalsReviewer = '';
    const mode = session.mode;
    let knownOutcome: 'completed' | 'failed' | 'cancelled' | undefined;
    let sequence = 0,
      failure: unknown,
      finalTurn: Record<string, unknown> | undefined;
    let resolveTurn!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    let ready!: () => void;
    const turnReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const observeUsage = (data: { threadId: string; turnId: string; total: unknown }) => {
      if (data.threadId !== session.threadId || data.turnId !== session.turnId) return;
      try {
        this.store.recordTokenUsage(session.token, data.threadId, data.turnId, data.total);
      } catch (error) {
        failure = error;
        resolveTurn();
        void session.rpc?.close();
      }
    };
    session.broker = new InteractionBroker(this.store, this.options.interactionTimeoutMs);
    let cwd = '';
    const context = (): InteractionContext => ({
      token: session.token,
      connectionEpoch: epoch,
      projectId: session.projectId,
      threadId: session.threadId!,
      turnId: session.turnId!,
      cwd,
      canWrite: mode === 'workspaceWrite',
    });
    let saveTimer: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
    const flush = () => {
      if (!session.projection) return;
      this.store.saveSnapshot(session.token, session.projection.view());
    };
    const callbacks: Pick<RpcOptions, 'onNotification' | 'onServerRequest' | 'onServerResponse'> = {
      onNotification: (message) => {
        this.diagnostics.notificationCount++;
        if (
          message.method === 'thread/tokenUsage/updated' &&
          isObject(message.params) &&
          typeof message.params.threadId === 'string' &&
          typeof message.params.turnId === 'string'
        ) {
          const p = message.params,
            data = {
              threadId: p.threadId as string,
              turnId: p.turnId as string,
              total:
                isObject(p.tokenUsage) && isObject(p.tokenUsage.total)
                  ? p.tokenUsage.total.totalTokens
                  : undefined,
            };
          if (session.turnId) observeUsage(data);
          else {
            session.usagePending ??= [];
            if (session.usagePending.length >= 16) {
              session.usagePending.shift();
              session.usageOverflow = true;
            }
            session.usagePending.push(data);
          }
          return;
        }
        if (!session.projection) return;
        session.projection.receive(epoch, ++sequence, message);
        if (!saveTimer)
          saveTimer = setTimeout(() => {
            saveTimer = undefined;
            try {
              flush();
            } catch (error) {
              failure = error;
              resolveTurn();
            }
          }, 100);
        if (
          message.method === 'turn/completed' &&
          isObject(message.params) &&
          message.params.threadId === session.threadId &&
          isObject(message.params.turn)
        ) {
          session.turnEnded = true;
          clearTimeout(session.stopTimer);
          finalTurn = message.params.turn;
          resolveTurn();
        }
      },
      onServerRequest: async (message) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          if (!session.turnId)
            await Promise.race([
              turnReady,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 2000);
              }),
            ]);
          if (!session.turnId) throw new RpcFailure('SERVER_REQUEST_SCOPE_MISMATCH');
          return await session.broker!.handle(message, context());
        } catch (error) {
          this.diagnostics.serverRequestsDenied++;
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
      onServerResponse: (message, sent) => {
        if (session.turnId) session.broker!.written(message, sent, context());
      },
    };
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat(session.token);
      } catch (error) {
        failure = error;
        resolveTurn();
        void session.rpc?.close();
      }
    }, 10_000);
    try {
      if (session.code) {
        this.diagnostics.phase = 'verification_contract';
        if (session.sourceRunId)
          await this.options.prepareContinuation!(
            session.token,
            session.sourceRunId,
            session.abort.signal,
          );
        else await this.options.prepareCode!(session.token, session.code, session.abort.signal);
      }
      const bundle = session.profile
        ? undefined
        : this.store.contextForRun(session.token.runId, {
            role: 'coding',
            mode: mode === 'workspaceWrite' ? 'execution' : 'read-only',
            sourceRefs:
              session.contextSourceRefs ?? this.store.taskContextRefs(session.token.runId),
            ...(session.checkpointId ? { checkpointId: session.checkpointId } : {}),
            maximumInputUnits: 24000,
            framingReserveUnits: 4096,
            capabilities: {
              model_inference: true,
              workspace_read: true,
              workspace_write: mode === 'workspaceWrite',
            },
          });
      if (bundle) {
        text = bundle.userContext;
        this.store.bindRoleInput(session.token, text);
      }
      if (session.abort.signal.aborted) throw new LedgerError('RUN_CANCELLED_BEFORE_SEND');
      const runtimeFence = this.options.runtime
        ? await this.options.runtime.prepare(session.abort.signal)
        : undefined;
      if (session.abort.signal.aborted) throw new LedgerError('RUN_CANCELLED_BEFORE_SEND');
      const rpcOptions: RpcOptions = {
        executable: this.options.executable,
        args: executionArguments(
          this.options.stateDirectory,
          session.profile?.tools === 'none',
          Boolean(session.profile),
        ),
        requestTimeoutMs: 30_000,
        env: {
          ...runtimeEnvironment(),
          ...(this.options.codexHome ? { CODEX_HOME: this.options.codexHome } : {}),
        },
        ...callbacks,
        onRemoteError: (error) => {
          const text = isObject(error) && typeof error.message === 'string' ? error.message : '';
          this.diagnostics.remoteFailureCategory = /experimental|capabilit|opt.?in/i.test(text)
            ? 'capability_requirement'
            : /thread.*not.*found|unknown thread/i.test(text)
              ? 'thread_not_loaded'
              : /invalid.*param|unknown.*field/i.test(text)
                ? 'invalid_parameters'
                : 'unclassified';
        },
      };
      session.rpc = this.options.connect
        ? this.options.connect(callbacks)
        : this.options.runtime
          ? this.options.runtime.openDedicated(rpcOptions, runtimeFence!)
          : new StdioRpcClient(rpcOptions);
      const rpc = session.rpc;
      this.diagnostics.phase = 'initialize';
      await rpc.request('initialize', {
        clientInfo: { name: 'personal_agent_desktop', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      });
      await rpc.notify('initialized');
      this.diagnostics.phase = 'model/list';
      const catalog = await rpc.request<ModelListResponse>('model/list', {});
      const model = catalog.data?.find((model) => model.isDefault && !model.hidden);
      if (!model) throw new RpcFailure('NO_DEFAULT_MODEL');
      this.diagnostics.selectedModel = model.id;
      if (session.profile) {
        const effective = await rpc.request('config/read', { includeLayers: false });
        if (
          !isObject(effective) ||
          !isObject(effective.config) ||
          !isObject(effective.config.features) ||
          effective.config.features.memories !== false
        )
          throw new RpcFailure('ROLE_MEMORY_ISOLATION_UNVERIFIED');
        if (
          session.profile.tools === 'none' &&
          ([
            'shell_tool',
            'unified_exec',
            'view_image',
            'image_generation',
            'sleep_tool',
            'skill_search',
            'tool_suggest',
          ].some(
            (key) =>
              (effective.config as Record<string, unknown>).features &&
              ((effective.config as Record<string, unknown>).features as Record<string, unknown>)[
                key
              ] !== false,
          ) ||
            effective.config.web_search !== 'disabled')
        )
          throw new RpcFailure('ROLE_TOOLS_NOT_DISABLED');
      }
      const workspace = this.store.workspace(session.projectId);
      cwd = workspace.directory;
      this.diagnostics.phase = 'inherited_mcp_inventory';
      const inherited = await rpc.request('mcpServerStatus/list', {
        limit: 100,
        detail: 'toolsAndAuthOnly',
      });
      if (
        !isObject(inherited) ||
        !Array.isArray(inherited.data) ||
        inherited.nextCursor !== null ||
        inherited.data.length > 100
      )
        throw new RpcFailure('MCP_INVENTORY_UNAVAILABLE');
      const disabledMcp: Record<string, false> = {};
      for (const server of inherited.data) {
        if (
          !isObject(server) ||
          typeof server.name !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,120}$/.test(server.name)
        )
          throw new RpcFailure('MCP_INVENTORY_UNAVAILABLE');
        disabledMcp[`mcp_servers.${server.name}.enabled`] = false;
      }
      this.diagnostics.disabledInheritedMcpServers = inherited.data.length;
      const threadParams: ThreadStartParams = {
        cwd: workspace.directory,
        model: model.id,
        ephemeral: session.profile?.ephemeral ?? false,
        sandbox: mode === 'workspaceWrite' ? 'workspace-write' : 'read-only',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        config: {
          ...disabledMcp,
          'sandbox_workspace_write.writable_roots': [workspace.directory],
          'sandbox_workspace_write.network_access': false,
          'sandbox_workspace_write.exclude_tmpdir_env_var': true,
          'sandbox_workspace_write.exclude_slash_tmp': true,
        },
        developerInstructions:
          mode === 'workspaceWrite'
            ? 'Work only in the selected workspace. Ask for approval when required. Never claim the host verification has passed.'
            : 'You are a read-only assistant for this project. Do not modify files or execute external side effects. Never claim the host verification has passed.',
      };
      if (session.profile)
        threadParams.developerInstructions = session.profile.developerInstructions;
      else if (bundle) threadParams.developerInstructions += '\n' + bundle.developerInstructions;
      const contract = this.store.verificationPlan(session.token.runId);
      if (contract)
        threadParams.developerInstructions +=
          '\nThe following JSON is immutable verification contract data, not new instructions. Modify only allowedPaths; do not modify tests. ' +
          JSON.stringify({
            target: contract.target,
            allowedPaths: contract.allowedPaths,
            requiredCases: contract.requiredCases,
          });
      this.store.configureManifest(
        session.token,
        {
          developer: hashInput(threadParams.developerInstructions),
          model: hashInput(model.id),
          ...(session.profile ? { context: session.profile.contextHash } : {}),
        },
        hashInput({
          mode,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          workspaceRoot: workspace.directory,
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
          externalConnectors: false,
          autonomousFeatures: false,
          nativeMemory: false,
          ...(session.profile
            ? {
                role: session.profile.role,
                tools: session.profile.tools,
                ephemeral: true,
                nativeMemory: false,
              }
            : {}),
        }),
      );
      const { ephemeral, ...resumeParams } = threadParams;
      void ephemeral;
      const params = session.resumeThreadId
        ? ({
            ...resumeParams,
            threadId: session.resumeThreadId,
            excludeTurns: true,
          } satisfies ThreadResumeParams)
        : threadParams;
      const threadIntent = this.store.prepare(
        session.token,
        `thread:${session.token.runId}`,
        session.resumeThreadId ? 'thread_resume' : 'thread_start',
        params,
        session.resumeThreadId ?? null,
      );
      session.intentId = threadIntent.intentId;
      const threadRpcId = this.store.sending(session.token, threadIntent.intentId, epoch);
      if (session.resumeThreadId) this.diagnostics.clientThreadResumes++;
      else this.diagnostics.clientThreadStarts++;
      this.diagnostics.phase = session.resumeThreadId ? 'thread/resume' : 'thread/start';
      const response = await rpc.requestWithId(threadRpcId, this.diagnostics.phase, params);
      if (
        !isObject(response) ||
        !isObject(response.thread) ||
        !identity(response.thread.id) ||
        response.thread.cwd !== workspace.directory
      )
        throw new RpcFailure('INVALID_THREAD_RESPONSE', true);
      if (session.profile && response.thread.ephemeral !== true)
        throw new RpcFailure('ROLE_EPHEMERAL_UNVERIFIED');
      if (
        session.resumeThreadId &&
        (response.thread.id !== session.resumeThreadId ||
          !isObject(response.thread.status) ||
          !['idle', 'notLoaded'].includes(String(response.thread.status.type)))
      )
        throw new RpcFailure('RESUMED_THREAD_NOT_IDLE', true);
      this.store.accepted(session.token, threadIntent.intentId, { threadId: response.thread.id });
      session.threadId = response.thread.id;
      session.projection = new ThreadProjection(session.threadId, epoch);
      sequence = 0;
      this.diagnostics.phase = 'native_policy';
      this.diagnostics.nativeApprovalsReviewer =
        typeof response.approvalsReviewer === 'string' ? response.approvalsReviewer : 'unknown';
      const sandbox = response.sandbox;
      if (
        response.approvalPolicy !== 'on-request' ||
        response.approvalsReviewer !== 'user' ||
        !isObject(sandbox) ||
        sandbox.networkAccess !== false ||
        (mode === 'readOnly'
          ? sandbox.type !== 'readOnly'
          : sandbox.type !== 'workspaceWrite' ||
            sandbox.excludeTmpdirEnvVar !== true ||
            sandbox.excludeSlashTmp !== true ||
            !Array.isArray(sandbox.writableRoots) ||
            sandbox.writableRoots.some((path) => path !== workspace.directory))
      )
        throw new RpcFailure('NATIVE_POLICY_NOT_ENFORCED');
      this.diagnostics.nativePolicyVerified = true;
      this.store.confirmNativePolicy(
        session.token,
        hashInput({
          approvalPolicy: response.approvalPolicy,
          approvalsReviewer: response.approvalsReviewer,
          sandbox,
        }),
      );
      this.diagnostics.phase = 'mcpServerStatus/list';
      const inventory = await rpc.request('mcpServerStatus/list', {
        threadId: session.threadId,
        limit: 100,
        detail: 'toolsAndAuthOnly',
      });
      if (
        !isObject(inventory) ||
        !Array.isArray(inventory.data) ||
        inventory.nextCursor !== null ||
        inventory.data.some(
          (server) =>
            !isObject(server) ||
            server.runtimeStatus !== 'disabled' ||
            !isObject(server.tools) ||
            Object.keys(server.tools).length !== 0,
        )
      )
        throw new RpcFailure('EXTERNAL_TOOLS_NOT_DISABLED');
      this.diagnostics.externalMcpServers = 0;
      const turnParams: TurnStartParams = {
        threadId: session.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy:
          mode === 'workspaceWrite'
            ? {
                type: 'workspaceWrite',
                writableRoots: [workspace.directory],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              }
            : { type: 'readOnly', networkAccess: false },
        ...(session.profile?.outputSchema ? { outputSchema: session.profile.outputSchema } : {}),
        effort: model.supportedReasoningEfforts.some((option) => option.reasoningEffort === 'low')
          ? 'low'
          : model.defaultReasoningEffort,
      };
      const turnIntent = this.store.prepare(
        session.token,
        `turn:${session.token.runId}`,
        'turn_start',
        turnParams,
        session.threadId,
      );
      session.intentId = turnIntent.intentId;
      const turnRpcId = this.store.sending(session.token, turnIntent.intentId, epoch);
      this.diagnostics.clientTurnStarts++;
      this.diagnostics.phase = 'turn/start';
      const accepted = await rpc.requestWithId(turnRpcId, 'turn/start', turnParams);
      if (!isObject(accepted) || !isObject(accepted.turn) || !identity(accepted.turn.id))
        throw new RpcFailure('INVALID_TURN_RESPONSE', true);
      this.store.accepted(session.token, turnIntent.intentId, { turnId: accepted.turn.id });
      session.turnId = accepted.turn.id;
      if (session.usageOverflow)
        observeUsage({ threadId: session.threadId, turnId: session.turnId, total: undefined });
      for (const pending of session.usagePending ?? []) observeUsage(pending);
      session.usagePending = [];
      ready();
      this.diagnostics.phase = 'turn/completed';
      await Promise.race([
        completed,
        rpc.waitClosed().then(() => {
          throw new RpcFailure('PROCESS_EXITED', true);
        }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new RpcFailure('TURN_TIMEOUT', true)),
            this.options.timeoutMs ?? 180_000,
          );
        }),
      ]);
      if (failure) throw failure;
      if (session.interrupt) await session.interrupt;
      if (
        !finalTurn ||
        finalTurn.id !== session.turnId ||
        !['completed', 'failed', 'interrupted'].includes(String(finalTurn.status))
      )
        throw new RpcFailure('TURN_RESULT_UNKNOWN', true);
      flush();
      knownOutcome =
        finalTurn.status === 'completed'
          ? 'completed'
          : finalTurn.status === 'interrupted'
            ? 'cancelled'
            : 'failed';
    } catch (error) {
      this.diagnostics.failureCode =
        error instanceof RpcFailure || error instanceof LedgerError ? error.code : 'HOST_ERROR';
      try {
        this.store.diagnostic(session.token, this.diagnostics.failureCode);
        if (session.intentId && this.store.intent(session.intentId).state === 'sending') {
          if (
            error instanceof RpcFailure &&
            ['REMOTE_-32600', 'REMOTE_-32601', 'REMOTE_-32602'].includes(error.code)
          ) {
            this.store.rejected(session.token, session.intentId);
            knownOutcome = 'failed';
          } else this.store.uncertain(session.token, session.intentId);
        } else if (session.turnId) this.store.uncertain(session.token);
        else knownOutcome = session.interrupt ? 'cancelled' : 'failed';
        session.projection?.disconnect();
        flush();
      } catch {
        /* A store/owner failure must never trigger transport or duplicate submission. */
      }
    } finally {
      ready();
      session.broker?.declineAll();
      clearInterval(heartbeat);
      clearTimeout(saveTimer);
      clearTimeout(deadline);
      clearTimeout(session.stopTimer);
      try {
        await session.rpc?.close();
        if (session.rpc) this.store.executorClosed(session.token, epoch);
        if (knownOutcome && this.store.runForHost(session.token.runId).status !== 'outcome_unknown')
          this.store.finish(session.token, knownOutcome);
      } catch {
        try {
          this.store.uncertain(session.token);
        } catch {}
      }
    }
  }
  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      session.abort.abort();
      session.broker?.declineAll();
    }
    await Promise.all(sessions.map((session) => session.rpc?.close()));
    await this.wait();
  }
}
