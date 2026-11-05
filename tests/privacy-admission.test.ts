import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
/** Actual Store/SQLite admission. No executor is started; explicit
 * executorClosed calls are synthetic closure metadata, not a process test. */
function fixture(
  t: { after(fn: () => void): void },
  mode: 'readOnly' | 'workspaceWrite' = 'readOnly',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-privacy-admission-'))),
    cwd = join(root, 'project'),
    file = join(root, 'ledger.db');
  mkdirSync(cwd);
  const store = new ExecutionLedger(file, schema, {
    budgetPolicy: { dailyTokens: 1000, reservationTokens: 60, maxActiveRuns: 1 },
  });
  store.startOwner('privacy-admission-fixture', true);
  const project = store.registerWorkspace(cwd),
    db = new DatabaseSync(file),
    run = store.beginRun(project.id, 'PUBLIC_OLD_REQUEST', 'old-distinct-key', mode),
    old = store.runForHost(run.token.runId);
  t.after(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const forget = () =>
      store.forgetMemory({ sourceRefs: ['task:' + old.taskId], expectedPrivacyEpoch: 1 }),
    fresh = () =>
      store.beginRun(project.id, 'PUBLIC_FRESH_REQUEST', 'new-distinct-key', 'readOnly');
  return { root, db, store, project, run, old, forget, fresh };
}
test('ordinary Unknown still blocks a different read-only request even with a recorded executor closure', (t) => {
  const f = fixture(t);
  f.store.uncertain(f.run.token);
  f.store.executorClosed(f.run.token, 1);
  assert.throws(f.fresh, /RUNTIME_BUSY/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 0);
});
test('privacy revocation without executor closure cannot unblock a fresh request', (t) => {
  const f = fixture(t);
  f.forget();
  f.store.uncertain(f.run.token);
  assert.equal(
    JSON.parse(
      String(
        f.db.prepare('SELECT constraints_json FROM tasks WHERE task_id=?').get(f.old.taskId)!
          .constraints_json,
      ),
    ).privacyRevoked,
    true,
  );
  assert.throws(f.fresh, /RUNTIME_BUSY/);
  assert.equal(f.store.executorClosureRecorded(f.run.token.runId), false);
});
test('closed privacy-revoked read-only Unknown permits a new key and Task without changing the old Run or releasing unknown Token cost', (t) => {
  const f = fixture(t);
  f.forget();
  f.store.uncertain(f.run.token);
  const held = f.store.resourceBudget().unknownHeldTokens;
  f.store.executorClosed(f.run.token, 1);
  const admitted = f.fresh();
  assert.equal(admitted.created, true);
  assert.notEqual(admitted.token.runId, f.run.token.runId);
  assert.notEqual(f.store.runForHost(admitted.token.runId).taskId, f.old.taskId);
  assert.equal(f.store.runForHost(f.run.token.runId).status, 'outcome_unknown');
  assert.equal(f.store.resourceBudget().unknownHeldTokens, held);
  assert.equal(
    f.db.prepare('SELECT state FROM budget_reservations WHERE run_id=?').get(f.run.token.runId)!
      .state,
    'held_unknown',
  );
  assert.throws(
    () => f.store.prepare(f.run.token, 'must-not-resend-old', 'thread_start', {}),
    /RUN_DISPATCH_BLOCKED/,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 0);
  f.store.finish(admitted.token, 'failed');
  const task = f.store.taskCommand({
      kind: 'create',
      commandKey: 'fresh-queued',
      projectId: f.project.id,
      text: 'PUBLIC_NEW_QUEUED_REQUEST',
    }),
    queued = f.store.claimTask(
      f.project.id,
      task.taskId,
      task.taskVersion,
      'new-queued-distinct-key',
    );
  assert.equal(queued.created, true);
  assert.equal(f.store.runForHost(f.run.token.runId).status, 'outcome_unknown');
});
test('privacy-revoked read-only executor closure never admits a new workspace-write request', (t) => {
  const f = fixture(t);
  f.forget();
  f.store.uncertain(f.run.token);
  f.store.executorClosed(f.run.token, 1);
  assert.throws(
    () =>
      f.store.beginRun(
        f.project.id,
        'PUBLIC_NEW_WRITE',
        'new-write-distinct-key',
        'workspaceWrite',
      ),
    /RUNTIME_BUSY/,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 1);
});
test('a privacy-revoked workspace-write Unknown retains its lease and blocks even read-only admission after closure', (t) => {
  const f = fixture(t, 'workspaceWrite');
  f.forget();
  f.store.uncertain(f.run.token);
  f.store.executorClosed(f.run.token, 1);
  assert.throws(f.fresh, /RUNTIME_BUSY/);
  assert.equal(
    f.db
      .prepare('SELECT count(*) AS n FROM workspace_write_leases WHERE run_id=?')
      .get(f.run.token.runId)!.n,
    1,
  );
  assert.equal(f.store.runForHost(f.run.token.runId).mode, 'workspaceWrite');
});
test('an unexpected write lease or still-active state fails closed despite privacy and closure metadata', (t) => {
  for (const condition of ['lease', 'active'] as const) {
    const f = fixture(t);
    f.forget();
    if (condition === 'lease') {
      f.store.uncertain(f.run.token);
      f.db
        .prepare('INSERT INTO workspace_write_leases VALUES (?,?,1,?)')
        .run(f.project.id, f.run.token.runId, Date.now() + 60000);
    }
    f.store.executorClosed(f.run.token, 1);
    assert.throws(f.fresh, /RUNTIME_BUSY/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 1);
  }
});
