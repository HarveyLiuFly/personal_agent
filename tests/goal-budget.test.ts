import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import type { RunToken } from '../packages/store/src/ledger.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
function fixture(t: { after(fn: () => void): void }, quota: unknown = 90, legacy = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-goal-budget-'))),
    cwd = join(root, 'project'),
    file = join(root, 'ledger.db');
  mkdirSync(cwd);
  const store = new ExecutionLedger(file, schema, {
    budgetPolicy: { dailyTokens: 1000, reservationTokens: 60, maxActiveRuns: 1 },
  });
  store.startOwner('goal-budget-owner', true);
  const project = store.registerWorkspace(cwd, cwd),
    db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  const goalId = 'public-goal';
  db.prepare(
    "INSERT INTO goals(goal_id,dot_id,title,objective,status,constraints_json) VALUES (?,?,'PUBLIC_GOAL','PUBLIC_OBJECTIVE','active',?)",
  ).run(goalId, store.dotId, legacy ? '{}' : JSON.stringify({ budgetTokens: quota }));
  t.after(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const task = (key: string) => {
    const receipt = store.taskCommand({
      kind: 'create',
      projectId: project.id,
      commandKey: 'task-' + key,
      text: 'PUBLIC_GOAL_TASK_' + key,
    });
    db.prepare('UPDATE tasks SET goal_id=? WHERE task_id=?').run(goalId, receipt.taskId);
    return receipt;
  };
  const claim = (key: string) => {
    const receipt = task(key);
    return store.claimTask(project.id, receipt.taskId, receipt.taskVersion, 'claim-' + key).token;
  };
  const finish = (token: RunToken, total: number) => {
    const thread = 'thread-' + token.runId,
      a = store.prepare(token, 'thread-' + token.runId, 'thread_start', {});
    store.sending(token, a.intentId, 1);
    store.accepted(token, a.intentId, { threadId: thread });
    const b = store.prepare(token, 'turn-' + token.runId, 'turn_start', {}, thread),
      turnId = 'turn-' + token.runId;
    store.sending(token, b.intentId, 1);
    store.accepted(token, b.intentId, { turnId });
    store.recordTokenUsage(token, thread, turnId, total);
    store.finish(token, 'completed');
  };
  const counts = () =>
    Object.fromEntries(
      [
        'task_runs',
        'operations',
        'task_events',
        'outbox_events',
        'budget_buckets',
        'budget_reservations',
        'run_usage',
      ].map((name) => [name, db.prepare('SELECT count(*) AS n FROM ' + name).get()!.n]),
    );
  return { root, store, project, db, goalId, task, claim, finish, counts };
}
test('a direct first Goal Run claim creates its own current UTC-day bucket without waiting for a pump', (t) => {
  const f = fixture(t),
    token = f.claim('first'),
    rows = f.db
      .prepare("SELECT * FROM budget_buckets WHERE goal_id=? AND unit='tokens'")
      .all(f.goalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.limit_units, 90);
  assert.equal(rows[0]!.reserved_units, 60);
  assert.equal(rows[0]!.consumed_units, 0);
  assert.equal(
    f.db.prepare('SELECT count(*) AS n FROM budget_reservations WHERE run_id=?').get(token.runId)!
      .n,
    2,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 0);
});
test('crossing UTC midnight allocates the new Goal day on the very first direct claim and preserves the old day', (t) => {
  const original = Date.now;
  let now = Date.parse('2027-02-08T23:59:00Z');
  Date.now = () => now;
  try {
    const f = fixture(t),
      first = f.claim('day-one');
    f.finish(first, 25);
    now += 120000;
    const second = f.claim('day-two');
    const rows = f.db
      .prepare('SELECT * FROM budget_buckets WHERE goal_id=? ORDER BY period_start_ms')
      .all(f.goalId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.consumed_units, 25);
    assert.equal(rows[0]!.reserved_units, 0);
    assert.equal(rows[1]!.consumed_units, 0);
    assert.equal(rows[1]!.reserved_units, 60);
    assert.equal(Number(rows[1]!.period_start_ms) - Number(rows[0]!.period_start_ms), 86400000);
    f.store.finish(second, 'failed');
  } finally {
    Date.now = original;
  }
});
test('insufficient Goal capacity rolls back global and Goal reservations, Run, operation and fencing as one group', (t) => {
  const f = fixture(t, 100),
    first = f.claim('spend');
  f.finish(first, 50);
  const next = f.task('short'),
    before = f.counts(),
    primary = f.db
      .prepare('SELECT reserved_units,consumed_units FROM budget_buckets WHERE goal_id IS NULL')
      .get();
  assert.throws(
    () => f.store.claimTask(f.project.id, next.taskId, next.taskVersion, 'too-large'),
    /TOKEN_BUDGET_EXHAUSTED/,
  );
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(
    f.db
      .prepare('SELECT reserved_units,consumed_units FROM budget_buckets WHERE goal_id IS NULL')
      .get(),
    primary,
  );
  const task = f.db
    .prepare('SELECT status,version,write_fence FROM tasks WHERE task_id=?')
    .get(next.taskId)!;
  assert.equal(task.status, 'queued');
  assert.equal(task.version, 2);
  assert.equal(task.write_fence, 0);
});
test('a lower configured quota is enforced before admission and never removes known spend or Unknown holds', (t) => {
  const f = fixture(t, 200),
    first = f.claim('unknown');
  f.store.uncertain(first);
  const row = f.db.prepare('SELECT * FROM budget_buckets WHERE goal_id=?').get(f.goalId)!;
  assert.equal(row.reserved_units, 60);
  assert.equal(
    f.db
      .prepare('SELECT state FROM budget_reservations WHERE run_id=? AND bucket_id=?')
      .get(first.runId, row.bucket_id!)!.state,
    'held_unknown',
  );
  f.db
    .prepare('UPDATE goals SET constraints_json=? WHERE goal_id=?')
    .run(JSON.stringify({ budgetTokens: 30 }), f.goalId);
  const next = f.task('blocked'),
    before = f.counts();
  assert.throws(
    () => f.store.claimTask(f.project.id, next.taskId, next.taskVersion, 'unknown-blocked'),
    /RUNTIME_BUSY/,
  );
  assert.deepEqual(f.counts(), before);
  assert.equal(
    f.db.prepare('SELECT reserved_units FROM budget_buckets WHERE bucket_id=?').get(row.bucket_id!)!
      .reserved_units,
    60,
  );
  const known = fixture(t, 200),
    spent = known.claim('known');
  known.finish(spent, 70);
  known.db
    .prepare('UPDATE goals SET constraints_json=? WHERE goal_id=?')
    .run(JSON.stringify({ budgetTokens: 80 }), known.goalId);
  const task = known.task('lowered'),
    prior = known.counts();
  assert.throws(
    () => known.store.claimTask(known.project.id, task.taskId, task.taskVersion, 'lowered-claim'),
    /TOKEN_BUDGET_EXHAUSTED/,
  );
  assert.deepEqual(known.counts(), prior);
  assert.equal(
    known.db.prepare('SELECT consumed_units FROM budget_buckets WHERE goal_id=?').get(known.goalId)!
      .consumed_units,
    70,
  );
});
test('raising configuration cannot relax an already lower current-day Goal bucket or reset its consumption', (t) => {
  const f = fixture(t, 90),
    first = f.claim('fixed');
  f.finish(first, 40);
  f.db
    .prepare('UPDATE goals SET constraints_json=? WHERE goal_id=?')
    .run(JSON.stringify({ budgetTokens: 500 }), f.goalId);
  const task = f.task('raised');
  assert.throws(
    () => f.store.claimTask(f.project.id, task.taskId, task.taskVersion, 'raised'),
    /TOKEN_BUDGET_EXHAUSTED/,
  );
  const bucket = f.db
    .prepare('SELECT limit_units,consumed_units FROM budget_buckets WHERE goal_id=?')
    .get(f.goalId)!;
  assert.equal(bucket.limit_units, 90);
  assert.equal(bucket.consumed_units, 40);
});
test('legacy M2 Goals without budgetTokens retain manual-bucket accounting without a fabricated daily Goal quota', (t) => {
  const f = fixture(t, undefined, true),
    now = Date.now();
  f.db
    .prepare("INSERT INTO budget_buckets VALUES ('legacy-manual',?,?,'tokens',?,?,65,0,0)")
    .run(f.store.dotId, f.goalId, now - 1, now + 86400000);
  const token = f.claim('legacy');
  assert.equal(
    f.db.prepare('SELECT count(*) AS n FROM budget_buckets WHERE goal_id=?').get(f.goalId)!.n,
    1,
  );
  assert.equal(
    f.db
      .prepare('SELECT reserved_units FROM budget_buckets WHERE bucket_id=?')
      .get('legacy-manual')!.reserved_units,
    60,
  );
  f.store.finish(token, 'failed');
});
test('invalid declared quotas or a stopped Source Goal cannot create any Run or reservation', (t) => {
  for (const bad of [0, -1, 1.5, 1000000001, null]) {
    const f = fixture(t, bad),
      task = f.task('invalid'),
      before = f.counts();
    assert.throws(
      () => f.store.claimTask(f.project.id, task.taskId, task.taskVersion, 'invalid'),
      /INVALID_GOAL_BUDGET/,
    );
    assert.deepEqual(f.counts(), before);
  }
  const f = fixture(t),
    task = f.task('stopped');
  f.db
    .prepare("UPDATE goals SET status='paused',plan_version=plan_version+1 WHERE goal_id=?")
    .run(f.goalId);
  const before = f.counts();
  assert.throws(
    () => f.store.claimTask(f.project.id, task.taskId, task.taskVersion, 'stopped'),
    /GOAL_NOT_ACTIVE/,
  );
  assert.deepEqual(f.counts(), before);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 0);
});
