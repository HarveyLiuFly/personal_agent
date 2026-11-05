import { createHash } from 'node:crypto';
import { LedgerError } from '../../store/src/ledger.ts';
import type { ExecutionLedger, RunRecord, RunToken } from '../../store/src/ledger.ts';
import type { ForegroundExecution, ExecutionRoleProfile } from './execution.ts';
import type { TaskService } from './tasks.ts';
import type {
  ChatRouteView,
  CommitChatRoute,
  ProposeMainChat,
  RouteStep,
} from '../../contracts/src/routing.ts';
import { answersDirectly } from '../../contracts/src/routing.ts';
import type { OperationReceipt, TaskSummary } from '../../contracts/src/tasks.ts';
import {
  routePrompt,
  routeOutputSchema,
  routeSchemaHash,
  isRejectedRouteOutput,
} from './routing.ts';

type Store = Pick<
  ExecutionLedger,
  | 'prepareMainRoute'
  | 'routeModelBound'
  | 'saveRouteModel'
  | 'mainRoutes'
  | 'routeView'
  | 'routeProposal'
  | 'pendingRoutes'
  | 'failPreparedRoute'
  | 'beginRouteCommit'
  | 'routeStepContext'
  | 'saveRouteStep'
  | 'routeQuery'
  | 'correctMainRoute'
  | 'runs'
  | 'projects'
  | 'applyGoal'
> & {
  routeChildResult: (
    projectId: string,
    key: string,
  ) => {
    receipt: OperationReceipt | null;
    run: RunRecord | null;
    domain?: { operationId: string; result: string };
  };
};
type Execution = Pick<ForegroundExecution, 'submitRole' | 'continueRun' | 'atCapacity'>;
type Tasks = Pick<TaskService, 'apply'>;
export interface ChatRouteProfileRequest {
  role: 'dot-router' | 'dot-chat';
  token: RunToken;
  projectId: string;
  planId: string;
  stepIndex?: number;
  text: string;
  sourceRefs: Array<{ ref: string; revision: string }>;
  candidates: TaskSummary[];
  focusTaskId: string | null;
}
export interface ChatRouteOptions {
  /** Host-only Context builder; never accepted from Renderer/model output. */ profile: (
    request: ChatRouteProfileRequest,
  ) => ExecutionRoleProfile;
  /** Receives a route that could not advance in a tick (for the background log). */
  onError?: (error: unknown) => void;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const routeModelKey = (planId: string) => 'chat-route-model:' + digest(planId);
export const routeChildKey = (planId: string, index: number) =>
  'chat-route-child:' + digest([planId, index]);
const id = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v));
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const active = new Set(['preparing', 'submitting', 'running', 'waiting_input', 'waiting_approval']);
const code = (e: unknown) =>
  e instanceof LedgerError && /^[A-Z][A-Z0-9_]{0,100}$/.test(e.code)
    ? e.code
    : 'ROUTE_STEP_OUTCOME_UNKNOWN';
const transient = new Set([
  'RUNTIME_BUSY',
  'BUDGET_EXHAUSTED',
  'TOKEN_BUDGET_EXHAUSTED',
  'WORKSPACE_BUSY',
]);
/** A fresh send's direct answer is started only this soon after the send (not on a late start). */
const AUTO_ANSWER_WINDOW_MS = 10 * 60_000;
/** Refusals that only mean "not now": the route waits and a later tick starts it. */
const waiting = new Set(['RUNTIME_BUSY', 'WORKSPACE_BUSY', 'WORKSPACE_TERMINAL_ACTIVE']);
const clipped = (s: string, max = 16384) => {
  if (s.length <= max) return s;
  let text = s.slice(0, max - 12);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text + '\n[内容已截断]';
};

/** Candidate proposals and explicit commits share the existing Ledger/Gateway.
 * A tick never resends an executing/Unknown child. The only proposal it commits is a fresh send's
 * single read-only CHAT answer (`autoAnswer`, at most 10 minutes old); everything else waits for
 * explicit confirmation.
 */
export class ChatRouteService {
  private store: Store;
  private execution: Execution;
  private tasks: Tasks;
  private options: ChatRouteOptions;
  private pumping = false;
  constructor(store: Store, execution: Execution, tasks: Tasks, options: ChatRouteOptions) {
    if (!options || typeof options.profile !== 'function')
      throw new LedgerError('ROUTE_PROFILE_FACTORY_REQUIRED');
    this.store = store;
    this.execution = execution;
    this.tasks = tasks;
    this.options = options;
  }
  private profile(request: ChatRouteProfileRequest): ExecutionRoleProfile {
    const profile = this.options.profile(request);
    // Context revisions belong to the actual Context resolver, not Task CAS or
    // the input Hash captured by the business proposal.
    const message = request.sourceRefs.find((source) => source.ref.startsWith('message:'))?.ref;
    if (
      !profile ||
      profile.role !== request.role ||
      profile.ephemeral !== true ||
      profile.tools !== 'none' ||
      !Array.isArray(profile.contextRefs) ||
      !message ||
      !profile.contextRefs.some((ref) => ref.ref === message) ||
      !profile.contextRefs.some((ref) => ref.ref === 'route:' + request.planId) ||
      (request.role === 'dot-router' && digest(profile.outputSchema) !== routeSchemaHash)
    )
      throw new LedgerError('INVALID_ROUTE_PROFILE');
    return profile;
  }
  private view(projectId: string, planId: string): ChatRouteView {
    return this.store.routeView(projectId, planId);
  }
  propose(input: ProposeMainChat): ChatRouteView {
    const prepared = this.store.prepareMainRoute(input);
    if (prepared.route.state !== 'prepared') return prepared.route;
    return this.startProposal(input.projectId, prepared.route.id);
  }
  /**
   * Starts the routing Run of a prepared route. At capacity, or while the project is busy, the
   * route stays prepared and a later tick starts it; any other refusal ends it as failed. Nothing
   * was sent either way, and the fixed model key means a retry can never run it twice.
   */
  private startProposal(projectId: string, planId: string): ChatRouteView {
    const prepared = this.store.routeProposal(projectId, planId);
    if (prepared.route.state !== 'prepared' || this.execution.atCapacity) return prepared.route;
    const text = routePrompt(prepared.text, prepared.candidates, prepared.focusTaskId);
    let runId: string;
    try {
      runId = this.execution.submitRole(
        { projectId, text, submissionKey: routeModelKey(planId) },
        (token) =>
          this.profile({
            role: 'dot-router',
            token,
            projectId,
            planId,
            text,
            sourceRefs: prepared.sourceRefs,
            candidates: prepared.candidates,
            focusTaskId: prepared.focusTaskId,
          }),
        'route-profile:' + digest([planId, routeSchemaHash]),
      ).runId;
    } catch (error) {
      if (error instanceof LedgerError && waiting.has(error.code)) return prepared.route;
      if (error instanceof LedgerError)
        return this.store.failPreparedRoute(projectId, planId, code(error));
      throw error;
    }
    return this.store.routeModelBound(projectId, planId, runId);
  }
  async commit(input: CommitChatRoute): Promise<ChatRouteView> {
    if (
      !object(input) ||
      !exact(input, ['projectId', 'planId', 'expectedVersion']) ||
      !id(input.projectId) ||
      !id(input.planId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    )
      throw new LedgerError('INVALID_ROUTE_COMMIT');
    const route = this.store.beginRouteCommit(input.projectId, input.planId, input.expectedVersion);
    if (route.state === 'committing') await this.tick(input.projectId);
    return this.view(input.projectId, input.planId);
  }
  correct(input: {
    projectId: string;
    planId: string;
    taskId: string;
    messageId: string;
    focusRevision: number;
  }): ChatRouteView {
    if (
      !object(input) ||
      !exact(input, ['projectId', 'planId', 'taskId', 'messageId', 'focusRevision']) ||
      !id(input.projectId) ||
      !id(input.planId) ||
      !id(input.taskId) ||
      !id(input.messageId) ||
      !Number.isSafeInteger(input.focusRevision) ||
      input.focusRevision < 0
    )
      throw new LedgerError('INVALID_ROUTE_CORRECTION');
    return this.store.correctMainRoute(
      input.projectId,
      input.planId,
      input.taskId,
      input.messageId,
      input.focusRevision,
    );
  }
  /**
   * The final answer of a role Run. Other items (such as a long sourced input) may be clipped
   * without losing it. A clipped answer is returned with a marker when `partial` allows (a CHAT
   * answer); a routing proposal must be complete.
   */
  private response(
    projectId: string,
    runId: string,
    partial = false,
  ): { run: RunRecord; text: string | null } {
    const run = this.store.runs(projectId, { runId })[0];
    if (!run) throw new LedgerError('ROUTE_RUN_UNAVAILABLE');
    const snapshot = run.snapshot;
    if (
      !snapshot ||
      snapshot.needsSnapshot ||
      snapshot.unsupportedItems ||
      !run.turnId ||
      !snapshot.turns.some((turn) => turn.id === run.turnId && turn.status === 'completed')
    )
      return { run, text: null };
    const answer = snapshot.items
      .filter(
        (item) =>
          item.turnId === run.turnId &&
          item.kind === 'message' &&
          item.role === 'assistant' &&
          item.status === 'complete',
      )
      .at(-1);
    if (!answer || (answer.truncated && !partial)) return { run, text: null };
    return { run, text: answer.truncated ? answer.text + '\n[内容已截断]' : answer.text };
  }
  private proposal(route: ChatRouteView): void {
    if (!route.routingRunId) return;
    const { run, text } = this.response(route.projectId, route.routingRunId);
    if (active.has(run.status)) return;
    if (run.status !== 'completed') {
      this.store.saveRouteModel(
        route.projectId,
        route.id,
        null,
        run.status === 'outcome_unknown' ? 'ROUTE_MODEL_OUTCOME_UNKNOWN' : 'ROUTE_MODEL_FAILED',
      );
      return;
    }
    if (!text) {
      this.store.saveRouteModel(
        route.projectId,
        route.id,
        null,
        'ROUTE_MODEL_SNAPSHOT_UNAVAILABLE',
      );
      return;
    }
    try {
      this.store.saveRouteModel(route.projectId, route.id, text);
    } catch (error) {
      this.store.saveRouteModel(route.projectId, route.id, null, code(error));
    }
  }
  private save(route: ChatRouteView, step: RouteStep): void {
    this.store.saveRouteStep(route.projectId, route.id, step);
  }
  private expected(context: ReturnType<Store['routeStepContext']>, step: RouteStep): number {
    const candidate = context.candidates.find((task) => task.taskId === step.operation.taskId);
    if (!candidate) throw new LedgerError('ROUTE_TASK_NOT_CANDIDATE');
    const prior = context.route.steps
      .filter(
        (other) =>
          other.index < step.index &&
          other.taskId === step.operation.taskId &&
          other.state === 'completed' &&
          other.receipt,
      )
      .at(-1);
    return prior?.receipt?.taskVersion ?? candidate.version;
  }
  private reconcile(route: ChatRouteView, step: RouteStep): boolean {
    const child = this.store.routeChildResult(route.projectId, routeChildKey(route.id, step.index));
    if (step.operation.kind === 'CREATE_GOAL' && child.domain) {
      this.save(route, {
        ...step,
        state: 'completed',
        operationId: child.domain.operationId,
        result: child.domain.result,
      });
      return true;
    }
    const runId = step.runId ?? child.run?.runId ?? child.receipt?.runId ?? undefined;
    if (child.receipt) {
      const receipt = child.receipt;
      if (
        ['PAUSE_TASK', 'CANCEL_TASK', 'CREATE_TASK', 'UPDATE_TASK'].includes(step.operation.kind)
      ) {
        this.save(route, {
          ...step,
          receipt,
          operationId: receipt.operationId,
          taskId: receipt.taskId,
          ...(receipt.runId ? { runId: receipt.runId } : {}),
          state: receipt.state,
          result: JSON.stringify(receipt),
        });
        return true;
      }
    }
    if (runId) {
      const { run, text } = this.response(route.projectId, runId, step.operation.kind === 'CHAT'),
        state: RouteStep['state'] = active.has(run.status)
          ? 'executing'
          : run.status === 'completed'
            ? step.operation.kind === 'CHAT' && !text
              ? 'outcome_unknown'
              : 'completed'
            : run.status === 'outcome_unknown'
              ? 'outcome_unknown'
              : run.status === 'cancelled'
                ? 'cancelled'
                : 'failed';
      this.save(route, {
        ...step,
        state,
        runId,
        taskId: run.taskId,
        ...(child.receipt
          ? { receipt: child.receipt, operationId: child.receipt.operationId }
          : {}),
        ...(state === 'completed'
          ? {
              result:
                step.operation.kind === 'CHAT'
                  ? clipped(text ?? '')
                  : JSON.stringify({
                      runId,
                      taskId: run.taskId,
                      status: run.status,
                      taskStatus: run.taskStatus,
                    }),
            }
          : {}),
        ...(state === 'outcome_unknown' ? { errorCode: 'ROUTE_CHILD_OUTCOME_UNKNOWN' } : {}),
      });
      return true;
    }
    return false;
  }
  private async dispatch(
    route: ChatRouteView,
    step: RouteStep,
    context: ReturnType<Store['routeStepContext']>,
  ): Promise<void> {
    const op = step.operation,
      projectId = route.projectId,
      key = routeChildKey(route.id, step.index);
    if (op.kind === 'QUERY_TASK') {
      const result = this.store.routeQuery(projectId, op.taskId!);
      if (result.version !== this.expected(context, step))
        throw new LedgerError('ROUTE_CANDIDATE_CHANGED');
      this.save(route, {
        ...step,
        state: 'completed',
        taskId: result.taskId,
        result: JSON.stringify(result),
      });
      return;
    }
    if (op.kind === 'CLARIFY') {
      this.save(route, {
        ...step,
        state: 'completed',
        result: context.route.plan?.question ?? '请明确目标和动作。',
      });
      return;
    }
    if (op.kind === 'CREATE_GOAL') {
      const result = this.store.applyGoal({
        kind: 'create',
        projectId,
        commandKey: key,
        title: op.title?.trim() || op.text!.slice(0, 120),
        objective: op.text!,
        criteria: ['用户确认目标结果符合原始要求'],
      });
      this.save(route, {
        ...step,
        state: 'completed',
        operationId: result.operationId,
        result: JSON.stringify(result.goal),
      });
      return;
    }
    if (op.kind === 'CHAT') {
      const sources = [
          {
            ref: 'message:' + route.messageId,
            revision: context.input ? digest(context.input) : '',
          },
        ],
        text = op.text!;
      const run = this.execution.submitRole(
        { projectId, text, submissionKey: key },
        (token) =>
          this.profile({
            role: 'dot-chat',
            token,
            projectId,
            planId: route.id,
            stepIndex: step.index,
            text,
            sourceRefs: sources,
            candidates: context.candidates,
            focusTaskId: context.route.plan?.focusTaskId ?? null,
          }),
        'chat-profile:' + digest([route.id, step.index]),
      );
      this.save(route, { ...step, state: 'executing', runId: run.runId, taskId: run.taskId });
      return;
    }
    if (op.kind === 'CONTINUE_TASK') {
      const source = this.store.runs(projectId, { taskId: op.taskId!, limit: 1 })[0];
      if (!source || !['completed', 'failed'].includes(source.status))
        throw new LedgerError('RUN_NOT_CONTINUABLE');
      const target = this.store.routeQuery(projectId, op.taskId!);
      if (target.version !== this.expected(context, step))
        throw new LedgerError('ROUTE_CANDIDATE_CHANGED');
      const run = this.execution.continueRun({
        projectId,
        runId: source.runId,
        text: op.text!,
        submissionKey: key,
      });
      this.save(route, { ...step, state: 'executing', runId: run.runId, taskId: run.taskId });
      return;
    }
    const base = { projectId, commandKey: key };
    const receipt =
      op.kind === 'CREATE_TASK'
        ? await this.tasks.apply({
            ...base,
            kind: 'create',
            text: op.text!,
            ...(op.title?.trim() ? { title: op.title } : {}),
          })
        : await this.tasks.apply({
            ...base,
            taskId: op.taskId!,
            expectedVersion: this.expected(context, step),
            ...(op.kind === 'UPDATE_TASK'
              ? { kind: 'rename', title: op.title! }
              : { kind: op.kind === 'PAUSE_TASK' ? 'pause' : 'cancel' }),
          });
    this.save(route, {
      ...step,
      state: receipt.state,
      receipt,
      operationId: receipt.operationId,
      taskId: receipt.taskId,
      ...(receipt.runId ? { runId: receipt.runId } : {}),
      result: JSON.stringify(receipt),
    });
  }
  private async advance(original: ChatRouteView): Promise<void> {
    for (let index = 0; index < original.steps.length; index++) {
      const route = this.view(original.projectId, original.id),
        step = route.steps[index];
      if (!step || !['committing', 'outcome_unknown'].includes(route.state)) return;
      if (step.state === 'executing') {
        if (!this.reconcile(route, step))
          this.save(route, {
            ...step,
            state: 'outcome_unknown',
            errorCode: 'ROUTE_CHILD_RECEIPT_MISSING',
          });
        continue;
      }
      if (step.state !== 'pending' || route.state !== 'committing') continue;
      const dependencies = step.operation.dependsOn.map((i) => route.steps[i]!);
      if (dependencies.some((d) => d.state === 'failed' || d.state === 'cancelled')) {
        this.save(route, { ...step, state: 'cancelled', errorCode: 'ROUTE_DEPENDENCY_FAILED' });
        continue;
      }
      if (dependencies.some((d) => d.state !== 'completed')) continue;
      if (['CONTINUE_TASK', 'CHAT'].includes(step.operation.kind) && this.execution.atCapacity)
        continue;
      let context: ReturnType<Store['routeStepContext']>;
      try {
        context = this.store.routeStepContext(route.projectId, route.id, index);
      } catch (error) {
        this.save(route, { ...step, state: 'failed', errorCode: code(error) });
        continue;
      }
      const executing: RouteStep = { ...step, state: 'executing' };
      this.save(route, executing);
      try {
        if (!this.reconcile(route, executing)) await this.dispatch(route, executing, context);
      } catch (error) {
        // The effect may already have committed even if its caller lost the reply.
        if (this.reconcile(this.view(route.projectId, route.id), executing)) continue;
        const failure = code(error),
          state: RouteStep['state'] =
            error instanceof LedgerError
              ? transient.has(failure)
                ? 'pending'
                : 'failed'
              : 'outcome_unknown';
        this.save(route, { ...step, state, errorCode: failure });
      }
    }
  }
  async tick(projectId?: string): Promise<ChatRouteView[]> {
    if (projectId !== undefined && !id(projectId)) throw new LedgerError('INVALID_ROUTE_QUERY');
    if (this.pumping) return [];
    this.pumping = true;
    const result: ChatRouteView[] = [];
    try {
      for (const project of projectId ? [{ id: projectId }] : this.store.projects()) {
        let routes: ChatRouteView[];
        try {
          // Every route that still needs the Host, however old (not only the latest page).
          routes = this.store.pendingRoutes(project.id);
        } catch {
          continue;
        }
        for (const route of routes) {
          try {
            let current = route;
            if (current.state === 'prepared') current = this.startProposal(project.id, current.id);
            if (
              current.state === 'proposing' ||
              (current.state === 'outcome_unknown' &&
                current.plan === null &&
                current.steps.length === 0 &&
                isRejectedRouteOutput(current.errorCode))
            ) {
              this.proposal(current);
              current = this.view(project.id, current.id);
            }
            // A fresh send's single CHAT is answered here, not by a page that must stay open.
            if (
              current.autoAnswer &&
              answersDirectly(current) &&
              Date.now() - current.createdAt < AUTO_ANSWER_WINDOW_MS
            )
              current = this.store.beginRouteCommit(project.id, current.id, current.version);
            if (current.state === 'committing' || current.state === 'outcome_unknown')
              await this.advance(current);
            result.push(this.view(project.id, current.id));
          } catch (error) {
            // A revoked or unavailable plan cannot advance another scope.
            this.options.onError?.(error);
          }
        }
      }
      return result;
    } finally {
      this.pumping = false;
    }
  }
}
export { routeOutputSchema };
