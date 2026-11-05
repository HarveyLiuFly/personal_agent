import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { HistoryReconciliation } from '../packages/runtime/src/reconciliation.ts';
function fixture(
  t: { after(fn: () => void): void },
  options: { intent?: boolean; code?: string; policyChanged?: boolean } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ui-v2-goal-recovery-'))),
    cwd = join(root, 'project'),
    file = join(root, 'ledger.db'),
    schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
  mkdirSync(cwd);
  let store = new ExecutionLedger(file, schema, {
    budgetPolicy: { dailyTokens: 1000, reservationTokens: 60 },
  });
  store.startOwner('owner1', true);
  const project = store.registerWorkspace(cwd),
    goal = store.applyGoal({
      kind: 'create',
      commandKey: 'goal',
      projectId: project.id,
      title: 'Public goal',
      objective: 'Public test only',
      criteria: ['Evidence'],
      budgetTokens: 500,
    }).goal,
    plan = store.applyGoal({
      kind: 'plan',
      commandKey: 'plan',
      goalId: goal.goalId,
      expectedVersion: goal.version,
      expectedPlanVersion: goal.planVersion,
      tasks: [{ key: 'work', text: 'PUBLIC_TASK', dependsOn: [] }],
    }),
    task = store.tasks(project.id).find((t) => t.taskId === plan.taskIds[0])!,
    first = store.claimTask(project.id, task.taskId, task.version, 'first').token;
  const a = store.prepare(first, 'thread', 'thread_start', {});
  store.sending(first, a.intentId, 1);
  store.accepted(first, a.intentId, { threadId: 'thread' });
  const b = store.prepare(first, 'turn', 'turn_start', {}, 'thread');
  store.sending(first, b.intentId, 1);
  store.accepted(first, b.intentId, { turnId: 'turn' });
  store.recordTokenUsage(first, 'thread', 'turn', 10);
  store.finish(first, 'completed');
  const second = store.beginContinuation(project.id, first.runId, 'PUBLIC_NEXT', 'second').token;
  if (options.intent) store.prepare(second, 'possible-intent', 'thread_resume', {}, 'thread');
  // Isolated historical-defect fixture, never a mutation of the walkthrough profile.
  const db = new DatabaseSync(file);
  db.prepare('UPDATE task_runs SET goal_plan_version=NULL WHERE run_id=?').run(second.runId);
  store.diagnostic(second, options.code ?? 'RUN_GRANT_EXPIRED');
  store.uncertain(second);
  if (options.policyChanged) db.exec('UPDATE dots SET policy_epoch=policy_epoch+1');
  let reads = 0;
  const service = () =>
    new HistoryReconciliation(store, async () => {
      reads++;
      throw Error('NO_NATIVE_HISTORY_EXPECTED');
    });
  const reopen = () => {
    store.close();
    store = new ExecutionLedger(file, schema);
    store.startOwner('owner2', true);
  };
  t.after(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { project, first, second, db, store: () => store, service, reads: () => reads, reopen };
}
test('explicit reconciliation seals only proven unsent historical Goal preparation, retaining provenance and settling zero without dispatch', async (t) => {
  const f = fixture(t);
  f.reopen();
  const held = f.store().resourceBudget().unknownHeldTokens;
  assert.equal(held, 60);
  await f.service().reconcile({ projectId: f.project.id, runId: f.second.runId });
  assert.equal(f.reads(), 0);
  assert.equal(f.store().runForHost(f.second.runId).status, 'failed');
  assert.equal(f.store().runForHost(f.second.runId).errorCode, 'RUN_NOT_SENT');
  assert.equal(f.store().runForHost(f.first.runId).status, 'completed');
  assert.equal(f.store().resourceBudget().unknownHeldTokens, 0);
  assert.equal(f.store().resourceBudget().reportedTokens, 10);
  assert.equal(
    f.db.prepare('SELECT goal_plan_version FROM task_runs WHERE run_id=?').get(f.second.runId)!
      .goal_plan_version,
    null,
  );
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM execution_intents WHERE run_id=?').get(f.second.runId)!.n,
    0,
  );
  assert.equal(f.store().runs(f.project.id).length, 2);
  await assert.rejects(
    f.service().reconcile({ projectId: f.project.id, runId: f.second.runId }),
    /RUN_NOT_RECONCILABLE/,
  );
});
for (const [name, options] of [
  ['any prepared Intent', { intent: true }],
  ['another failure', { code: 'CONNECTION_LOST' }],
  ['changed policy', { policyChanged: true }],
] as const)
  test('unknown remains blocked with ' + name, async (t) => {
    const f = fixture(t, options),
      before = f.store().resourceBudget().unknownHeldTokens;
    assert.equal(f.store().reconcileUnsentGoalPreparation(f.project.id, f.second.runId), false);
    assert.equal(f.store().runForHost(f.second.runId).status, 'outcome_unknown');
    assert.equal(f.store().resourceBudget().unknownHeldTokens, before);
    assert.equal(f.store().runs(f.project.id).length, 2);
  });
test('unsent reconciliation cannot cross projects', (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.store().reconcileUnsentGoalPreparation('foreign', f.second.runId),
    /RUN_NOT_IN_PROJECT/,
  );
  assert.equal(f.store().runForHost(f.second.runId).status, 'outcome_unknown');
});
