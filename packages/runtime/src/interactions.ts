import { ExecutionLedger, LedgerError } from '../../store/src/ledger.ts';
import type { RunToken } from '../../store/src/ledger.ts';
import { isObject, RpcFailure } from '../../codex-adapter/src/rpc.ts';
import type { InputQuestion, InteractionView } from '../../contracts/src/views.ts';
import { resolve, sep } from 'node:path';
export interface InteractionContext {
  token: RunToken;
  connectionEpoch: number;
  projectId: string;
  threadId: string;
  turnId: string;
  cwd: string;
  canWrite: boolean;
  /** Paths of a file-change item as Codex reported them (null when the item is unknown). */
  preview?: (itemId: string) => string[] | null;
}
interface Pending {
  requestId: string;
  context: InteractionContext;
  payload: Omit<InteractionView, 'state' | 'requestId'>;
  resolve(value: unknown): void;
  timer: NodeJS.Timeout;
}
const validId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
const text = (v: unknown, limit: number): string =>
  typeof v === 'string' ? v.slice(0, limit) : '';
/** One live connection only. Persisted rows are audit data and never recreate approval promises. */
export class InteractionBroker {
  private store: ExecutionLedger;
  private pending = new Map<string, Pending>();
  private rpcIds = new Map<string, string>();
  private timeoutMs: number;
  constructor(store: ExecutionLedger, timeoutMs = 120_000) {
    this.store = store;
    this.timeoutMs = timeoutMs;
  }
  async handle(message: Record<string, unknown>, context: InteractionContext): Promise<unknown> {
    const p = message.params;
    if (
      !isObject(p) ||
      p.threadId !== context.threadId ||
      p.turnId !== context.turnId ||
      !validId(p.itemId) ||
      (typeof message.id !== 'string' && typeof message.id !== 'number')
    )
      throw new RpcFailure('SERVER_REQUEST_SCOPE_MISMATCH');
    // Inside the conversation's workspace (a relative path is resolved against it).
    const inside = (path: string) => {
      const full = resolve(context.cwd, path);
      return full === context.cwd || full.startsWith(context.cwd + sep);
    };
    let payload: Omit<InteractionView, 'state' | 'requestId'>;
    if (message.method === 'item/commandExecution/requestApproval') {
      const command = text(p.command, 4096),
        cwd = text(p.cwd, 4096);
      const canAccept =
        context.canWrite &&
        (p.kind === undefined || p.kind === 'command') &&
        Boolean(cwd) &&
        inside(cwd) &&
        typeof p.command === 'string' &&
        Boolean(p.command.trim()) &&
        p.command.length <= 4096 &&
        !/[\x00-\x08\x0b-\x1f]/.test(p.command);
      payload = {
        kind: 'command',
        title: '运行命令（需要越出沙箱）',
        detail: `${command}\n目录：${cwd}\n${text(p.reason, 2000)}`.trim(),
        command,
        canAccept,
        canAcceptForSession: canAccept,
        questions: [],
      };
      // "Always allow in this conversation": the same command was allowed for this conversation.
      if (canAccept && this.store.conversationAllows(context.token.runId, command))
        payload = { ...payload, title: '运行命令（本对话已允许）', autoApproved: true };
    } else if (message.method === 'item/fileChange/requestApproval') {
      const files = (context.preview?.(p.itemId as string) ?? []).slice(0, 50),
        root = text(p.grantRoot, 4096);
      const canAccept =
        context.canWrite && files.length > 0 && files.every(inside) && (!root || inside(root));
      payload = {
        kind: 'files',
        title: '修改文件',
        detail: [
          files.length ? files.join('\n') : '没有可核对的文件清单，只能拒绝。',
          root ? `申请写入目录：${root}` : '',
          text(p.reason, 2000),
        ]
          .filter(Boolean)
          .join('\n'),
        files,
        canAccept,
        canAcceptForSession: canAccept && !root,
        questions: [],
      };
    } else if (message.method === 'item/tool/requestUserInput') {
      if (!Array.isArray(p.questions) || p.questions.length < 1 || p.questions.length > 8)
        throw new RpcFailure('INVALID_INPUT_QUESTIONS');
      const seen = new Set<string>();
      const questions: InputQuestion[] = p.questions.map((q) => {
        if (
          !isObject(q) ||
          !validId(q.id) ||
          seen.has(q.id) ||
          typeof q.question !== 'string' ||
          q.question.length > 2000 ||
          q.isSecret === true
        )
          throw new RpcFailure('INVALID_INPUT_QUESTIONS');
        seen.add(q.id);
        if (
          q.options !== null &&
          q.options !== undefined &&
          (!Array.isArray(q.options) ||
            q.options.length > 10 ||
            q.options.some(
              (option) =>
                !isObject(option) || typeof option.label !== 'string' || option.label.length > 200,
            ))
        )
          throw new RpcFailure('INVALID_INPUT_OPTIONS');
        return {
          id: q.id,
          header: text(q.header, 200),
          question: q.question,
          options: Array.isArray(q.options)
            ? q.options.map((option) => text(option.label, 200))
            : [],
        };
      });
      payload = { kind: 'input', title: '需要补充信息', detail: '', canAccept: true, questions };
    } else throw new RpcFailure('UNSUPPORTED_SERVER_REQUEST');
    if (this.pending.size >= 16) throw new RpcFailure('SERVER_REQUEST_LIMIT');
    const rpcId = JSON.stringify(message.id),
      expires = Date.now() + this.timeoutMs;
    const requestId = this.store.addRequest(
      context.token,
      context.connectionEpoch,
      rpcId,
      context.threadId,
      context.turnId,
      payload,
      expires,
    );
    this.rpcIds.set(rpcId, requestId);
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.resolve(requestId, { decision: 'decline' }, true);
        } catch {
          this.pending
            .get(requestId)
            ?.resolve(payload.kind === 'input' ? { answers: {} } : { decision: 'decline' });
          this.pending.delete(requestId);
        }
      }, this.timeoutMs);
      this.pending.set(requestId, { requestId, context, payload, resolve, timer });
    });
    if (payload.autoApproved) this.resolve(requestId, { decision: 'acceptForSession' }, false);
    return promise;
  }
  reply(requestId: string, input: Record<string, unknown>): void {
    this.resolve(requestId, input, false);
  }
  private resolve(
    requestId: string,
    input: Record<string, unknown>,
    expired: boolean | 'cancelled',
  ): void {
    const request = this.pending.get(requestId);
    if (!request) throw new LedgerError('STALE_SERVER_REQUEST');
    const decision = String(input.decision);
    if (
      !['accept', 'acceptForSession', 'decline'].includes(decision) ||
      (decision === 'acceptForSession' && request.payload.kind === 'input')
    )
      throw new LedgerError('INVALID_APPROVAL_DECISION');
    if (
      (decision === 'accept' && !request.payload.canAccept) ||
      (decision === 'acceptForSession' && !request.payload.canAcceptForSession)
    )
      throw new LedgerError('APPROVAL_SCOPE_BLOCKED');
    const run = this.store.runs(request.context.projectId, {
      snapshots: false,
      runId: request.context.token.runId,
    })[0];
    if (!run || (run.blocked && decision !== 'decline'))
      throw new LedgerError('RUN_DISPATCH_BLOCKED');
    let response: unknown;
    if (request.payload.kind === 'input') {
      const answers: Record<string, { answers: string[] }> = Object.create(null) as Record<
        string,
        { answers: string[] }
      >;
      if (input.decision === 'accept') {
        if (
          !isObject(input.answers) ||
          Object.keys(input.answers).length !== request.payload.questions.length
        )
          throw new LedgerError('INVALID_INPUT_ANSWERS');
        for (const q of request.payload.questions) {
          const answer = input.answers[q.id];
          if (typeof answer !== 'string' || !answer.trim() || answer.length > 2000)
            throw new LedgerError('INVALID_INPUT_ANSWERS');
          answers[q.id] = { answers: [answer] };
        }
      }
      response = { answers };
    } else response = { decision };
    this.store.responding(
      request.context.token,
      requestId,
      request.context.connectionEpoch,
      response,
      expired,
    );
    clearTimeout(request.timer);
    this.pending.delete(requestId);
    request.resolve(response);
  }
  written(message: Record<string, unknown>, sent: boolean, context: InteractionContext): void {
    const key = JSON.stringify(message.id),
      requestId = this.rpcIds.get(key);
    if (!requestId) return;
    this.rpcIds.delete(key);
    this.store.responseWritten(context.token, requestId, sent);
  }
  declineAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      try {
        this.resolve(requestId, { decision: 'decline' }, 'cancelled');
      } catch {
        const p = this.pending.get(requestId);
        if (!p) continue;
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        p.resolve(p.payload.kind === 'input' ? { answers: {} } : { decision: 'decline' });
      }
    }
  }
}
