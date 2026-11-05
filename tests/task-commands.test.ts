import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger, LedgerError } from '../packages/store/src/ledger.ts';
import type { TaskCommand } from '../packages/contracts/src/tasks.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-domain-'))),
    cwd = join(root, 'project'),
    file = join(root, 'store.db');
  mkdirSync(cwd);
  const store = new ExecutionLedger(file, schema);
  store.startOwner('domain-owner', true);
  const project = store.registerWorkspace(cwd, cwd);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  const create = (key = 'create-key', text = 'controlled queued task') =>
    store.taskCommand({ projectId: project.id, commandKey: key, kind: 'create', text });
  const counts = () =>
    Object.fromEntries(
      [
        'tasks',
        'task_runs',
        'messages',
        'router_decisions',
        'operations',
        'task_events',
        'outbox_events',
      ].map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)]),
    );
  return { root, cwd, file, store, project, db, create, counts };
}
test('explicit task creation persists one command, task, event stream and outbox without dispatch', (t) => {
  const f = fixture(t),
    result = f.create();
  assert.equal(result.state, 'completed');
  assert.equal(result.status, 'queued');
  assert.equal(result.taskVersion, 2);
  assert.equal(f.store.tasks(f.project.id)[0]!.activeRunId, null);
  assert.equal(f.counts().task_runs, 0);
  assert.equal(f.counts().operations, 1);
  assert.equal(f.counts().task_events, f.counts().outbox_events);
  assert.deepEqual(f.create(), result);
  assert.throws(() => f.create('create-key', 'changed content'), /IDEMPOTENCY_CONFLICT/);
  assert.equal(f.counts().tasks, 1);
});
test('version CAS rejects stale edits and invalid transitions without any partial operation or event', (t) => {
  const f = fixture(t),
    created = f.create(),
    before = f.counts();
  assert.throws(
    () =>
      f.store.taskCommand({
        projectId: f.project.id,
        commandKey: 'stale',
        kind: 'pause',
        taskId: created.taskId,
        expectedVersion: 1,
      }),
    /TASK_VERSION_CONFLICT/,
  );
  assert.deepEqual(f.counts(), before);
  const pause = {
    projectId: f.project.id,
    commandKey: 'pause',
    kind: 'pause' as const,
    taskId: created.taskId,
    expectedVersion: 2,
  };
  const paused = f.store.taskCommand(pause);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.blocked, true);
  assert.deepEqual(f.store.taskCommand(pause), paused);
  const unchanged = f.counts();
  assert.throws(
    () =>
      f.store.taskCommand({
        ...pause,
        commandKey: 'invalid-edge',
        expectedVersion: paused.taskVersion,
      }),
    /INVALID_TASK_TRANSITION/,
  );
  assert.deepEqual(f.counts(), unchanged);
  const resumed = f.store.taskCommand({
    ...pause,
    commandKey: 'resume',
    kind: 'resume',
    expectedVersion: paused.taskVersion,
  });
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.blocked, false);
  const title = f.store.taskCommand({
    ...pause,
    commandKey: 'rename',
    kind: 'rename',
    title: 'renamed fixture',
    expectedVersion: resumed.taskVersion,
  });
  assert.equal(title.taskVersion, resumed.taskVersion + 1);
  assert.equal(f.store.tasks(f.project.id)[0]!.title, 'renamed fixture');
});
test('two competing commands with the same task version have one winner', async (t) => {
  const f = fixture(t),
    created = f.create(),
    results = await Promise.allSettled(
      ['pause', 'cancel'].map((kind) =>
        Promise.resolve().then(() =>
          f.store.taskCommand({
            projectId: f.project.id,
            commandKey: kind,
            kind: kind as 'pause' | 'cancel',
            taskId: created.taskId,
            expectedVersion: 2,
          }),
        ),
      ),
    );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal((failed.reason as LedgerError).code, 'TASK_VERSION_CONFLICT');
  assert.equal(f.counts().operations, 2);
});
test('extra fields, raw paths, cross-project tasks and malformed code profiles cannot create commands', (t) => {
  const f = fixture(t),
    created = f.create();
  mkdirSync(join(f.root, 'other'));
  const other = f.store.registerWorkspace(join(f.root, 'other'), join(f.root, 'other'));
  const before = f.counts();
  for (const input of [
    { projectId: f.project.id, commandKey: 'extra', kind: 'create', text: 'x', argv: ['x'] },
    { projectId: '/etc', commandKey: 'raw', kind: 'create', text: 'x' },
    {
      projectId: other.id,
      commandKey: 'foreign',
      kind: 'cancel',
      taskId: created.taskId,
      expectedVersion: 2,
    },
    { projectId: f.project.id, commandKey: 'invalid-code', kind: 'create', text: 'x', code: null },
    {
      projectId: f.project.id,
      commandKey: 'path-code',
      kind: 'create',
      text: 'x',
      code: { profile: 'node-test', target: 'test.mjs', allowedPaths: ['../outside'] },
    },
  ])
    assert.throws(() => f.store.taskCommand(input as TaskCommand), LedgerError);
  assert.deepEqual(f.counts(), before);
});
test('queued claim keeps one operation/run, checks versions and does not revive expired or unknown grants', (t) => {
  const f = fixture(t),
    created = f.create(),
    claimed = f.store.claimTask(f.project.id, created.taskId, 2, 'dispatch-key');
  assert.equal(claimed.created, true);
  assert.equal(claimed.text, 'controlled queued task');
  assert.equal(f.store.claimTask(f.project.id, created.taskId, 2, 'dispatch-key').created, false);
  const before = f.counts();
  assert.throws(
    () => f.store.claimTask(f.project.id, created.taskId, 2, 'stale-key'),
    /TASK_VERSION_CONFLICT/,
  );
  assert.deepEqual(f.counts(), before);
  const thread = f.store.prepare(claimed.token, 'thread', 'thread_start', {});
  f.store.sending(claimed.token, thread.intentId, 1);
  f.store.uncertain(claimed.token, thread.intentId);
  assert.equal(f.store.tasks(f.project.id)[0]!.status, 'outcome_unknown');
  assert.throws(
    () =>
      f.store.claimTask(
        f.project.id,
        created.taskId,
        f.store.tasks(f.project.id)[0]!.version,
        'retry',
      ),
    /TASK_NOT_DISPATCHABLE/,
  );
  assert.equal(f.store.claimTask(f.project.id, created.taskId, 2, 'dispatch-key').created, false);
  assert.equal(f.counts().task_runs, 1);
});
test('a workspace write lease collision rolls back command, run, task version and fence together', (t) => {
  const f = fixture(t),
    old = f.store.beginRun(f.project.id, 'old fixture', 'old', 'readOnly');
  f.store.finish(old.token, 'failed');
  f.db
    .prepare('INSERT INTO workspace_write_leases VALUES (?,?,1,9999999999999)')
    .run(f.project.id, old.token.runId);
  const created = f.store.taskCommand({
      projectId: f.project.id,
      commandKey: 'code-create',
      kind: 'create',
      text: 'code fixture',
      code: { profile: 'node-test', target: 'test/a.mjs', allowedPaths: ['src/a.mjs'] },
    }),
    before = f.counts();
  assert.throws(
    () => f.store.claimTask(f.project.id, created.taskId, 2, 'code-dispatch'),
    /WORKSPACE_BUSY/,
  );
  assert.deepEqual(f.counts(), before);
  assert.equal(f.store.tasks(f.project.id).find((x) => x.taskId === created.taskId)!.version, 2);
  assert.equal(
    f.db.prepare('SELECT write_fence FROM tasks WHERE task_id=?').get(created.taskId)!.write_fence,
    0,
  );
});
test('active pause first persists dispatch blocking; only a confirmed executor result completes it', (t) => {
  const f = fixture(t),
    created = f.create(),
    claimed = f.store.claimTask(f.project.id, created.taskId, 2, 'dispatch');
  const command = {
      projectId: f.project.id,
      commandKey: 'pause-active',
      kind: 'pause' as const,
      taskId: created.taskId,
      expectedVersion: 3,
    },
    pending = f.store.taskCommand(command);
  assert.equal(pending.state, 'executing');
  assert.equal(pending.status, 'running');
  assert.equal(pending.blocked, true);
  assert.throws(
    () => f.store.prepare(claimed.token, 'new-thread', 'thread_start', {}),
    /RUN_DISPATCH_BLOCKED/,
  );
  f.store.block(claimed.token);
  assert.equal(f.store.tasks(f.project.id)[0]!.version, pending.taskVersion);
  f.store.finish(claimed.token, 'cancelled');
  const finished = f.store.taskCommand(command);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.status, 'paused');
  assert.equal(finished.runId, claimed.token.runId);
  const resumed = f.store.taskCommand({
    projectId: f.project.id,
    commandKey: 'resume-after-stop',
    kind: 'resume',
    taskId: created.taskId,
    expectedVersion: finished.taskVersion,
  });
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.blocked, false);
});
test('uncertain stop stays unknown across Owner restart and never becomes a completed cancellation', (t) => {
  const f = fixture(t),
    created = f.create(),
    claimed = f.store.claimTask(f.project.id, created.taskId, 2, 'dispatch'),
    command = {
      projectId: f.project.id,
      commandKey: 'cancel-active',
      kind: 'cancel' as const,
      taskId: created.taskId,
      expectedVersion: 3,
    };
  f.store.taskCommand(command);
  f.store.uncertain(claimed.token);
  const next = new ExecutionLedger(f.file, schema);
  next.startOwner('after-proven-owner-exit-fixture', true);
  try {
    const result = next.taskCommand(command);
    assert.equal(result.state, 'outcome_unknown');
    assert.equal(result.status, 'outcome_unknown');
    assert.throws(
      () => next.claimTask(f.project.id, created.taskId, result.taskVersion, 'unsafe-retry'),
      /TASK_NOT_DISPATCHABLE/,
    );
    assert.throws(() => f.store.taskCommand(command), /STALE_RUNTIME_OWNER/);
  } finally {
    next.close();
  }
});
test('legacy foreground submission, continuation and stop also have durable Operation links', (t) => {
  const f = fixture(t),
    run = f.store.beginRun(f.project.id, 'legacy fixture', 'legacy', 'readOnly');
  assert.ok(
    f.db.prepare('SELECT operation_id FROM task_runs WHERE run_id=?').get(run.token.runId)!
      .operation_id,
  );
  const thread = f.store.prepare(run.token, 'legacy-thread', 'thread_start', {});
  f.store.sending(run.token, thread.intentId, 1);
  f.store.accepted(run.token, thread.intentId, { threadId: 'legacy-thread' });
  const turn = f.store.prepare(run.token, 'legacy-turn', 'turn_start', {}, 'legacy-thread');
  f.store.sending(run.token, turn.intentId, 1);
  f.store.accepted(run.token, turn.intentId, { turnId: 'legacy-turn' });
  f.store.finish(run.token, 'completed');
  const continued = f.store.beginContinuation(
    f.project.id,
    run.token.runId,
    'next fixture',
    'continue',
  );
  assert.ok(
    f.db.prepare('SELECT operation_id FROM task_runs WHERE run_id=?').get(continued.token.runId)!
      .operation_id,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind='CONTINUE_TASK'").get()!.n,
    1,
  );
  f.store.block(continued.token);
  assert.equal(
    f.db.prepare("SELECT state FROM operations WHERE kind='CANCEL_TASK'").get()!.state,
    'executing',
  );
  f.store.finish(continued.token, 'cancelled');
  assert.equal(
    f.db.prepare("SELECT state FROM operations WHERE kind='CANCEL_TASK'").get()!.state,
    'completed',
  );
});
test('policy, privacy and tombstone changes block queued dispatch while cancellation remains available', (t) => {
  const f = fixture(t),
    created = f.create(),
    before = f.counts();
  f.db.prepare('UPDATE dots SET policy_epoch=policy_epoch+1 WHERE dot_id=?').run(f.store.dotId);
  assert.throws(
    () => f.store.claimTask(f.project.id, created.taskId, 2, 'revoked-policy'),
    /TASK_AUTHORIZATION_CHANGED/,
  );
  assert.deepEqual(f.counts(), before);
  const newer = f.create('new-policy');
  f.db.prepare('UPDATE dots SET privacy_epoch=privacy_epoch+1 WHERE dot_id=?').run(f.store.dotId);
  assert.throws(
    () => f.store.claimTask(f.project.id, newer.taskId, 2, 'revoked-privacy'),
    /TASK_AUTHORIZATION_CHANGED/,
  );
  const latest = f.create('new-privacy');
  f.db
    .prepare('INSERT INTO privacy_tombstones VALUES (?,?,1,?)')
    .run(f.store.dotId, 'task:' + latest.taskId, Date.now());
  assert.throws(
    () => f.store.claimTask(f.project.id, latest.taskId, 2, 'deleted-task'),
    /TASK_AUTHORIZATION_CHANGED/,
  );
  const cancelled = f.store.taskCommand({
    projectId: f.project.id,
    commandKey: 'safe-cancel',
    kind: 'cancel',
    taskId: latest.taskId,
    expectedVersion: 2,
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(f.counts().task_runs, 0);
});
test('linked inactive goals block claims and a plan-version change revokes an existing grant', (t) => {
  const f = fixture(t),
    created = f.create();
  f.db
    .prepare(
      "INSERT INTO goals(goal_id,dot_id,title,objective,status) VALUES ('goal',?,'fixture','fixture','paused')",
    )
    .run(f.store.dotId);
  f.db.prepare("UPDATE tasks SET goal_id='goal' WHERE task_id=?").run(created.taskId);
  assert.throws(
    () => f.store.claimTask(f.project.id, created.taskId, 2, 'goal-claim'),
    /GOAL_NOT_ACTIVE/,
  );
  f.db.exec("UPDATE goals SET status='active' WHERE goal_id='goal'");
  const run = f.store.claimTask(f.project.id, created.taskId, 2, 'goal-claim');
  assert.equal(
    f.db.prepare('SELECT goal_plan_version FROM task_runs WHERE run_id=?').get(run.token.runId)!
      .goal_plan_version,
    1,
  );
  f.db.exec("UPDATE goals SET plan_version=plan_version+1 WHERE goal_id='goal'");
  assert.throws(() => f.store.heartbeat(run.token), /RUN_GRANT_EXPIRED/);
});
test('old tasks without reusable source input cannot be moved to a misleading queued state', (t) => {
  const f = fixture(t),
    created = f.create();
  f.db
    .prepare(
      "UPDATE tasks SET constraints_json=json_remove(constraints_json,'$.text'),status='paused' WHERE task_id=?",
    )
    .run(created.taskId);
  const before = f.counts();
  assert.throws(
    () =>
      f.store.taskCommand({
        projectId: f.project.id,
        taskId: created.taskId,
        expectedVersion: 2,
        commandKey: 'old-resume',
        kind: 'resume',
      }),
    /TASK_INPUT_UNAVAILABLE/,
  );
  assert.deepEqual(f.counts(), before);
  assert.equal(f.store.tasks(f.project.id)[0]!.status, 'paused');
});

test('a queued Task keeps its explicit title separate from execution text and binds both to idempotency', (t) => {
  const f = fixture(t),
    input = {
      kind: 'create' as const,
      projectId: f.project.id,
      commandKey: 'named-create',
      title: 'PUBLIC_TASK_NAME',
      text: 'Public instructions that are different from the title',
    },
    receipt = f.store.taskCommand(input);
  assert.equal(f.store.tasks(f.project.id)[0]!.title, input.title);
  assert.equal(
    JSON.parse(
      String(
        f.db.prepare('SELECT constraints_json FROM tasks WHERE task_id=?').get(receipt.taskId)!
          .constraints_json,
      ),
    ).text,
    input.text,
  );
  assert.deepEqual(f.store.taskCommand(input), receipt);
  assert.throws(
    () => f.store.taskCommand({ ...input, title: 'OTHER_NAME' }),
    /IDEMPOTENCY_CONFLICT/,
  );
  for (const title of ['', ' '.repeat(2), 'x'.repeat(121), 7, undefined])
    assert.throws(
      () =>
        f.store.taskCommand({ ...input, commandKey: 'bad-title-' + String(title), title } as never),
      /INVALID_TASK_COMMAND/,
    );
  assert.equal(f.counts().tasks, 1);
  assert.equal(f.counts().task_runs, 0);
});
