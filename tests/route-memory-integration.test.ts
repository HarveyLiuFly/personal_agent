import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger, LedgerError, hashInput } from '../packages/store/src/ledger.ts';
import type { RunToken } from '../packages/store/src/ledger.ts';
import {
  ChatRouteService,
  routeOutputSchema,
  routeChildKey,
} from '../packages/runtime/src/chat-routes.ts';
import type { ChatRouteProfileRequest } from '../packages/runtime/src/chat-routes.ts';
import { TaskService } from '../packages/runtime/src/tasks.ts';
import type {
  ForegroundExecution,
  ExecutionRoleProfile,
} from '../packages/runtime/src/execution.ts';
import type { RouteOperation, RoutePlan } from '../packages/contracts/src/routing.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
const op = (kind: RouteOperation['kind'], extra: Partial<RouteOperation> = {}): RouteOperation => ({
  kind,
  taskId: null,
  text: null,
  title: null,
  dependsOn: [],
  ...extra,
});
const plan = (operations: RouteOperation[]): RoutePlan => ({
  operations,
  focusTaskId: null,
  question: null,
});
/** Actual SQLite, TaskService and ChatRouteService; accepted Run/Intent/snapshot
 * rows come from a synthetic execution adapter. No RPC, model, GUI or native
 * task success is claimed by these privacy/idempotency integration cases. */
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-route-memory-'))),
    cwd = join(root, 'project'),
    otherCwd = join(root, 'other-project'),
    file = join(root, 'ledger.db');
  mkdirSync(cwd);
  mkdirSync(otherCwd);
  const store = new ExecutionLedger(file, schema, {
    budgetPolicy: { dailyTokens: 10000, reservationTokens: 100 },
  });
  store.startOwner('route-memory-fixture', true);
  const project = store.registerWorkspace(cwd),
    otherProject = store.registerWorkspace(otherCwd),
    db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  const a = store.taskCommand({
      kind: 'create',
      projectId: project.id,
      commandKey: 'public-alpha',
      text: 'PUBLIC_ALPHA',
    }),
    b = store.taskCommand({
      kind: 'create',
      projectId: project.id,
      commandKey: 'public-beta',
      text: 'PUBLIC_BETA',
    }),
    otherTask = store.taskCommand({
      kind: 'create',
      projectId: otherProject.id,
      commandKey: 'public-other-task',
      text: 'PUBLIC_OTHER_PROJECT_TASK',
    }),
    otherGoal = store.applyGoal({
      kind: 'create',
      projectId: otherProject.id,
      commandKey: 'public-other-goal',
      title: 'PUBLIC_OTHER_GOAL',
      objective: 'PUBLIC_OTHER_OBJECTIVE',
      criteria: ['Public evidence'],
    }).goal;
  let busy = false,
    sequence = 0;
  const pending = new Map<string, RunToken>();
  const profile = (request: ChatRouteProfileRequest): ExecutionRoleProfile => ({
    role: request.role,
    developerInstructions: 'Synthetic profile for storage-only integration.',
    contextRefs: [
      {
        ref: request.sourceRefs.find((source) => source.ref.startsWith('message:'))!.ref,
        revision: 'public-context-revision',
      },
      { ref: 'route:' + request.planId, revision: 'public-context-revision' },
    ],
    contextHash: hashInput(request.text),
    ephemeral: true,
    tools: 'none',
    ...(request.role === 'dot-router' ? { outputSchema: routeOutputSchema } : {}),
  });
  const execution = {
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
      const run = store.beginRun(
        input.projectId,
        input.text,
        input.submissionKey,
        'readOnly',
        hashInput(typeof factory === 'function' ? profileKey : factory),
      );
      if (run.created) {
        const role = typeof factory === 'function' ? factory(run.token) : factory;
        store.configureRoleManifest(run.token, role.role, role.contextRefs, role.contextHash);
        pending.set(run.token.runId, run.token);
        busy = true;
      }
      return store.runForHost(run.token.runId);
    },
    continueRun() {
      throw Error('NO_CONTINUATION_IN_THIS_FIXTURE');
    },
    async interrupt() {
      throw Error('NO_ACTIVE_EXECUTION_IN_THIS_FIXTURE');
    },
  };
  const tasks = new TaskService(store, execution as unknown as ForegroundExecution),
    service = new ChatRouteService(store, execution, tasks, { profile });
  const complete = (runId: string, output: string) => {
    const token = pending.get(runId)!;
    assert.ok(token);
    const threadId = 'public-thread-' + runId,
      turnId = 'public-turn-' + runId,
      thread = store.prepare(token, 'thread-' + runId, 'thread_start', {});
    store.sending(token, thread.intentId, 1);
    store.accepted(token, thread.intentId, { threadId });
    const turn = store.prepare(token, 'turn-' + runId, 'turn_start', {}, threadId);
    store.sending(token, turn.intentId, 1);
    store.accepted(token, turn.intentId, { turnId });
    store.saveSnapshot(token, {
      threadId,
      epoch: 1,
      sequence: 1,
      needsSnapshot: false,
      truncated: false,
      unsupportedItems: false,
      turns: [{ id: turnId, status: 'completed' }],
      items: [
        {
          id: 'public-answer-' + runId,
          turnId,
          kind: 'message',
          role: 'assistant',
          label: 'Synthetic proposal',
          text: output,
          status: 'complete',
          truncated: false,
        },
      ],
    });
    store.finish(token, 'completed');
    busy = false;
    pending.delete(runId);
  };
  const propose = async (value: RoutePlan, text: string) => {
    const initial = service.propose({
      projectId: project.id,
      messageId: 'public-origin-' + ++sequence,
      text,
      focusRevision: store.mainChat({ projectId: project.id }).focusRevision,
    });
    complete(initial.routingRunId!, JSON.stringify(value));
    await service.tick(project.id);
    return store.mainRoutes(project.id).find((route) => route.id === initial.id)!;
  };
  t.after(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    db,
    store,
    project,
    otherProject,
    a,
    b,
    otherTask,
    otherGoal,
    service,
    propose,
  };
}
function privateCopiesGone(
  f: ReturnType<typeof fixture>,
  marker: string,
  messageId: string,
  routeId: string,
) {
  const source = f.db
    .prepare('SELECT content,deleted_at_ms FROM messages WHERE message_id=?')
    .get(messageId)!;
  assert.equal(source.content, '');
  assert.notEqual(source.deleted_at_ms, null);
  assert.equal(
    f.db.prepare('SELECT decision_json FROM router_decisions WHERE decision_id=?').get(routeId)!
      .decision_json,
    '{}',
  );
  for (const table of [
    'messages',
    'router_decisions',
    'operations',
    'tasks',
    'goals',
    'task_events',
    'task_checkpoints',
    'prompt_manifests',
    'outbox_events',
  ])
    assert.equal(
      JSON.stringify(f.db.prepare('SELECT * FROM ' + table).all()).includes(marker),
      false,
      table,
    );
  assert.equal(
    f.store.mainRoutes(f.project.id).some((route) => route.id === routeId),
    false,
  );
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
}
for (const kind of ['CREATE_TASK', 'CREATE_GOAL'] as const)
  for (const direction of ['object', 'origin'] as const)
    test(`${kind}: explicitly committed object and original structured-route private copies revoke in both directions (${direction}) without touching another Project`, async (t) => {
      const f = fixture(t),
        marker = 'PUBLIC_ROUTE_' + kind + '_' + direction + '_PRIVATE_COPY',
        route = await f.propose(
          plan([
            op(kind, {
              text: 'Original private objective ' + marker,
              title: kind === 'CREATE_GOAL' ? 'Goal ' + marker : null,
            }),
          ]),
          'Original user source ' + marker,
        );
      assert.equal(route.state, 'proposed');
      assert.equal(f.store.tasks(f.project.id).length, 2);
      assert.equal(f.store.listGoals(f.project.id).length, 0);
      const done = await f.service.commit({
        projectId: f.project.id,
        planId: route.id,
        expectedVersion: route.version,
      });
      assert.equal(done.state, 'completed');
      assert.ok(JSON.stringify(done).includes(marker));
      const createdTask = done.steps[0]!.taskId,
        createdGoal =
          kind === 'CREATE_GOAL'
            ? (JSON.parse(done.steps[0]!.result!) as { goalId: string }).goalId
            : undefined;
      const objectRef = kind === 'CREATE_TASK' ? 'task:' + createdTask : 'goal:' + createdGoal;
      assert.ok(!objectRef.endsWith('undefined'));
      const otherTaskBefore = f.db
          .prepare('SELECT * FROM tasks WHERE task_id=?')
          .get(f.otherTask.taskId),
        otherGoalBefore = f.db
          .prepare('SELECT * FROM goals WHERE goal_id=?')
          .get(f.otherGoal.goalId),
        otherAuditBefore = f.db
          .prepare(
            'SELECT m.*,d.decision_json,o.input_json,o.result_ref FROM messages m JOIN router_decisions d USING(message_id) JOIN operations o USING(decision_id) WHERE o.task_id=?',
          )
          .all(f.otherTask.taskId),
        facts = f.db.prepare('SELECT * FROM execution_intents').all();
      const result = f.store.forgetMemory({
        sourceRefs: [direction === 'origin' ? 'message:' + route.messageId : objectRef],
        expectedPrivacyEpoch: 1,
      });
      assert.ok(result.affectedRefs.includes(objectRef));
      assert.ok(result.affectedRefs.includes('message:' + route.messageId));
      privateCopiesGone(f, marker, route.messageId, route.id);
      if (kind === 'CREATE_TASK')
        assert.equal(
          f.store.tasks(f.project.id).some((task) => task.taskId === createdTask),
          false,
        );
      else
        assert.equal(
          f.store.listGoals(f.project.id).some((goal) => goal.goalId === createdGoal),
          false,
        );
      assert.deepEqual(
        f.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(f.otherTask.taskId),
        otherTaskBefore,
      );
      assert.deepEqual(
        f.db.prepare('SELECT * FROM goals WHERE goal_id=?').get(f.otherGoal.goalId),
        otherGoalBefore,
      );
      assert.deepEqual(
        f.db
          .prepare(
            'SELECT m.*,d.decision_json,o.input_json,o.result_ref FROM messages m JOIN router_decisions d USING(message_id) JOIN operations o USING(decision_id) WHERE o.task_id=?',
          )
          .all(f.otherTask.taskId),
        otherAuditBefore,
      );
      assert.deepEqual(f.db.prepare('SELECT * FROM execution_intents').all(), facts);
      assert.ok(
        f.store.tasks(f.otherProject.id).some((task) => task.taskId === f.otherTask.taskId),
      );
      assert.ok(
        f.store.listGoals(f.otherProject.id).some((goal) => goal.goalId === f.otherGoal.goalId),
      );
    });
test('Correction retries the same message before stale Focus CAS and never rewrites a later Focus or creates another audit', async (t) => {
  const f = fixture(t),
    route = await f.propose(
      plan([op('UPDATE_TASK', { taskId: f.a.taskId, title: 'Must remain a proposal' })]),
      'Public correction fixture',
    ),
    input = {
      projectId: f.project.id,
      planId: route.id,
      taskId: f.b.taskId,
      messageId: 'public-correction-message',
      focusRevision: f.store.mainChat({ projectId: f.project.id }).focusRevision,
    },
    corrected = f.service.correct(input);
  assert.equal(corrected.state, 'corrected');
  assert.equal(corrected.steps[0]!.state, 'cancelled');
  const firstFocus = f.store.mainChat({ projectId: f.project.id });
  assert.equal(firstFocus.focus!.task.taskId, f.b.taskId);
  assert.equal(firstFocus.focusRevision, input.focusRevision + 1);
  const firstRows = f.db.prepare('SELECT * FROM focus_states').all(),
    messageCount = f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n;
  assert.deepEqual(f.service.correct(input), corrected);
  assert.deepEqual(f.db.prepare('SELECT * FROM focus_states').all(), firstRows);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n, messageCount);
  f.store.submitMainChat({
    projectId: f.project.id,
    messageId: 'public-later-focus-message',
    text: '/query',
    taskId: f.a.taskId,
    focusRevision: firstFocus.focusRevision,
  });
  const laterFocus = f.db.prepare('SELECT * FROM focus_states').all(),
    afterMessages = f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n;
  assert.equal(f.store.mainChat({ projectId: f.project.id }).focus!.task.taskId, f.a.taskId);
  assert.deepEqual(f.service.correct(input), corrected);
  assert.deepEqual(f.db.prepare('SELECT * FROM focus_states').all(), laterFocus);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n, afterMessages);
  assert.throws(() => f.service.correct({ ...input, taskId: f.a.taskId }), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(f.db.prepare('SELECT * FROM focus_states').all(), laterFocus);
  assert.equal(f.store.routeQuery(f.project.id, f.a.taskId).title, 'PUBLIC_ALPHA');
  assert.equal(
    f.store.tasks(f.otherProject.id).find((task) => task.taskId === f.otherTask.taskId)!.title,
    'PUBLIC_OTHER_PROJECT_TASK',
  );
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
for (const kind of ['CREATE_TASK', 'CREATE_GOAL'] as const)
  test(`${kind}: committed creation retains origin privacy provenance when the parent Step receipt update fails`, async (t) => {
    const f = fixture(t),
      marker = 'PUBLIC_ROUTE_RECEIPT_FAILURE_' + kind,
      route = await f.propose(
        plan([
          op(kind, {
            text: 'Private creation before receipt ' + marker,
            title: kind === 'CREATE_GOAL' ? 'Private goal ' + marker : null,
          }),
        ]),
        'Original creation request ' + marker,
      ),
      tasksBefore = f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n,
      goalsBefore = f.db.prepare('SELECT count(*) AS n FROM goals').get()!.n;
    // Abort only the parent completion update, after the separate real creation
    // transaction has committed. Forget's {} redaction does not match this guard.
    f.db.exec(
      "CREATE TRIGGER public_fail_parent_route_receipt BEFORE UPDATE ON router_decisions WHEN NEW.decision_id='" +
        route.id +
        "' AND json_extract(NEW.decision_json,'$.route.steps[0].state')='completed' BEGIN SELECT RAISE(ABORT,'PUBLIC_PARENT_RECEIPT_NOT_SAVED'); END",
    );
    const interrupted = await f.service.commit({
      projectId: f.project.id,
      planId: route.id,
      expectedVersion: route.version,
    });
    assert.ok(['committing', 'outcome_unknown'].includes(interrupted.state));
    assert.ok(['executing', 'outcome_unknown'].includes(interrupted.steps[0]!.state));
    const createdTask =
        kind === 'CREATE_TASK'
          ? f.store.tasks(f.project.id).find((task) => task.title.includes(marker))?.taskId
          : undefined,
      createdGoal =
        kind === 'CREATE_GOAL'
          ? f.store.listGoals(f.project.id).find((goal) => goal.objective.includes(marker))?.goalId
          : undefined,
      objectRef = kind === 'CREATE_TASK' ? 'task:' + createdTask : 'goal:' + createdGoal;
    assert.equal(objectRef.endsWith('undefined'), false);
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n,
      Number(tasksBefore) + (kind === 'CREATE_TASK' ? 1 : 0),
    );
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM goals').get()!.n,
      Number(goalsBefore) + (kind === 'CREATE_GOAL' ? 1 : 0),
    );
    if (kind === 'CREATE_GOAL') {
      const recovered = f.store.routeChildResult(f.project.id, routeChildKey(route.id, 0));
      assert.ok(recovered.domain);
      assert.equal(JSON.parse(recovered.domain.result).goalId, createdGoal);
    }
    await f.service.tick();
    await f.service.tick();
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n,
      Number(tasksBefore) + (kind === 'CREATE_TASK' ? 1 : 0),
    );
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM goals').get()!.n,
      Number(goalsBefore) + (kind === 'CREATE_GOAL' ? 1 : 0),
    );
    const counts = {
        tasks: f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n,
        goals: f.db.prepare('SELECT count(*) AS n FROM goals').get()!.n,
        operations: f.db.prepare('SELECT count(*) AS n FROM operations').get()!.n,
      },
      facts = f.db.prepare('SELECT * FROM execution_intents').all(),
      otherBefore = f.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(f.otherTask.taskId);
    const result = f.store.forgetMemory({
      sourceRefs: ['message:' + route.messageId],
      expectedPrivacyEpoch: 1,
    });
    assert.ok(result.affectedRefs.includes(objectRef));
    privateCopiesGone(f, marker, route.messageId, route.id);
    if (createdTask)
      assert.equal(
        f.store.tasks(f.project.id).some((task) => task.taskId === createdTask),
        false,
      );
    if (createdGoal)
      assert.equal(
        f.store.listGoals(f.project.id).some((goal) => goal.goalId === createdGoal),
        false,
      );
    f.db.exec('DROP TRIGGER public_fail_parent_route_receipt');
    await f.service.tick();
    await f.service.tick();
    await assert.rejects(
      f.service.commit({
        projectId: f.project.id,
        planId: route.id,
        expectedVersion: route.version,
      }),
      /ROUTE_PLAN_UNAVAILABLE/,
    );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, counts.tasks);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM goals').get()!.n, counts.goals);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM operations').get()!.n, counts.operations);
    assert.deepEqual(f.db.prepare('SELECT * FROM execution_intents').all(), facts);
    assert.deepEqual(
      f.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(f.otherTask.taskId),
      otherBefore,
    );
  });
