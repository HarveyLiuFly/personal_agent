import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger, LedgerError } from '../packages/store/src/ledger.ts';
import { GoalLedger } from '../packages/store/src/goals.ts';
import type {
  GoalCommand,
  GoalPlanTask,
  TrustedSourceEnvelope,
  GoalNotificationPolicy,
} from '../packages/contracts/src/goals.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8'),
  hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const epochStart = Date.parse('2026-11-03T01:30:00Z');
function fixture(
  t: { after(fn: () => void): void },
  budgetPolicy?: { dailyTokens: number; reservationTokens: number },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-goals-'))),
    cwd = join(root, 'project');
  mkdirSync(cwd);
  const file = join(root, 'ledger.db'),
    store = new ExecutionLedger(file, schema, budgetPolicy ? { budgetPolicy } : {});
  store.startOwner('goal-test-owner', true);
  const project = store.registerWorkspace(cwd, cwd),
    db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=1000;');
  let now = epochStart,
    verified = true,
    failAfter = 0,
    created = 0;
  const owner = () => {
      if (db.prepare('SELECT state FROM runtime_owners').get()?.state !== 'ready')
        throw new LedgerError('STALE_RUNTIME_OWNER');
    },
    tx = <T>(work: () => T): T => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };
  const module = new GoalLedger(
    db,
    store.dotId,
    (code) => {
      throw new LedgerError(code);
    },
    {
      owner,
      tx,
      now: () => now,
      verifySource: () => verified,
      createTaskInTransaction: (projectId, text, key, goalId, code) => {
        created++;
        if (failAfter && created === failAfter) throw Error('CONTROLLED_PLAN_FAILURE');
        const taskId = randomUUID(),
          dot = db.prepare('SELECT policy_epoch,privacy_epoch FROM dots').get()!,
          constraints = {
            text,
            inputHash: hash([text, key]),
            mode: code ? 'workspaceWrite' : 'readOnly',
            policyEpoch: dot.policy_epoch,
            privacyEpoch: dot.privacy_epoch,
            ...(code ? { code } : {}),
          };
        db.prepare(
          "INSERT INTO tasks(task_id,dot_id,goal_id,workspace_id,title,constraints_json,status,version,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,'queued',2,?,?)",
        ).run(
          taskId,
          store.dotId,
          goalId,
          projectId,
          text.slice(0, 120),
          JSON.stringify(constraints),
          now,
          now,
        );
        return { taskId, version: 2 };
      },
      scheduleInTransaction: (_p, taskId, _version, key, config) => {
        db.prepare(
          "INSERT INTO schedules VALUES (?,?,1,'once',?,'UTC','active','coalesce','coalesce',1,?,?)",
        ).run(key, taskId, JSON.stringify(config), now + 60000, now + 120000);
        db.prepare(
          "UPDATE tasks SET status='waiting_trigger',version=version+1 WHERE task_id=?",
        ).run(taskId);
      },
      verifyGoalEvidence: (_goalId, taskIds, ids) =>
        taskIds.every((taskId) =>
          ids.some((id) => {
            const v = db
              .prepare(
                'SELECT v.*,r.task_id,a.content_sha256,a.relative_storage_key,a.state AS artifact_state FROM verification_results v JOIN task_runs r USING(run_id) JOIN artifacts a ON a.artifact_id=v.evidence_ref WHERE v.verification_id=?',
              )
              .get(id);
            return Boolean(
              v &&
              v.task_id === taskId &&
              v.status === 'passed' &&
              Number(v.executed_count) > 0 &&
              v.skipped_count === 0 &&
              v.artifact_state === 'published' &&
              createHash('sha256')
                .update(readFileSync(join(root, String(v.relative_storage_key))))
                .digest('hex') === v.content_sha256,
            );
          }),
        ),
      event: (taskId, type, payload) => {
        db.prepare(
          'UPDATE tasks SET last_event_sequence=last_event_sequence+1 WHERE task_id=?',
        ).run(taskId);
        const task = db
          .prepare('SELECT version,last_event_sequence FROM tasks WHERE task_id=?')
          .get(taskId)!;
        db.prepare('INSERT INTO task_events VALUES (?,?,NULL,?,?,?,NULL,NULL,?,?)').run(
          randomUUID(),
          taskId,
          task.last_event_sequence!,
          task.version!,
          type,
          JSON.stringify(payload),
          now,
        );
      },
    },
  );
  t.after(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const create = (key = 'goal', policy?: GoalNotificationPolicy) =>
    module.apply({
      kind: 'create',
      commandKey: key,
      projectId: project.id,
      title: 'PUBLIC_GOAL',
      objective: 'Repair the public fixture with independent checks',
      criteria: ['frozen cases pass'],
      ...(policy ? { notificationPolicy: policy } : {}),
    }).goal;
  const plan = (goalId: string, tasks: GoalPlanTask[]) => {
    const g = module.view(goalId);
    return module.apply({
      kind: 'plan',
      commandKey: 'plan-' + randomUUID(),
      goalId,
      expectedVersion: g.version,
      expectedPlanVersion: g.planVersion,
      tasks,
    });
  };
  const bind = () =>
    module.bindSourceTrusted({
      sourceId: 'public-source',
      bindingRef: 'trusted-binding',
      allowedActors: ['verified-user', 'self-bot'],
      selfActor: 'self-bot',
      eventTypes: ['issue.changed'],
      maxAgeMs: 60000,
    });
  const envelope = (key = 'event-1', actorRef = 'verified-user'): TrustedSourceEnvelope => ({
    bindingRef: 'trusted-binding',
    verificationRef: 'verified-http-response',
    actorRef,
    events: [
      {
        id: key,
        threadRef: 'thread-public',
        eventType: 'issue.changed',
        occurredAtMs: now,
        payloadRef: 'public-payload-' + key,
        payloadSha256: hash(key),
      },
    ],
    cursor: { after: key },
  });
  const subscription = () => ({
    sourceId: 'public-source',
    threadRef: 'thread-public',
    purpose: 'wake' as const,
    eventTypes: ['issue.changed'],
    expiresAtMs: now + 300000,
  });
  const completeTask = (taskId: string) => {
    const runId = randomUUID(),
      specId = randomUUID(),
      artifact = randomUUID(),
      content = '{"synthetic_verifier_metadata":true,"status":"passed"}\n',
      key = artifact + '.json';
    writeFileSync(join(root, key), content);
    db.prepare("UPDATE tasks SET status='completed',write_fence=1 WHERE task_id=?").run(taskId);
    db.prepare(
      "INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES (?,?,?,?,'codex','completed',2,1,1,1,1,'fixture',1,?)",
    ).run(runId, taskId, store.dotId, 'fixture-' + runId, now);
    db.prepare("INSERT INTO verification_specs VALUES (?,?,1,NULL,'[]','[]','{}',?)").run(
      specId,
      taskId,
      '0'.repeat(64),
    );
    db.prepare("INSERT INTO artifacts VALUES (?,?,?,?,?,'published','private',1,?,NULL)").run(
      artifact,
      store.dotId,
      taskId,
      createHash('sha256').update(content).digest('hex'),
      key,
      Buffer.byteLength(content),
    );
    db.prepare("INSERT INTO verification_results VALUES (?,?,?,'passed',1,1,0,?,?)").run(
      artifact,
      runId,
      specId,
      artifact,
      now,
    );
    return artifact;
  };
  return {
    root,
    store,
    project,
    db,
    module,
    create,
    plan,
    bind,
    envelope,
    subscription,
    completeTask,
    clock: (v: number) => {
      now = v;
    },
    verified: (v: boolean) => {
      verified = v;
    },
    failOnTask: (n: number) => {
      created = 0;
      failAfter = n;
    },
  };
}
test('Goal create and versioned commands are durable and idempotent without starting any model task', (t) => {
  const f = fixture(t),
    g = f.create(),
    same = f.create();
  assert.equal(g.goalId, same.goalId);
  assert.equal(g.requiresPlan, true);
  assert.throws(
    () =>
      f.module.apply({
        kind: 'create',
        commandKey: 'goal',
        projectId: f.project.id,
        title: 'different',
        objective: 'different',
        criteria: ['different'],
      }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () =>
      f.module.apply({ kind: 'pause', commandKey: 'stale', goalId: g.goalId, expectedVersion: 99 }),
    /GOAL_VERSION_CONFLICT/,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 0);
});
test('plan commits dependency DAG, code contract passthrough and fresh tasks atomically', (t) => {
  const f = fixture(t),
    g = f.create(),
    p = f.plan(g.goalId, [
      { key: 'second', text: 'PUBLIC_SECOND', dependsOn: ['first'] },
      {
        key: 'first',
        text: 'PUBLIC_FIRST',
        dependsOn: [],
        code: { profile: 'node-test', target: 'test.mjs', allowedPaths: ['src.mjs'] },
      },
    ]);
  assert.equal(p.goal.planVersion, 2);
  assert.equal(p.taskIds.length, 2);
  const first = f.db.prepare("SELECT * FROM tasks WHERE title='PUBLIC_FIRST'").get()!,
    second = f.db.prepare("SELECT * FROM tasks WHERE title='PUBLIC_SECOND'").get()!;
  assert.equal(JSON.parse(String(first.constraints_json)).code.target, 'test.mjs');
  assert.equal(second.status, 'waiting_trigger');
  assert.deepEqual(JSON.parse(String(second.constraints_json)).goalDependencies, [first.task_id]);
  assert.equal(f.module.advance().queued, 0);
  f.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(first.task_id!);
  assert.equal(f.module.advance().queued, 1);
  assert.equal(f.module.advance().queued, 0);
});
test('cyclic or failed Plan Diff has no partial Task, Goal version or operation effect', (t) => {
  const f = fixture(t),
    g = f.create(),
    before = f.db.prepare('SELECT count(*) AS n FROM operations').get()!.n;
  assert.throws(
    () =>
      f.plan(g.goalId, [
        { key: 'a', text: 'a', dependsOn: ['b'] },
        { key: 'b', text: 'b', dependsOn: ['a'] },
      ]),
    /GOAL_PLAN_CYCLE/,
  );
  f.failOnTask(2);
  assert.throws(
    () =>
      f.plan(g.goalId, [
        { key: 'a', text: 'a', dependsOn: [] },
        { key: 'b', text: 'b', dependsOn: [] },
      ]),
    /CONTROLLED_PLAN_FAILURE/,
  );
  assert.equal(f.module.view(g.goalId).version, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM operations').get()!.n, before);
});
test('trusted Source authenticates the verified envelope, not payload actor labels; cursor and immutable events dedupe', (t) => {
  const f = fixture(t);
  f.bind();
  const g = f.create();
  f.plan(g.goalId, [
    { key: 'listen', text: 'PUBLIC_LISTENER', dependsOn: [], subscription: f.subscription() },
  ]);
  f.verified(false);
  assert.throws(
    () => f.module.ingestTrusted('public-source', f.envelope()),
    /SOURCE_IDENTITY_REJECTED/,
  );
  f.verified(true);
  assert.throws(
    () => f.module.ingestTrusted('public-source', f.envelope('attacker', 'unknown-actor')),
    /SOURCE_IDENTITY_REJECTED/,
  );
  const first = f.module.ingestTrusted('public-source', f.envelope()),
    same = f.module.ingestTrusted('public-source', f.envelope());
  assert.equal(first.deliveries, 1);
  assert.equal(same.duplicates, 1);
  assert.equal(f.module.sourceEvents('public-source')[0]!.payloadRef, 'public-payload-event-1');
  assert.equal(f.module.sourceEvents('public-source')[0]!.eventType, 'issue.changed');
  assert.deepEqual(first.triggerIds, same.triggerIds);
  const newType = f.envelope();
  f.db
    .prepare(
      'UPDATE sources SET cursor_json=json_set(cursor_json,\'$.binding.eventTypes\',json(\'["issue.changed","issue.other"]\'))',
    )
    .run();
  newType.events[0]!.eventType = 'issue.other';
  assert.throws(() => f.module.ingestTrusted('public-source', newType), /SOURCE_EVENT_CONFLICT/);
  const bad = f.envelope();
  bad.events[0]!.payloadSha256 = 'f'.repeat(64);
  assert.throws(() => f.module.ingestTrusted('public-source', bad), /SOURCE_EVENT_CONFLICT/);
  assert.throws(
    () => f.db.prepare("UPDATE incoming_triggers SET actor_ref='forged'").run(),
    /immutable/,
  );
  assert.equal(
    JSON.parse(String(f.db.prepare('SELECT cursor_json FROM sources').get()!.cursor_json)).cursor
      .after,
    'event-1',
  );
});
test('one incoming event receives separate Task deliveries and each wake is acknowledged only once', (t) => {
  const f = fixture(t);
  f.bind();
  const g = f.create(),
    p = f.plan(g.goalId, [
      { key: 'a', text: 'PUBLIC_A', dependsOn: [], subscription: f.subscription() },
      { key: 'b', text: 'PUBLIC_B', dependsOn: [], subscription: f.subscription() },
    ]);
  assert.equal(f.module.ingestTrusted('public-source', f.envelope()).deliveries, 2);
  assert.deepEqual(f.module.deliver(), { acknowledged: 2, queued: 2, ignored: 0 });
  assert.deepEqual(f.module.deliver(), { acknowledged: 0, queued: 0, ignored: 0 });
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM trigger_deliveries WHERE state='acknowledged'").get()!
      .n,
    2,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 0);
  assert.ok(
    p.taskIds.every(
      (id) => f.db.prepare('SELECT status FROM tasks WHERE task_id=?').get(id)!.status === 'queued',
    ),
  );
});
test('self echoes, wrong threads and untrusted event types never wake a task', (t) => {
  const f = fixture(t);
  f.bind();
  const g = f.create();
  f.plan(g.goalId, [{ key: 'a', text: 'PUBLIC_A', dependsOn: [], subscription: f.subscription() }]);
  assert.equal(f.module.ingestTrusted('public-source', f.envelope('self', 'self-bot')).ignored, 1);
  const wrong = f.envelope('wrong-thread');
  wrong.events[0]!.threadRef = 'other-thread';
  assert.equal(f.module.ingestTrusted('public-source', wrong).deliveries, 0);
  const invalid = f.envelope('invalid');
  invalid.events[0]!.eventType = 'admin.override';
  assert.throws(() => f.module.ingestTrusted('public-source', invalid), /SOURCE_EVENT_REJECTED/);
  assert.equal(f.module.deliver().queued, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 0);
});
test('Goal revise stops subscriptions, schedules, old grants and pending wake in the same transaction', (t) => {
  const f = fixture(t);
  f.bind();
  const g = f.create(),
    p = f.plan(g.goalId, [
      { key: 'source', text: 'PUBLIC_SOURCE', dependsOn: [], subscription: f.subscription() },
      { key: 'timer', text: 'PUBLIC_TIMER', dependsOn: [], schedule: { public: true } },
    ]);
  f.module.ingestTrusted('public-source', f.envelope());
  const changed = f.module.apply({
    kind: 'revise',
    commandKey: 'revise',
    goalId: g.goalId,
    expectedVersion: p.goal.version,
    objective: 'PUBLIC_REVISED',
    criteria: ['new frozen cases'],
  });
  assert.equal(changed.goal.status, 'paused');
  assert.equal(changed.goal.planVersion, p.goal.planVersion + 1);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM subscriptions WHERE state='active'").get()!.n,
    0,
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM mandates WHERE state='active'").get()!.n, 0);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM schedules WHERE state='active'").get()!.n,
    0,
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM trigger_deliveries WHERE state IN ('pending','claimed')")
      .get()!.n,
    0,
  );
  assert.equal(f.module.deliver().queued, 0);
  assert.equal(
    f.db.prepare('SELECT count(*) AS n FROM tasks WHERE dispatch_blocked=1').get()!.n,
    2,
  );
});
test('pausing an active Goal only blocks its Run and returns its identity; it never invents a stopped process', (t) => {
  const f = fixture(t),
    g = f.create(),
    p = f.plan(g.goalId, [{ key: 'a', text: 'PUBLIC_A', dependsOn: [] }]),
    task = f.db.prepare('SELECT version FROM tasks WHERE task_id=?').get(p.taskIds[0]!)!,
    run = f.store.claimTask(
      f.project.id,
      p.taskIds[0]!,
      Number(task.version),
      'prepared-only-no-model',
    );
  const paused = f.module.apply({
    kind: 'pause',
    commandKey: 'pause',
    goalId: g.goalId,
    expectedVersion: p.goal.version,
  });
  assert.deepEqual(paused.affectedRunIds, [run.token.runId]);
  assert.equal(
    f.db.prepare('SELECT status FROM task_runs WHERE run_id=?').get(run.token.runId)!.status,
    'preparing',
  );
  assert.equal(
    f.db.prepare('SELECT dispatch_blocked FROM tasks WHERE task_id=?').get(p.taskIds[0]!)!
      .dispatch_blocked,
    1,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 0);
});
test('changed policy or privacy prevents an old Mandate from queuing work', (t) => {
  const f = fixture(t);
  f.bind();
  const g = f.create();
  f.plan(g.goalId, [
    { key: 'source', text: 'PUBLIC_SOURCE', dependsOn: [], subscription: f.subscription() },
  ]);
  f.module.ingestTrusted('public-source', f.envelope());
  f.db.exec('UPDATE dots SET privacy_epoch=2');
  assert.deepEqual(f.module.deliver(), { acknowledged: 0, queued: 0, ignored: 1 });
  assert.equal(
    f.db.prepare('SELECT reason_code FROM trigger_deliveries').get()!.reason_code,
    'MANDATE_NOT_CURRENT',
  );
});
test('Goal completion requires all planned Tasks and trusted published receipt hash checks, not Run status or a passed word', (t) => {
  const f = fixture(t),
    g = f.create(),
    p = f.plan(g.goalId, [{ key: 'a', text: 'PUBLIC_A', dependsOn: [] }]);
  assert.throws(
    () =>
      f.module.apply({
        kind: 'complete',
        commandKey: 'premature',
        goalId: g.goalId,
        expectedVersion: p.goal.version,
        verificationIds: ['passed'],
      }),
    /GOAL_VERIFICATION_REQUIRED/,
  );
  const receipt = f.completeTask(p.taskIds[0]!);
  assert.throws(
    () =>
      f.module.apply({
        kind: 'complete',
        commandKey: 'wrong',
        goalId: g.goalId,
        expectedVersion: p.goal.version,
        verificationIds: ['passed'],
      }),
    /GOAL_VERIFICATION_REQUIRED/,
  );
  const complete = f.module.apply({
    kind: 'complete',
    commandKey: 'complete',
    goalId: g.goalId,
    expectedVersion: p.goal.version,
    verificationIds: [receipt],
  });
  assert.equal(complete.goal.status, 'completed');
  assert.equal(
    f.db.prepare('SELECT status FROM tasks WHERE task_id=?').get(p.taskIds[0]!)!.status,
    'completed',
  );
});
test('notifications are explicit opt-in, deduplicated, quiet and budgeted independently from Task execution', (t) => {
  const f = fixture(t),
    off = f.create('off');
  assert.equal(f.module.queueNotification(off.goalId, 'n', 'result', 'PUBLIC_RESULT'), null);
  const g = f.create('on', {
      enabled: true,
      dailyLimit: 1,
      quietStartMinute: 60,
      quietEndMinute: 120,
    }),
    n = f.module.queueNotification(g.goalId, 'stable', 'result', 'PUBLIC_RESULT')!;
  assert.equal(
    f.module.queueNotification(g.goalId, 'stable', 'result', 'PUBLIC_RESULT')!.operationId,
    n.operationId,
  );
  assert.equal(f.module.claimNotification(), null);
  f.clock(epochStart + 30 * 60000);
  const claim = f.module.claimNotification()!;
  assert.equal(claim.operationId, n.operationId);
  assert.equal(
    f.module.finishNotification(claim, {
      state: 'delivered',
      providerRef: 'public-provider-receipt',
    }).state,
    'delivered',
  );
  f.module.queueNotification(g.goalId, 'next', 'change', 'PUBLIC_CHANGE');
  assert.equal(f.module.claimNotification(), null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 0);
});
test('an old sending notification becomes Unknown after Owner restart and is never automatically resent', (t) => {
  const f = fixture(t),
    g = f.create('on', { enabled: true, dailyLimit: 5, quietStartMinute: 0, quietEndMinute: 0 }),
    n = f.module.queueNotification(g.goalId, 'once', 'result', 'PUBLIC_RESULT')!,
    claim = f.module.claimNotification()!;
  f.db.exec('UPDATE runtime_owners SET runtime_epoch=runtime_epoch+1');
  assert.equal(f.module.recoverNotifications(), 1);
  assert.equal(f.module.notifications(g.goalId)[0]!.state, 'unknown');
  assert.equal(f.module.claimNotification(), null);
  assert.throws(
    () =>
      f.module.finishNotification(claim, { state: 'delivered', providerRef: 'late-old-receipt' }),
    /STALE_NOTIFICATION_CLAIM/,
  );
  assert.equal(
    f.module.queueNotification(g.goalId, 'once', 'result', 'PUBLIC_RESULT')!.operationId,
    n.operationId,
  );
});
test('Goal cancellation cancels unsent notifications and child subscriptions without claiming delivery', (t) => {
  const f = fixture(t),
    g = f.create('on', { enabled: true, dailyLimit: 5, quietStartMinute: 0, quietEndMinute: 0 });
  f.module.queueNotification(g.goalId, 'once', 'result', 'PUBLIC_RESULT');
  f.module.apply({
    kind: 'cancel',
    commandKey: 'cancel',
    goalId: g.goalId,
    expectedVersion: g.version,
  });
  assert.equal(f.module.notifications(g.goalId)[0]!.state, 'cancelled');
  assert.equal(f.module.claimNotification(), null);
});
test('raw paths, unknown fields and foreign project commands are rejected before any Goal is created', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.module.apply({
        kind: 'create',
        commandKey: 'raw',
        projectId: f.project.id,
        title: 'x',
        objective: 'x',
        criteria: ['x'],
        path: '/tmp',
      } as unknown as GoalCommand),
    /INVALID_GOAL_COMMAND/,
  );
  assert.throws(
    () =>
      f.module.apply({
        kind: 'create',
        commandKey: 'foreign',
        projectId: 'foreign',
        title: 'x',
        objective: 'x',
        criteria: ['x'],
      }),
    /GOAL_PROJECT_UNAVAILABLE/,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM goals').get()!.n, 0);
});
test('a partially invalid verified batch rolls back all events and cursor advancement', (t) => {
  const f = fixture(t);
  f.bind();
  const batch = f.envelope('valid');
  batch.events.push({ ...batch.events[0]!, id: 'bad', eventType: 'untrusted.event' });
  assert.throws(() => f.module.ingestTrusted('public-source', batch), /SOURCE_EVENT_REJECTED/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM incoming_triggers').get()!.n, 0);
  assert.equal(
    JSON.parse(String(f.db.prepare('SELECT cursor_json FROM sources').get()!.cursor_json)).cursor,
    null,
  );
});
test('notification failures trip the independent daily circuit after three actual claims', (t) => {
  const f = fixture(t),
    g = f.create('circuit', {
      enabled: true,
      dailyLimit: 5,
      quietStartMinute: 0,
      quietEndMinute: 0,
    });
  for (let i = 0; i < 4; i++)
    f.module.queueNotification(g.goalId, 'notice-' + i, 'failure', 'PUBLIC_FAILURE_' + i);
  for (let i = 0; i < 3; i++) {
    const claim = f.module.claimNotification();
    assert.ok(claim);
    f.module.finishNotification(claim, { state: 'failed', providerRef: 'failed-' + i });
  }
  assert.equal(f.module.claimNotification(), null);
  assert.equal(f.module.notifications(g.goalId).filter((n) => n.state === 'pending').length, 1);
});
test('notification derivation and audit preserve trust, and a privacy advance clears stored private summaries without inventing delivery', (t) => {
  const f = fixture(t),
    g = f.create('privacy', {
      enabled: true,
      dailyLimit: 5,
      quietStartMinute: 0,
      quietEndMinute: 0,
    }),
    n = f.module.queueNotification(g.goalId, 'private', 'result', 'PUBLIC_SECRET_TO_ERASE', [
      { ref: 'source:private-entry', revision: 'v1' },
    ])!,
    claim = f.module.claimNotification()!;
  assert.equal(
    f.db
      .prepare(
        'SELECT role FROM messages m JOIN router_decisions d USING(message_id) JOIN operations o USING(decision_id) WHERE o.operation_id=?',
      )
      .get(n.operationId)!.role,
    'system_event',
  );
  assert.equal(
    f.db
      .prepare('SELECT derived_ref FROM derivation_edges WHERE source_ref=?')
      .get('source:private-entry')!.derived_ref,
    'notification:' + n.operationId,
  );
  f.db.exec('UPDATE dots SET privacy_epoch=2');
  assert.equal(f.module.purgeStaleNotifications(), 1);
  const after = f.module.notifications(g.goalId)[0]!;
  assert.equal(after.summary, '');
  assert.equal(after.redacted, true);
  assert.equal(after.state, 'unknown');
  assert.equal(f.module.claimNotification(), null);
  const stored = JSON.stringify(
    f.db
      .prepare(
        'SELECT o.input_json,m.content FROM operations o JOIN router_decisions d USING(decision_id) JOIN messages m USING(message_id) WHERE operation_id=?',
      )
      .get(n.operationId),
  );
  assert.equal(stored.includes('PUBLIC_SECRET_TO_ERASE'), false);
  assert.throws(
    () => f.module.finishNotification(claim, { state: 'delivered', providerRef: 'late' }),
    /STALE_NOTIFICATION_CLAIM/,
  );
});
test('standalone Task stop atomically cancels its pending wake and revokes only its subscription scope', (t) => {
  const f = fixture(t);
  f.bind();
  const g = f.create(),
    p = f.plan(g.goalId, [
      { key: 'a', text: 'PUBLIC_A', dependsOn: [], subscription: f.subscription() },
      { key: 'b', text: 'PUBLIC_B', dependsOn: [], subscription: f.subscription() },
    ]);
  f.module.ingestTrusted('public-source', f.envelope());
  f.module.stopTask(p.taskIds[0]!);
  assert.deepEqual(f.module.deliver(), { acknowledged: 1, queued: 1, ignored: 0 });
  assert.equal(
    f.db.prepare('SELECT state FROM subscriptions WHERE task_id=?').get(p.taskIds[0]!)!.state,
    'cancelled',
  );
  assert.equal(
    f.db.prepare('SELECT state FROM subscriptions WHERE task_id=?').get(p.taskIds[1]!)!.state,
    'active',
  );
});

test('Goal budget configuration is validated and a revision lowers current buckets without freeing Unknown occupancy', (t) => {
  const f = fixture(t),
    g = f.create();
  assert.equal(g.budgetTokens, 100000);
  for (const amount of [0, -1, 1.5, 1000000001])
    assert.throws(
      () =>
        f.module.apply({
          kind: 'create',
          commandKey: 'bad-budget-' + amount,
          projectId: f.project.id,
          title: 'PUBLIC',
          objective: 'PUBLIC',
          criteria: ['PUBLIC'],
          budgetTokens: amount,
        }),
      /INVALID_GOAL_BUDGET/,
    );
  const p = f.plan(g.goalId, [{ key: 'a', text: 'PUBLIC_A', dependsOn: [] }]),
    task = f.db.prepare('SELECT version FROM tasks WHERE task_id=?').get(p.taskIds[0]!)!,
    run = f.store.claimTask(
      f.project.id,
      p.taskIds[0]!,
      Number(task.version),
      'public-budget-unknown',
    );
  f.store.uncertain(run.token);
  const before = f.db
    .prepare(
      'SELECT period_start_ms,reserved_units,consumed_units FROM budget_buckets WHERE goal_id=?',
    )
    .get(g.goalId)!;
  f.clock(Number(before.period_start_ms) + 1);
  const changed = f.module.apply({
    kind: 'revise',
    commandKey: 'lower-budget',
    goalId: g.goalId,
    expectedVersion: p.goal.version,
    objective: 'PUBLIC_REVISED',
    criteria: ['new checks'],
    budgetTokens: 20,
  });
  assert.equal(changed.goal.budgetTokens, 20);
  const after = f.db
    .prepare('SELECT limit_units,reserved_units,consumed_units FROM budget_buckets WHERE goal_id=?')
    .get(g.goalId)!;
  assert.equal(after.limit_units, 20);
  assert.equal(after.reserved_units, before.reserved_units);
  assert.equal(after.consumed_units, before.consumed_units);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM budget_reservations WHERE run_id=? AND state='held_unknown'",
      )
      .get(run.token.runId)!.n,
    2,
  );
});

test('the default Goal quota is bounded by the current global policy and absent legacy declarations remain explicit unknown', (t) => {
  const f = fixture(t, { dailyTokens: 90, reservationTokens: 60 }),
    g = f.create();
  assert.equal(g.budgetTokens, 90);
  f.db
    .prepare(
      "UPDATE goals SET constraints_json=json_remove(constraints_json,'$.budgetTokens') WHERE goal_id=?",
    )
    .run(g.goalId);
  assert.equal(f.module.view(g.goalId).budgetTokens, null);
});
test('Goal automatic execution is explicit per Plan Task; queue-only and malformed dispatch never acquire candidates', (t) => {
  const f = fixture(t),
    g = f.create(),
    p = f.plan(g.goalId, [
      { key: 'manual', text: 'PUBLIC_MANUAL', dependsOn: [] },
      { key: 'auto', text: 'PUBLIC_AUTOMATIC', dependsOn: [], dispatch: 'execute_once' },
    ]);
  const candidates = f.module.dispatchCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.taskId, p.taskIds[1]);
  assert.equal(candidates[0]!.projectId, f.project.id);
  assert.match(candidates[0]!.submissionKey, /^goal-dispatch:[a-f0-9]{64}$/);
  assert.deepEqual(f.module.dispatchCandidates(), candidates);
  assert.throws(
    () =>
      f.plan(g.goalId, [
        {
          key: 'scheduled',
          text: 'PUBLIC_SCHEDULED',
          dependsOn: [],
          dispatch: 'execute_once',
          schedule: { public: true },
        },
      ]),
    /GOAL_SCHEDULE_DISPATCH_USE_SCHEDULER/,
  );
  const before = f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
  assert.throws(
    () =>
      f.plan(g.goalId, [
        { key: 'bad', text: 'PUBLIC_BAD', dependsOn: [], dispatch: 'always' as 'execute_once' },
      ]),
    /INVALID_GOAL_PLAN/,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, before);
});
test('automatic candidates freeze Task version and current policy/privacy; only the existing transactional Run claim can consume one', (t) => {
  const f = fixture(t),
    g = f.create(),
    p = f.plan(g.goalId, [
      { key: 'auto', text: 'PUBLIC_AUTO', dependsOn: [], dispatch: 'execute_once' },
    ]),
    candidate = f.module.dispatchCandidates()[0]!;
  f.module.assertDispatchCandidate(
    candidate.projectId,
    candidate.taskId,
    candidate.expectedVersion,
    candidate.submissionKey,
  );
  f.db.exec('UPDATE dots SET privacy_epoch=privacy_epoch+1');
  assert.deepEqual(f.module.dispatchCandidates(), []);
  assert.throws(
    () =>
      f.module.assertDispatchCandidate(
        candidate.projectId,
        candidate.taskId,
        candidate.expectedVersion,
        candidate.submissionKey,
      ),
    /GOAL_DISPATCH_NOT_CURRENT/,
  );
  f.db.exec('UPDATE dots SET privacy_epoch=privacy_epoch-1');
  f.db.prepare('UPDATE tasks SET version=version+1 WHERE task_id=?').run(p.taskIds[0]!);
  assert.deepEqual(f.module.dispatchCandidates(), []);
  assert.throws(
    () =>
      f.module.assertDispatchCandidate(
        candidate.projectId,
        candidate.taskId,
        candidate.expectedVersion + 1,
        candidate.submissionKey,
      ),
    /GOAL_DISPATCH_NOT_CURRENT/,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 0);
});
test('Source execute_once waits for its own acknowledged wake and rechecks Mandate or disabled Source at admission', (t) => {
  for (const revoked of ['source', 'mandate', 'expired'] as const) {
    const f = fixture(t);
    f.bind();
    const g = f.create(),
      p = f.plan(g.goalId, [
        {
          key: 'auto',
          text: 'PUBLIC_AUTO',
          dependsOn: [],
          dispatch: 'execute_once',
          subscription: f.subscription(),
        },
      ]);
    assert.deepEqual(f.module.dispatchCandidates(), []);
    f.module.ingestTrusted('public-source', f.envelope());
    assert.deepEqual(f.module.dispatchCandidates(), []);
    f.module.deliver();
    const candidate = f.module.dispatchCandidates()[0]!;
    assert.equal(candidate.taskId, p.taskIds[0]);
    if (revoked === 'source') f.db.exec('UPDATE sources SET enabled=0');
    else if (revoked === 'mandate')
      f.db.prepare("UPDATE mandates SET state='revoked' WHERE task_id=?").run(candidate.taskId);
    else f.clock(epochStart + 600000);
    assert.deepEqual(f.module.dispatchCandidates(), []);
    assert.throws(
      () =>
        f.module.assertDispatchCandidate(
          candidate.projectId,
          candidate.taskId,
          candidate.expectedVersion,
          candidate.submissionKey,
        ),
      /GOAL_DISPATCH_NOT_CURRENT/,
    );
  }
});
test('a claimed or Unknown automatic Task never becomes an automatic candidate again, even before a transport Intent', (t) => {
  const f = fixture(t),
    g = f.create();
  f.plan(g.goalId, [{ key: 'auto', text: 'PUBLIC_AUTO', dependsOn: [], dispatch: 'execute_once' }]);
  const candidate = f.module.dispatchCandidates()[0]!,
    queued = f.store.claimTask(
      candidate.projectId,
      candidate.taskId,
      candidate.expectedVersion,
      candidate.submissionKey,
    );
  assert.deepEqual(f.module.dispatchCandidates(), []);
  f.store.uncertain(queued.token);
  assert.deepEqual(f.module.dispatchCandidates(), []);
  assert.throws(
    () =>
      f.module.assertDispatchCandidate(
        candidate.projectId,
        candidate.taskId,
        candidate.expectedVersion,
        candidate.submissionKey,
      ),
    /GOAL_DISPATCH_NOT_CURRENT/,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 0);
});
test('Goal pause/resume never restores automatic dispatch without a new explicit Plan', (t) => {
  const f = fixture(t),
    g = f.create(),
    p = f.plan(g.goalId, [
      { key: 'auto', text: 'PUBLIC_AUTO', dependsOn: [], dispatch: 'execute_once' },
    ]);
  assert.equal(f.module.dispatchCandidates().length, 1);
  const paused = f.module.apply({
    kind: 'pause',
    commandKey: 'pause-auto',
    goalId: g.goalId,
    expectedVersion: p.goal.version,
  });
  assert.deepEqual(f.module.dispatchCandidates(), []);
  const resumed = f.module.apply({
    kind: 'resume',
    commandKey: 'resume-auto',
    goalId: g.goalId,
    expectedVersion: paused.goal.version,
  });
  assert.equal(resumed.goal.requiresPlan, true);
  assert.deepEqual(f.module.dispatchCandidates(), []);
});
test('automatic dependency work freezes the newly queued version and still respects the Goal deadline', (t) => {
  const f = fixture(t),
    g = f.module.apply({
      kind: 'create',
      commandKey: 'deadline',
      projectId: f.project.id,
      title: 'PUBLIC',
      objective: 'PUBLIC',
      criteria: ['Independent cases'],
      deadlineAtMs: epochStart + 60000,
    }).goal,
    p = f.plan(g.goalId, [
      { key: 'a', text: 'PUBLIC_DEPENDENCY', dependsOn: [] },
      { key: 'b', text: 'PUBLIC_DEPENDENT', dependsOn: ['a'], dispatch: 'execute_once' },
    ]);
  assert.deepEqual(f.module.dispatchCandidates(), []);
  f.completeTask(p.taskIds[0]!);
  assert.equal(f.module.advance().queued, 1);
  const candidate = f.module.dispatchCandidates()[0]!;
  assert.equal(candidate.taskId, p.taskIds[1]);
  assert.equal(
    candidate.expectedVersion,
    Number(f.db.prepare('SELECT version FROM tasks WHERE task_id=?').get(p.taskIds[1]!)!.version),
  );
  f.clock(epochStart + 60000);
  assert.deepEqual(f.module.dispatchCandidates(), []);
  assert.throws(
    () =>
      f.module.assertDispatchCandidate(
        candidate.projectId,
        candidate.taskId,
        candidate.expectedVersion,
        candidate.submissionKey,
      ),
    /GOAL_DISPATCH_NOT_CURRENT/,
  );
});

test('verified Goal completion and opted-in independent notification commit once in the same transaction', (t) => {
  const f = fixture(t),
    goal = f.create('auto-notification', {
      enabled: true,
      dailyLimit: 3,
      quietStartMinute: 0,
      quietEndMinute: 0,
    }),
    plan = f.plan(goal.goalId, [{ key: 'a', text: 'PUBLIC_COMPLETE_TASK', dependsOn: [] }]),
    verificationId = f.completeTask(plan.taskIds[0]!);
  const command = {
      kind: 'complete' as const,
      commandKey: 'complete-auto-notification',
      goalId: goal.goalId,
      expectedVersion: plan.goal.version,
      verificationIds: [verificationId],
    },
    done = f.module.apply(command);
  assert.equal(done.goal.status, 'completed');
  assert.equal(f.module.notifications(goal.goalId).length, 1);
  assert.equal(f.module.notifications(goal.goalId)[0]!.state, 'pending');
  assert.equal(f.module.apply(command).duplicate, true);
  assert.equal(f.module.notifications(goal.goalId).length, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='GOAL_NOTIFICATION'").get()!.n,
    1,
  );
});
test('notification preparation failure rolls back Goal completion and its command receipt', (t) => {
  const f = fixture(t),
    goal = f.create('auto-notification-rollback', {
      enabled: true,
      dailyLimit: 3,
      quietStartMinute: 0,
      quietEndMinute: 0,
    }),
    plan = f.plan(goal.goalId, [{ key: 'a', text: 'PUBLIC_COMPLETE_TASK', dependsOn: [] }]),
    verificationId = f.completeTask(plan.taskIds[0]!);
  f.db.exec(
    "CREATE TRIGGER reject_completion_notice BEFORE INSERT ON operations WHEN NEW.kind='GOAL_NOTIFICATION' BEGIN SELECT RAISE(ABORT,'CONTROLLED_NOTIFICATION_FAILURE'); END",
  );
  assert.throws(
    () =>
      f.module.apply({
        kind: 'complete',
        commandKey: 'complete-must-rollback',
        goalId: goal.goalId,
        expectedVersion: plan.goal.version,
        verificationIds: [verificationId],
      }),
    /CONTROLLED_NOTIFICATION_FAILURE/,
  );
  const unchanged = f.module.view(goal.goalId);
  assert.equal(unchanged.status, 'active');
  assert.equal(unchanged.version, plan.goal.version);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM operations WHERE kind IN ('GOAL_COMPLETE','GOAL_NOTIFICATION')",
      )
      .get()!.n,
    0,
  );
});
