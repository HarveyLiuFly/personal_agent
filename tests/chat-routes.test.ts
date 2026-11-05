import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger, LedgerError, hashInput } from '../packages/store/src/ledger.ts';
import type { RunToken } from '../packages/store/src/ledger.ts';
import type { BudgetPolicy } from '../packages/store/src/budget.ts';
import { TaskService } from '../packages/runtime/src/tasks.ts';
import type {
  ForegroundExecution,
  ExecutionRoleProfile,
} from '../packages/runtime/src/execution.ts';
import {
  ChatRouteService,
  routeModelKey,
  routeChildKey,
  routeOutputSchema,
} from '../packages/runtime/src/chat-routes.ts';
import type { ChatRouteProfileRequest } from '../packages/runtime/src/chat-routes.ts';
import { routePrompt } from '../packages/runtime/src/routing.ts';
import type { RouteOperation, RoutePlan } from '../packages/contracts/src/routing.ts';
import type { TaskCommand } from '../packages/contracts/src/tasks.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
const op = (kind: RouteOperation['kind'], extra: Partial<RouteOperation> = {}): RouteOperation => ({
  kind,
  taskId: null,
  text: null,
  title: null,
  dependsOn: [],
  ...extra,
});
const plan = (operations: RouteOperation[], question: string | null = null): RoutePlan => ({
  operations,
  focusTaskId: null,
  question,
});

// Actual SQLite, TaskService and domain transactions. The execution adapter is
// deliberately synthetic: it writes accepted Run/Intent/projection metadata,
// performs no RPC or model call, and never proves real model/task success.
function fixture(t: { after(fn: () => void): void }, budgetPolicy?: BudgetPolicy) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-chat-routes-'))),
    cwd = join(root, 'project'),
    file = join(root, 'ledger.db');
  mkdirSync(cwd);
  let store = new ExecutionLedger(file, schema, budgetPolicy ? { budgetPolicy } : {});
  store.startOwner('route-fixture-owner', true);
  const project = store.registerWorkspace(cwd),
    db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  const a = store.taskCommand({
      kind: 'create',
      projectId: project.id,
      commandKey: 'a',
      text: 'PUBLIC_ALPHA_TASK',
    }),
    b = store.taskCommand({
      kind: 'create',
      projectId: project.id,
      commandKey: 'b',
      text: 'PUBLIC_BETA_TASK',
    });
  let roles = 0,
    continuations = 0,
    busy = false,
    taskCalls = 0;
  const pending = new Map<string, RunToken>(),
    profiles: ExecutionRoleProfile[] = [];
  const profile = (request: ChatRouteProfileRequest): ExecutionRoleProfile => ({
    role: request.role,
    developerInstructions: 'Synthetic role instructions for projection tests only.',
    contextRefs: [
      {
        ref: request.sourceRefs.find((s) => s.ref.startsWith('message:'))!.ref,
        revision: 'actual-context-revision',
      },
      { ref: 'route:' + request.planId, revision: 'actual-context-revision' },
    ],
    ephemeral: true,
    tools: 'none',
    contextHash: hashInput(request.text),
    ...(request.role === 'dot-router' ? { outputSchema: routeOutputSchema } : {}),
  });
  const fake = {
    get busy() {
      return busy;
    },
    // Single-slot fake: no further Run can be admitted while one is in flight.
    get atCapacity() {
      return busy;
    },
    get supportsQueuedCode() {
      return false;
    },
    submitRole(
      input: { projectId: string; text: string; submissionKey: string },
      factory: ExecutionRoleProfile | ((token: RunToken) => ExecutionRoleProfile),
      profileKey?: string,
    ) {
      if (busy) throw new LedgerError('RUNTIME_BUSY');
      const result = store.beginRun(
        input.projectId,
        input.text,
        input.submissionKey,
        'readOnly',
        hashInput(typeof factory === 'function' ? profileKey : factory),
      );
      if (result.created) {
        const value = typeof factory === 'function' ? factory(result.token) : factory;
        profiles.push(value);
        store.configureRoleManifest(result.token, value.role, value.contextRefs, value.contextHash);
        pending.set(result.token.runId, result.token);
        roles++;
        busy = true;
      }
      return store.runForHost(result.token.runId);
    },
    continueRun(input: unknown) {
      const q = input as { projectId: string; runId: string; text: string; submissionKey: string },
        result = store.beginContinuation(q.projectId, q.runId, q.text, q.submissionKey);
      if (result.created) {
        pending.set(result.token.runId, result.token);
        continuations++;
        busy = true;
      }
      return store.runForHost(result.token.runId);
    },
    async interrupt(input: unknown) {
      const q = input as { runId: string },
        run = store.runForHost(q.runId);
      store.finish({ runId: q.runId, epoch: run.epoch, taskFence: run.taskFence }, 'cancelled');
    },
  };
  let tasks = new TaskService(store, fake as unknown as ForegroundExecution);
  let taskApply = (input: unknown) => tasks.apply(input);
  let service = new ChatRouteService(
    store,
    fake,
    {
      apply: async (input) => {
        taskCalls++;
        return taskApply(input);
      },
    },
    { profile },
  );
  const complete = (
    runId: string,
    output: string,
    outcome: 'completed' | 'failed' | 'outcome_unknown' = 'completed',
    clip: { input?: boolean; answer?: boolean } = {},
  ) => {
    const token =
      pending.get(runId) ??
      (() => {
        const r = store.runForHost(runId);
        return { runId, epoch: r.epoch, taskFence: r.taskFence };
      })();
    const run = store.runForHost(runId);
    let threadId = run.threadId;
    if (!threadId) {
      threadId = 'public-thread-' + runId;
      const intent = store.prepare(token, 'thread-key-' + runId, 'thread_start', {});
      store.sending(token, intent.intentId, 1);
      store.accepted(token, intent.intentId, { threadId });
    }
    const turnId = 'public-turn-' + runId,
      intent = store.prepare(token, 'turn-key-' + runId, 'turn_start', {}, threadId);
    store.sending(token, intent.intentId, 1);
    store.accepted(token, intent.intentId, { turnId });
    store.saveSnapshot(token, {
      threadId,
      epoch: 1,
      sequence: 1,
      needsSnapshot: false,
      truncated: Boolean(clip.input || clip.answer),
      unsupportedItems: false,
      turns: [{ id: turnId, status: 'completed' }],
      items: [
        ...(clip.input
          ? [
              {
                id: 'synthetic-user-' + runId,
                turnId,
                kind: 'message' as const,
                role: 'user' as const,
                label: 'synthetic-user',
                text: 'x'.repeat(100),
                status: 'complete' as const,
                truncated: true,
              },
            ]
          : []),
        {
          id: 'synthetic-assistant-' + runId,
          turnId,
          kind: 'message',
          role: 'assistant',
          label: 'synthetic-assistant',
          text: output,
          status: 'complete',
          truncated: Boolean(clip.answer),
        },
      ],
    });
    if (outcome === 'outcome_unknown') store.uncertain(token);
    else store.finish(token, outcome);
    busy = false;
    pending.delete(runId);
  };
  let message = 0;
  const propose = async (value: RoutePlan, body = 'Public synthetic route request') => {
    const input = {
        projectId: project.id,
        messageId: 'route-message-' + ++message,
        text: body,
        focusRevision: store.mainChat({ projectId: project.id }).focusRevision,
      },
      initial = service.propose(input);
    complete(initial.routingRunId!, JSON.stringify(value));
    await service.tick(project.id);
    return store.mainRoutes(project.id).find((r) => r.id === initial.id)!;
  };
  t.after(() => {
    store.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    cwd,
    file,
    project,
    db,
    a,
    b,
    fake,
    profiles,
    complete,
    propose,
    profile,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get tasks() {
      return tasks;
    },
    calls: () => ({ roles, continuations, taskCalls }),
    setTaskApply(fn: (input: unknown) => ReturnType<TaskService['apply']>) {
      taskApply = fn;
    },
    reopen() {
      store.close();
      store = new ExecutionLedger(file, schema, budgetPolicy ? { budgetPolicy } : {});
      store.startOwner('reopened-route-owner', true);
      tasks = new TaskService(store, fake as unknown as ForegroundExecution);
      taskApply = (input) => tasks.apply(input);
      service = new ChatRouteService(
        store,
        fake,
        {
          apply: async (input) => {
            taskCalls++;
            return taskApply(input);
          },
        },
        { profile },
      );
    },
  };
}
test('a candidate-bound proposal persists one routing Run and never commits task changes without explicit approval', async (t) => {
  const f = fixture(t),
    before = f.store.routeQuery(f.project.id, f.a.taskId),
    route = await f.propose(
      plan([op('UPDATE_TASK', { taskId: f.a.taskId, title: 'Proposed title' })]),
    );
  assert.equal(route.state, 'proposed');
  assert.deepEqual(f.store.routeQuery(f.project.id, f.a.taskId), before);
  assert.equal(f.calls().taskCalls, 0);
  await f.service.tick();
  assert.equal(f.calls().taskCalls, 0);
  assert.equal(f.profiles[0]!.tools, 'none');
  assert.deepEqual(f.profiles[0]!.outputSchema, routeOutputSchema);
  assert.equal(
    f.db.prepare('SELECT idempotency_key FROM task_runs WHERE run_id=?').get(route.routingRunId!)!
      .idempotency_key,
    routeModelKey(route.id),
  );
});
test('explicit commit executes a DAG with persisted receipt versions, one query snapshot and a queued new Task', async (t) => {
  const f = fixture(t),
    route = await f.propose(
      plan([
        op('UPDATE_TASK', { taskId: f.a.taskId, title: 'Renamed public task' }),
        op('PAUSE_TASK', { taskId: f.a.taskId, dependsOn: [0] }),
        op('QUERY_TASK', { taskId: f.a.taskId, dependsOn: [1] }),
        op('CREATE_TASK', {
          title: 'Named queued task',
          text: 'Public queued work',
          dependsOn: [2],
        }),
      ]),
    );
  const done = await f.service.commit({
    projectId: f.project.id,
    planId: route.id,
    expectedVersion: route.version,
  });
  assert.equal(done.state, 'completed');
  assert.deepEqual(
    done.steps.map((s) => s.state),
    ['completed', 'completed', 'completed', 'completed'],
  );
  assert.equal(done.steps[1]!.receipt!.taskVersion, done.steps[0]!.receipt!.taskVersion + 1);
  assert.equal(JSON.parse(done.steps[2]!.result!).status, 'paused');
  assert.equal(done.steps[3]!.receipt!.status, 'queued');
  assert.equal(f.store.routeQuery(f.project.id, done.steps[3]!.taskId!).title, 'Named queued task');
  assert.equal(f.calls().roles, 1);
  assert.equal(f.calls().continuations, 0);
  const again = await f.service.commit({
    projectId: f.project.id,
    planId: route.id,
    expectedVersion: route.version,
  });
  assert.deepEqual(again, done);
  assert.equal(f.calls().taskCalls, 3);
});
test('partial domain failure cancels its dependents while independent operations complete', async (t) => {
  const f = fixture(t),
    route = await f.propose(
      plan([
        op('UPDATE_TASK', { taskId: f.a.taskId, title: 'Deliberate domain rejection' }),
        op('PAUSE_TASK', { taskId: f.a.taskId, dependsOn: [0] }),
        op('QUERY_TASK', { taskId: f.b.taskId }),
      ]),
    );
  f.setTaskApply(async (input) => {
    const command = input as TaskCommand;
    if (command.kind === 'rename') throw new LedgerError('PUBLIC_DOMAIN_REJECTION');
    return f.tasks.apply(input);
  });
  const done = await f.service.commit({
    projectId: f.project.id,
    planId: route.id,
    expectedVersion: route.version,
  });
  assert.equal(done.state, 'failed');
  assert.deepEqual(
    done.steps.map((s) => s.state),
    ['failed', 'cancelled', 'completed'],
  );
  assert.equal(done.steps[1]!.errorCode, 'ROUTE_DEPENDENCY_FAILED');
  assert.equal(f.store.routeQuery(f.project.id, f.a.taskId).status, 'queued');
});
test('a lost domain receipt is recovered by fixed child key, without invoking a second Task mutation', async (t) => {
  const f = fixture(t),
    route = await f.propose(plan([op('CREATE_TASK', { text: 'Public once-only work' })]));
  f.setTaskApply(async (input) => {
    await f.tasks.apply(input);
    throw Error('/private/provider-reply-lost');
  });
  const done = await f.service.commit({
    projectId: f.project.id,
    planId: route.id,
    expectedVersion: route.version,
  });
  assert.equal(done.state, 'completed');
  assert.equal(f.calls().taskCalls, 1);
  assert.ok(done.steps[0]!.receipt);
  assert.equal(JSON.stringify(done).includes('/private'), false);
});
test('reopened Owner reads an executing child receipt without replaying TaskService or creating another Task', async (t) => {
  const f = fixture(t),
    route = await f.propose(plan([op('CREATE_TASK', { text: 'Public crash-window work' })]));
  f.store.beginRouteCommit(f.project.id, route.id, route.version);
  const context = f.store.routeStepContext(f.project.id, route.id, 0);
  f.store.saveRouteStep(f.project.id, route.id, { ...context.step, state: 'executing' });
  await f.tasks.apply({
    kind: 'create',
    projectId: f.project.id,
    commandKey: routeChildKey(route.id, 0),
    text: 'Public crash-window work',
  });
  const before = f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
  f.reopen();
  await f.service.tick();
  const after = f.store.mainRoutes(f.project.id).find((r) => r.id === route.id)!;
  assert.equal(after.state, 'completed');
  assert.equal(f.calls().taskCalls, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, before);
});
test('an executing child with no durable receipt becomes Unknown and is never resent across ticks or explicit commits', async (t) => {
  const f = fixture(t),
    route = await f.propose(plan([op('CREATE_TASK', { text: 'Uncertain pre-dispatch window' })]));
  f.store.beginRouteCommit(f.project.id, route.id, route.version);
  const context = f.store.routeStepContext(f.project.id, route.id, 0);
  f.store.saveRouteStep(f.project.id, route.id, { ...context.step, state: 'executing' });
  f.reopen();
  await f.service.tick();
  await f.service.tick();
  const unknown = await f.service.commit({
    projectId: f.project.id,
    planId: route.id,
    expectedVersion: 1,
  });
  assert.equal(unknown.state, 'outcome_unknown');
  assert.equal(unknown.steps[0]!.state, 'outcome_unknown');
  assert.equal(f.calls().taskCalls, 0);
});
test('continuation admission on explicit commit persists one Run which is checked without replay', async (t) => {
  const f = fixture(t),
    source = f.store.claimTask(f.project.id, f.a.taskId, 2, 'public-prior-run');
  f.complete(source.token.runId, 'Synthetic prior answer');
  const route = await f.propose(
    plan([op('CONTINUE_TASK', { taskId: f.a.taskId, text: 'Public explicit continuation' })]),
  );
  assert.equal(f.calls().continuations, 0);
  const running = await f.service.commit({
    projectId: f.project.id,
    planId: route.id,
    expectedVersion: route.version,
  });
  assert.equal(running.steps[0]!.state, 'executing');
  assert.equal(f.calls().continuations, 1);
  await f.service.tick();
  assert.equal(f.calls().continuations, 1);
  f.complete(running.steps[0]!.runId!, 'Synthetic continued answer');
  await f.service.tick();
  const done = f.store.mainRoutes(f.project.id).find((r) => r.id === route.id)!;
  assert.equal(done.state, 'completed');
  assert.equal(f.calls().continuations, 1);
});
test('CHAT uses a separate no-tools role and stores its current-turn snapshot answer after completion', async (t) => {
  const f = fixture(t),
    // A fresh send's single CHAT is answered by the Host in the same tick (no page commit).
    running = await f.propose(plan([op('CHAT', { text: 'Public discussion question' })])),
    route = running;
  assert.equal(running.state, 'committing');
  assert.equal(running.steps[0]!.state, 'executing');
  assert.equal(f.calls().roles, 2);
  assert.equal(f.profiles[1]!.role, 'dot-chat');
  assert.equal(f.profiles[1]!.tools, 'none');
  f.complete(running.steps[0]!.runId!, 'Public synthetic chat answer');
  await f.service.tick();
  const done = f.store.mainRoutes(f.project.id).find((r) => r.id === route.id)!;
  assert.equal(done.steps[0]!.result, 'Public synthetic chat answer');
  assert.equal(done.state, 'completed');
});
test('unknown model outcome never generates another proposal or child and malformed/foreign candidate output is rejected', async (t) => {
  const f = fixture(t),
    input = {
      projectId: f.project.id,
      messageId: 'unknown-model',
      text: 'Public unknown model fixture',
      focusRevision: 0,
    },
    initial = f.service.propose(input);
  f.complete(initial.routingRunId!, '{}', 'outcome_unknown');
  await f.service.tick();
  assert.equal(f.service.propose(input).state, 'outcome_unknown');
  await f.service.tick();
  assert.equal(f.calls().roles, 1);
  assert.equal(f.calls().taskCalls, 0);
});
test('strict structured output rejects foreign IDs and cyclic dependencies without any Task effect', async (t) => {
  for (const value of [
    plan([op('QUERY_TASK', { taskId: 'foreign-task' })]),
    plan([op('CREATE_TASK', { text: 'Public work', dependsOn: [0] })]),
  ]) {
    const f = fixture(t),
      input = {
        projectId: f.project.id,
        messageId: 'bad-model',
        text: 'Public bad model fixture',
        focusRevision: 0,
      },
      initial = f.service.propose(input);
    f.complete(initial.routingRunId!, JSON.stringify(value));
    await f.service.tick();
    const route = f.store.mainRoutes(f.project.id)[0]!;
    assert.equal(route.state, 'failed');
    await f.service.tick();
    assert.equal(f.service.propose(input).state, 'failed');
    assert.equal(f.calls().roles, 1);
    assert.equal(f.calls().taskCalls, 0);
  }
});
test('correction cancels uncommitted steps and records a new Focus', async (t) => {
  const f = fixture(t),
    route = await f.propose(
      plan([op('UPDATE_TASK', { taskId: f.a.taskId, title: 'Never apply this title' })]),
    ),
    corrected = f.service.correct({
      projectId: f.project.id,
      planId: route.id,
      taskId: f.b.taskId,
      messageId: 'corrected-target',
      focusRevision: 0,
    });
  assert.equal(corrected.state, 'corrected');
  assert.equal(corrected.steps[0]!.state, 'cancelled');
  assert.equal(f.store.mainChat({ projectId: f.project.id }).focus!.task.taskId, f.b.taskId);
  assert.equal(f.store.routeQuery(f.project.id, f.a.taskId).title, 'PUBLIC_ALPHA_TASK');
  await f.service.tick();
  assert.equal(f.calls().taskCalls, 0);
});
test('a completed routing Run in the pre-bind crash window is recovered under the same model key', async (t) => {
  const f = fixture(t),
    input = {
      projectId: f.project.id,
      messageId: 'pre-bind',
      text: 'Public pre-bind crash fixture',
      focusRevision: 0,
    },
    prepared = f.store.prepareMainRoute(input),
    synthetic = f.fake.submitRole(
      {
        projectId: f.project.id,
        text: routePrompt(input.text, prepared.candidates, prepared.focusTaskId),
        submissionKey: routeModelKey(prepared.route.id),
      },
      (token) =>
        f.profile({
          role: 'dot-router',
          token,
          projectId: f.project.id,
          planId: prepared.route.id,
          text: input.text,
          sourceRefs: prepared.sourceRefs,
          candidates: prepared.candidates,
          focusTaskId: null,
        }),
      'route-profile:' + hashInput([prepared.route.id, hashInput(routeOutputSchema)]),
    );
  f.complete(synthetic.runId, JSON.stringify(plan([op('QUERY_TASK', { taskId: f.a.taskId })])));
  f.reopen();
  assert.equal(f.service.propose(input).routingRunId, synthetic.runId);
  await f.service.tick();
  assert.equal(f.store.mainRoutes(f.project.id)[0]!.state, 'proposed');
  assert.equal(f.calls().roles, 1);
  assert.equal(f.calls().taskCalls, 0);
});
test('a result persistence failure leaves the real child committed and later recovers without replay', async (t) => {
  const f = fixture(t),
    route = await f.propose(plan([op('CREATE_TASK', { text: 'Public persist-once fixture' })]));
  f.db.exec(
    "CREATE TRIGGER hold_route_result BEFORE UPDATE ON router_decisions WHEN new.decision_id='" +
      route.id +
      "' AND json_extract(new.decision_json,'$.route.steps[0].state')='completed' BEGIN SELECT RAISE(ABORT,'public route receipt persistence failure'); END",
  );
  const interrupted = await f.service.commit({
    projectId: f.project.id,
    planId: route.id,
    expectedVersion: route.version,
  });
  assert.equal(interrupted.steps[0]!.state, 'executing');
  const before = f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
  f.db.exec('DROP TRIGGER hold_route_result');
  f.reopen();
  await f.service.tick();
  assert.equal(f.store.mainRoutes(f.project.id).find((r) => r.id === route.id)!.state, 'completed');
  assert.equal(f.calls().taskCalls, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, before);
});
test('an Unknown continuation is never resubmitted and correction refuses unreconciled side effects', async (t) => {
  const f = fixture(t),
    source = f.store.claimTask(f.project.id, f.a.taskId, 2, 'prior-unknown-fixture');
  f.complete(source.token.runId, 'Synthetic prior answer');
  const route = await f.propose(
      plan([op('CONTINUE_TASK', { taskId: f.a.taskId, text: 'Public unknown continuation' })]),
    ),
    running = await f.service.commit({
      projectId: f.project.id,
      planId: route.id,
      expectedVersion: route.version,
    });
  f.complete(running.steps[0]!.runId!, 'Synthetic uncertain answer', 'outcome_unknown');
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.calls().continuations, 1);
  assert.equal(
    f.store.mainRoutes(f.project.id).find((r) => r.id === route.id)!.state,
    'outcome_unknown',
  );
  assert.throws(
    () =>
      f.service.correct({
        projectId: f.project.id,
        planId: route.id,
        taskId: f.b.taskId,
        messageId: 'unsafe-correction',
        focusRevision: 0,
      }),
    /CORRECTION_REQUIRES_RECONCILIATION/,
  );
});
test('explicit CREATE_GOAL persists a waiting-plan Goal and correction preserves earlier completed mutations', async (t) => {
  const f = fixture(t),
    route = await f.propose(
      plan([
        op('CREATE_GOAL', { text: 'Public goal objective', title: 'Public goal' }),
        op('UPDATE_TASK', { taskId: f.a.taskId, title: 'Completed public rename' }),
      ]),
    ),
    done = await f.service.commit({
      projectId: f.project.id,
      planId: route.id,
      expectedVersion: route.version,
    });
  assert.equal(done.state, 'completed');
  assert.equal(f.store.listGoals(f.project.id).length, 1);
  assert.equal(f.store.listGoals(f.project.id)[0]!.requiresPlan, true);
  const corrected = f.service.correct({
    projectId: f.project.id,
    planId: route.id,
    taskId: f.b.taskId,
    messageId: 'post-effect-correction',
    focusRevision: 0,
  });
  assert.equal(corrected.state, 'corrected');
  assert.equal(corrected.steps[1]!.state, 'completed');
  assert.equal(f.store.routeQuery(f.project.id, f.a.taskId).title, 'Completed public rename');
  assert.equal(f.store.listGoals(f.project.id).length, 1);
});
test('version changes, additional command fields and unsafe Host role profiles fail closed', async (t) => {
  const f = fixture(t),
    route = await f.propose(
      plan([op('UPDATE_TASK', { taskId: f.a.taskId, title: 'Stale proposed title' })]),
    );
  f.store.taskCommand({
    kind: 'rename',
    projectId: f.project.id,
    taskId: f.a.taskId,
    commandKey: 'external-edit',
    expectedVersion: 2,
    title: 'Actual current title',
  });
  await assert.rejects(
    f.service.commit({ projectId: f.project.id, planId: route.id, expectedVersion: route.version }),
    /ROUTE_CANDIDATE_CHANGED/,
  );
  await assert.rejects(
    f.service.commit({
      projectId: f.project.id,
      planId: route.id,
      expectedVersion: route.version,
      path: '/private',
    } as never),
    /INVALID_ROUTE_COMMIT/,
  );
  assert.throws(
    () =>
      f.service.correct({
        projectId: f.project.id,
        planId: route.id,
        taskId: f.b.taskId,
        messageId: 'x',
        focusRevision: 0,
        sql: 'raw',
      } as never),
    /INVALID_ROUTE_CORRECTION/,
  );
  const unsafe = new ChatRouteService(f.store, f.fake, f.tasks, {
    profile: (request) => ({ ...f.profile(request), tools: 'readOnly' }),
  });
  // Refused before anything is sent: the route ends as failed instead of waiting forever.
  const sent = () =>
    f.db.prepare("SELECT count(*) AS n FROM execution_intents WHERE state<>'prepared'").get()!.n;
  const before = sent();
  const refused = unsafe.propose({
    projectId: f.project.id,
    messageId: 'unsafe-role',
    text: 'Public unsafe profile fixture',
    focusRevision: 0,
  });
  assert.equal(refused.state, 'failed');
  assert.equal(refused.errorCode, 'INVALID_ROUTE_PROFILE');
  assert.equal(sent(), before);
});

test('legacy invalid completed proposals are reclassified from original evidence without another model call', async (t) => {
  const f = fixture(t),
    route = await f.propose(
      plan([op('CHAT', { text: 'Synthetic answer' }), op('CLARIFY')], 'Synthetic clarification'),
    );
  const saved = f.db
    .prepare('SELECT decision_json FROM router_decisions WHERE decision_id=?')
    .get(route.id)!;
  const data = JSON.parse(String(saved.decision_json));
  data.route.state = 'outcome_unknown';
  data.route.errorCode = 'INVALID_ROUTE_CLARIFICATION';
  f.db
    .prepare('UPDATE router_decisions SET decision_json=? WHERE decision_id=?')
    .run(JSON.stringify(data), route.id);
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.store.mainRoutes(f.project.id)[0]!.state, 'failed');
  assert.equal(f.calls().roles, 1);
  assert.equal(f.calls().taskCalls, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 1);
});

test('a question asked at capacity waits as prepared and starts once a slot frees (L10)', async (t) => {
  const f = fixture(t);
  // Another routing Run holds the only slot.
  const first = f.service.propose({
    projectId: f.project.id,
    messageId: 'busy-first',
    text: 'Public first question',
    focusRevision: 0,
  });
  assert.equal(first.state, 'proposing');
  const waiting = f.service.propose({
    projectId: f.project.id,
    messageId: 'busy-second',
    text: 'Public second question',
    focusRevision: 0,
  });
  assert.equal(waiting.state, 'prepared', 'no RUNTIME_BUSY error and no stuck send');
  assert.equal(f.calls().roles, 1);
  await f.service.tick(f.project.id);
  assert.equal(f.store.routeView(f.project.id, waiting.id).state, 'prepared');
  f.complete(first.routingRunId!, JSON.stringify(plan([op('CLARIFY')], 'Which one?')));
  await f.service.tick(f.project.id);
  const started = f.store.routeView(f.project.id, waiting.id);
  assert.equal(started.state, 'proposing');
  assert.ok(started.routingRunId);
  assert.equal(f.calls().roles, 2);
  // A retried start is the same Run (fixed model key), never a second one.
  await f.service.tick(f.project.id);
  assert.equal(f.calls().roles, 2);
});

test('only a fresh single CHAT is answered without confirmation (L11)', async (t) => {
  const f = fixture(t);
  // Mixed or mutating plans still wait for explicit confirmation.
  const mixed = await f.propose(
    plan([op('CHAT', { text: 'Public question' }), op('QUERY_TASK', { taskId: f.a.taskId })]),
  );
  assert.equal(mixed.state, 'proposed');
  // A legacy route without the fresh-send mark is never auto-committed.
  const input = {
    projectId: f.project.id,
    messageId: 'legacy-message',
    text: 'Public legacy question',
    focusRevision: f.store.mainChat({ projectId: f.project.id }).focusRevision,
  };
  const legacy = f.service.propose(input);
  f.db
    .prepare(
      "UPDATE router_decisions SET decision_json=json_remove(decision_json,'$.route.autoAnswer') WHERE decision_id=?",
    )
    .run(legacy.id);
  f.complete(legacy.routingRunId!, JSON.stringify(plan([op('CHAT', { text: 'Old question' })])));
  await f.service.tick(f.project.id);
  assert.equal(f.store.routeView(f.project.id, legacy.id).state, 'proposed');
  // A fresh send proposed more than 10 minutes ago is not answered on a later start either.
  const late = f.service.propose({ ...input, messageId: 'late-message', text: 'Public late one' });
  f.db
    .prepare(
      "UPDATE router_decisions SET created_at_ms=created_at_ms-660000,decision_json=json_set(decision_json,'$.route.createdAt',json_extract(decision_json,'$.route.createdAt')-660000) WHERE decision_id=?",
    )
    .run(late.id);
  f.complete(late.routingRunId!, JSON.stringify(plan([op('CHAT', { text: 'Late question' })])));
  await f.service.tick(f.project.id);
  // Its proposal still lands (it was proposing), but it waits for confirmation.
  assert.equal(f.store.routeView(f.project.id, late.id).state, 'proposed');
  assert.equal(f.calls().roles, 3);
});

test('routes beyond the latest page still advance and are found by ID (L5)', async (t) => {
  // Each synthetic routing Run keeps its reservation (no usage report), so allow 60 of them.
  const f = fixture(t, { dailyTokens: 1e9, reservationTokens: 1000, maxActiveRuns: 1 });
  const old = await f.propose(plan([op('QUERY_TASK', { taskId: f.a.taskId })]));
  for (let i = 0; i < 55; i++)
    await f.propose(plan([op('CLARIFY')], 'Which one?'), 'Public newer request ' + i);
  assert.equal(f.store.mainRoutes(f.project.id).length, 50);
  assert.ok(!f.store.mainRoutes(f.project.id).some((r) => r.id === old.id));
  const done = await f.service.commit({
    projectId: f.project.id,
    planId: old.id,
    expectedVersion: old.version,
  });
  assert.equal(done.state, 'completed');
  assert.equal(done.steps[0]!.state, 'completed');
  assert.equal(f.store.mainChat({ projectId: f.project.id }).truncated, true);
});

test('a long input keeps the answer, and a long answer is kept with a marker (L13)', async (t) => {
  const f = fixture(t);
  const route = await f.propose(plan([op('CHAT', { text: 'Public long question' })]));
  f.complete(route.steps[0]!.runId!, 'Public complete answer', 'completed', { input: true });
  await f.service.tick(f.project.id);
  const answered = f.store.routeView(f.project.id, route.id);
  assert.equal(answered.state, 'completed');
  assert.equal(answered.steps[0]!.result, 'Public complete answer');
  const second = await f.propose(plan([op('CHAT', { text: 'Public second question' })]));
  f.complete(second.steps[0]!.runId!, 'Public clipped answer', 'completed', { answer: true });
  await f.service.tick(f.project.id);
  const clipped = f.store.routeView(f.project.id, second.id);
  assert.equal(clipped.state, 'completed');
  assert.match(clipped.steps[0]!.result!, /^Public clipped answer\n\[内容已截断\]$/);
});
