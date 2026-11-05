import { ExecutionLedger, LedgerError, hashInput } from '../../store/src/ledger.ts';
import type { ReconciliationClaim } from '../../store/src/ledger.ts';
import { isObject } from '../../codex-adapter/src/rpc.ts';
import { ThreadProjection } from '../../codex-adapter/src/projection.ts';
import type { WithReadPort, ReadPort } from '../../codex-adapter/src/history.ts';
import { processGone } from './process-liveness.ts';
const fail = (code: string): never => {
  throw new LedgerError(code);
};
const identity = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\x00-\x1f]/.test(value);
function page(value: unknown): { data: Record<string, unknown>[]; nextCursor: string | null } {
  if (
    !isObject(value) ||
    !Array.isArray(value.data) ||
    value.data.length > 100 ||
    !value.data.every(isObject) ||
    (value.nextCursor !== null && !identity(value.nextCursor))
  )
    return fail('INVALID_HISTORY_RESPONSE');
  return { data: value.data, nextCursor: value.nextCursor as string | null };
}
/** Explicit read-only reconciliation. It never starts/resumes a thread or sends a model turn. */
export class HistoryReconciliation {
  private store: ExecutionLedger;
  private withPort: WithReadPort;
  private busy = false;
  constructor(store: ExecutionLedger, withPort: WithReadPort) {
    this.store = store;
    this.withPort = withPort;
  }
  async reconcile(input: unknown): Promise<void> {
    if (
      !isObject(input) ||
      Object.keys(input).length !== 2 ||
      !identity(input.projectId) ||
      !identity(input.runId)
    )
      return fail('INVALID_EXECUTION_QUERY');
    const run = this.store.runForHost(input.runId);
    if (run.workspaceId !== input.projectId) return fail('RUN_NOT_IN_PROJECT');
    if (this.store.reconcileUnsentGoalPreparation(input.projectId, input.runId)) return;
    if (this.busy) return fail('RECONCILIATION_BUSY');
    const claim = this.store.reconciliationClaim(input.runId),
      cwd = this.store.workspace(input.projectId).directory;
    this.busy = true;
    try {
      const result = await this.withPort(async (port) => {
        const metadata = await this.metadata(port, claim, cwd);
        const turns = page(
          await port.request('thread/turns/list', {
            threadId: claim.threadId,
            limit: 100,
            itemsView: 'summary',
            sortDirection: 'asc',
          }),
        );
        if (
          turns.nextCursor !== null ||
          turns.data.length > 64 ||
          new Set(turns.data.map((t) => t.id)).size !== turns.data.length
        )
          return fail('HISTORY_RECONCILIATION_LIMIT');
        const matches: Array<{
          turnId: string;
          status: 'completed' | 'failed' | 'interrupted';
          items: Record<string, unknown>[];
          userHash: string;
        }> = [];
        for (const turn of turns.data) {
          if (
            !identity(turn.id) ||
            !['completed', 'failed', 'interrupted'].includes(String(turn.status))
          )
            return fail('HISTORY_NOT_TERMINAL');
          if (claim.priorTurnIds.includes(turn.id) || (claim.turnId && claim.turnId !== turn.id))
            continue;
          const items: Record<string, unknown>[] = [],
            seen = new Set<string>();
          let cursor: string | null = null;
          do {
            const next = page(
              await port.request('thread/items/list', {
                threadId: claim.threadId,
                turnId: turn.id,
                limit: 100,
                sortDirection: 'asc',
                ...(cursor ? { cursor } : {}),
              }),
            );
            for (const entry of next.data) {
              const item = entry.item;
              if (
                entry.turnId !== turn.id ||
                !isObject(item) ||
                !identity(item.id) ||
                items.some((i) => i.id === item.id)
              )
                return fail('HISTORY_SCOPE_MISMATCH');
              items.push(item);
            }
            if (items.length > 512) return fail('HISTORY_RECONCILIATION_LIMIT');
            cursor = next.nextCursor;
            if (cursor) {
              if (seen.has(cursor)) return fail('HISTORY_CURSOR_LOOP');
              seen.add(cursor);
            }
          } while (cursor);
          const users = items.filter((i) => i.type === 'userMessage');
          if (
            users.length !== 1 ||
            !Array.isArray(users[0]!.content) ||
            users[0]!.content.length !== 1
          )
            continue;
          // Turns sent since CORE.2f carry the Run ID as their client message ID: a different ID is
          // someone else's message even with the same words.
          const clientId = users[0]!.clientId;
          if (typeof clientId === 'string' && clientId !== claim.runId) continue;
          const content = users[0]!.content[0];
          if (
            !isObject(content) ||
            content.type !== 'text' ||
            typeof content.text !== 'string' ||
            content.text.length > 32768
          )
            continue;
          const userHash = hashInput(content.text);
          if (userHash !== claim.userHash) continue;
          matches.push({
            turnId: turn.id,
            status: turn.status as 'completed' | 'failed' | 'interrupted',
            items,
            userHash,
          });
        }
        if (matches.length !== 1)
          return fail(matches.length ? 'HISTORY_MATCH_AMBIGUOUS' : 'HISTORY_MATCH_NOT_FOUND');
        const after = await this.metadata(port, claim, cwd);
        if (metadata.updatedAt !== after.updatedAt)
          return fail('HISTORY_CHANGED_DURING_RECONCILIATION');
        const match = matches[0]!,
          projection = new ThreadProjection(claim.threadId, claim.connectionEpoch + 1);
        projection.replaceSnapshot(claim.connectionEpoch + 1, 0, [
          { id: match.turnId, status: match.status, items: match.items },
        ]);
        return {
          turnId: match.turnId,
          status: match.status,
          userHash: match.userHash,
          snapshot: projection.view(),
          evidenceHash: hashInput({
            threadId: claim.threadId,
            cwd,
            updatedAt: after.updatedAt,
            turn: match,
          }),
        };
      });
      this.store.reconcile(claim, result);
    } finally {
      this.busy = false;
    }
  }
  private async metadata(
    port: ReadPort,
    claim: ReconciliationClaim,
    cwd: string,
  ): Promise<Record<string, unknown>> {
    const response = await port.request('thread/read', {
      threadId: claim.threadId,
      includeTurns: false,
    });
    if (!isObject(response) || !isObject(response.thread)) return fail('INVALID_HISTORY_RESPONSE');
    const thread = response.thread;
    if (thread.id !== claim.threadId || thread.cwd !== cwd) return fail('HISTORY_SCOPE_MISMATCH');
    if (thread.historyMode !== 'paginated') return fail('HISTORY_MODE_UNSUPPORTED');
    if (!isObject(thread.status) || !['idle', 'notLoaded'].includes(String(thread.status.type)))
      return fail('HISTORY_NOT_TERMINAL');
    if (typeof thread.updatedAt !== 'number' || !Number.isFinite(thread.updatedAt))
      return fail('INVALID_HISTORY_RESPONSE');
    return thread;
  }
}

export interface UnknownReconcilerOptions {
  now?: () => number;
  /** Process check (replaceable in tests). */
  processGone?: (pid: number, marker: string | null) => boolean;
  /** True while this process still executes the Run; such Runs are left alone. */
  running?: (runId: string) => boolean;
  /** Receives each failed attempt (for the background log). */
  onError?: (runId: string, error: unknown) => void;
}
/** Attempts per Run in one app session before it is left for the user. */
export const MAX_RECONCILE_ATTEMPTS = 8;
/**
 * Automatic, read-only reconciliation of Unknown turns. For a turn whose executor died with the
 * app, it first proves that exact process ended (PID gone or reused), then looks the turn up in
 * Codex history. It never sends or resumes anything; failures retry with backoff (30 s doubling
 * to 30 min) and after a bounded number of attempts the Run stays Unknown for the user to check.
 */
export class UnknownRunReconciler {
  private store: ExecutionLedger;
  private history: Pick<HistoryReconciliation, 'reconcile'>;
  private options: UnknownReconcilerOptions;
  private attempts = new Map<string, { count: number; next: number }>();
  constructor(
    store: ExecutionLedger,
    history: Pick<HistoryReconciliation, 'reconcile'>,
    options: UnknownReconcilerOptions = {},
  ) {
    this.store = store;
    this.history = history;
    this.options = options;
  }
  /** One pass over the Unknown Runs that are due. Returns how many were resolved. */
  async step(): Promise<number> {
    const now = this.options.now ?? Date.now;
    let resolved = 0;
    for (const { runId, projectId } of this.store.unknownRuns()) {
      if (this.options.running?.(runId)) continue;
      const attempt = this.attempts.get(runId) ?? { count: 0, next: 0 };
      if (attempt.count >= MAX_RECONCILE_ATTEMPTS || now() < attempt.next) continue;
      try {
        const executor = this.store.executorProcess(runId);
        if (executor) {
          if (!(this.options.processGone ?? processGone)(executor.pid, executor.marker))
            fail('EXECUTOR_STILL_RUNNING');
          this.store.executorGone(runId, executor.connectionEpoch);
        }
        await this.history.reconcile({ projectId, runId });
        this.attempts.delete(runId);
        resolved++;
      } catch (error) {
        attempt.count++;
        attempt.next = now() + Math.min(30_000 * 2 ** (attempt.count - 1), 30 * 60_000);
        this.attempts.set(runId, attempt);
        this.options.onError?.(runId, error);
      }
    }
    return resolved;
  }
}
