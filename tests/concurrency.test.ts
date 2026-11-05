import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ExecutionLedger, LEDGER_SCHEMA_REVISION } from '../packages/store/src/ledger.ts';
import type { RunToken } from '../packages/store/src/ledger.ts';
import type { BudgetPolicy } from '../packages/store/src/budget.ts';
import { ForegroundExecution } from '../packages/runtime/src/execution.ts';
import { StdioRpcClient } from '../packages/codex-adapter/src/rpc.ts';

const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');

function fixture(t: { after(fn: () => void | Promise<void>): void }, policy?: BudgetPolicy) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-concurrency-'))),
    file = join(root, 'store.db');
  for (const name of ['a', 'b']) mkdirSync(join(root, name));
  const store = new ExecutionLedger(file, schema, policy ? { budgetPolicy: policy } : {});
  store.startOwner('concurrency-owner', true);
  const a = store.registerWorkspace(join(root, 'a')),
    b = store.registerWorkspace(join(root, 'b'));
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, store, a, b };
}

let threads = 0;
/** Drives a Run through accepted thread/turn intents to a known terminal outcome. */
function complete(store: ExecutionLedger, token: RunToken): void {
  const threadId = `concurrency-thread-${++threads}`;
  const thread = store.prepare(token, 'thread', 'thread_start', {});
  store.sending(token, thread.intentId, 1);
  store.accepted(token, thread.intentId, { threadId });
  const turn = store.prepare(token, 'turn', 'turn_start', {}, threadId);
  store.sending(token, turn.intentId, 1);
  store.accepted(token, turn.intentId, { turnId: `${threadId}-turn` });
  store.finish(token, 'completed');
}

test('Runs in different projects are admitted together up to the default capacity of 3', (t) => {
  const { store, a, b } = fixture(t);
  assert.equal(store.maxActiveRuns(), 3);
  const first = store.beginRun(a.id, 'question a', 'key-1', 'readOnly'),
    second = store.beginRun(b.id, 'question b', 'key-2', 'readOnly'),
    third = store.beginRun(a.id, 'another question a', 'key-3', 'readOnly');
  assert.ok(first.created && second.created && third.created);
  assert.throws(() => store.beginRun(b.id, 'fourth', 'key-4', 'readOnly'), /RUNTIME_BUSY/);
  complete(store, second.token);
  assert.equal(store.beginRun(b.id, 'fourth', 'key-4', 'readOnly').created, true);
  // The same submission key stays idempotent while its Run is active.
  assert.equal(store.beginRun(a.id, 'question a', 'key-1', 'readOnly').created, false);
});

test('an Unknown Run keeps holding one slot of capacity', (t) => {
  const { store, a, b } = fixture(t, {
    dailyTokens: 1_000_000,
    reservationTokens: 1000,
    maxActiveRuns: 2,
  });
  const unknown = store.beginRun(a.id, 'lost', 'unknown-1', 'readOnly');
  store.uncertain(unknown.token);
  assert.equal(store.runForHost(unknown.token.runId).status, 'outcome_unknown');
  assert.equal(store.beginRun(b.id, 'other project', 'other-1', 'readOnly').created, true);
  assert.throws(() => store.beginRun(b.id, 'third', 'third-1', 'readOnly'), /RUNTIME_BUSY/);
});

test('one writer per workspace; read-only Runs may run beside it', (t) => {
  const { store, a, b } = fixture(t);
  assert.equal(store.beginRun(a.id, 'write a', 'write-a', 'workspaceWrite').created, true);
  assert.throws(
    () => store.beginRun(a.id, 'second write a', 'write-a-2', 'workspaceWrite'),
    /WORKSPACE_BUSY/,
  );
  assert.equal(store.beginRun(a.id, 'read a', 'read-a', 'readOnly').created, true);
  assert.equal(store.beginRun(b.id, 'write b', 'write-b', 'workspaceWrite').created, true);
});

test('revision 6 migrates to 7 with a verified backup and the default capacity', (t) => {
  const { root, file, store } = fixture(t);
  store.close();
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=OFF;
    ALTER TABLE budget_policies RENAME TO current_policies;
    CREATE TABLE budget_policies (
      dot_id TEXT PRIMARY KEY REFERENCES dots(dot_id),
      daily_token_limit INTEGER NOT NULL CHECK (daily_token_limit > 0),
      reservation_tokens INTEGER NOT NULL CHECK (reservation_tokens > 0),
      max_active_runs INTEGER NOT NULL CHECK (max_active_runs = 1));
    INSERT INTO budget_policies SELECT dot_id,daily_token_limit,reservation_tokens,1 FROM current_policies;
    DROP TABLE current_policies;
    UPDATE schema_metadata SET schema_revision=6;`);
  db.close();
  const migrated = new ExecutionLedger(file, schema);
  try {
    assert.equal(LEDGER_SCHEMA_REVISION, 7);
    assert.equal(migrated.maxActiveRuns(), 3);
  } finally {
    migrated.close();
  }
  const check = new DatabaseSync(file);
  try {
    assert.equal(
      check.prepare('SELECT schema_revision AS n FROM schema_metadata').get()!.n,
      LEDGER_SCHEMA_REVISION,
    );
    check.exec('UPDATE budget_policies SET max_active_runs=8');
    assert.throws(() => check.exec('UPDATE budget_policies SET max_active_runs=9'), /CHECK/);
  } finally {
    check.close();
  }
  const backups = readdirSync(root).filter((name) => /\.revision6-.*\.backup$/.test(name));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(root, backups[0]!), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    assert.equal(backup.prepare('SELECT schema_revision AS n FROM schema_metadata').get()!.n, 6);
  } finally {
    backup.close();
  }
});

test('the executor runs two conversations at once and stops only the one asked', async (t) => {
  const { root, file, store, a, b } = fixture(t);
  let connections = 0;
  const runtime = new ForegroundExecution(store, {
    executable: process.execPath,
    stateDirectory: root,
    // Generous limits: the synthetic server is slow on a loaded disk; the assertions are about order.
    timeoutMs: 120_000,
    connect: (callbacks) =>
      new StdioRpcClient({
        executable: process.execPath,
        args: [
          '--disable-warning=ExperimentalWarning',
          resolve('tests/fixtures/execution-server.ts'),
          'interrupt-ok',
          file,
          join(root, 'receipts.txt'),
          `concurrent-thread-${++connections}`,
        ],
        requestTimeoutMs: 30_000,
        ...callbacks,
      }),
  });
  t.after(() => runtime.close());
  const first = runtime.submit({ projectId: a.id, text: 'first', submissionKey: 'concurrent-a' }),
    second = runtime.submit({ projectId: b.id, text: 'second', submissionKey: 'concurrent-b' });
  const running = async (projectId: string, runId: string) => {
    const deadline = Date.now() + 90_000;
    while (!runtime.view({ projectId, runId }).turnId) {
      if (Date.now() > deadline) throw new Error('TURN_NOT_STARTED');
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  await Promise.all([running(a.id, first.runId), running(b.id, second.runId)]);
  assert.equal(runtime.activeIn(a.id), true);
  assert.equal(runtime.activeIn(b.id), true);
  assert.equal(runtime.atCapacity, false);

  await runtime.interrupt({ projectId: a.id, runId: first.runId });
  const deadline = Date.now() + 90_000;
  while (runtime.activeIn(a.id)) {
    if (Date.now() > deadline) throw new Error('FIRST_NOT_STOPPED');
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(runtime.activeIn(b.id), true, 'stopping one conversation leaves the other running');
  assert.equal(store.runForHost(first.runId).status, 'cancelled');

  await runtime.interrupt({ projectId: b.id, runId: second.runId });
  await runtime.wait();
  assert.equal(runtime.busy, false);
  assert.equal(store.runForHost(second.runId).status, 'cancelled');
  assert.equal(runtime.diagnostics.clientTurnStarts, 2);
  assert.equal(existsSync(join(root, 'receipts.txt')), true);
  const timings = [runtime.timing(first.runId)!, runtime.timing(second.runId)!];
  for (const timing of timings)
    assert.ok(
      timing.launchedAt <= timing.turnAcceptedAt! && timing.turnAcceptedAt! <= timing.finishedAt!,
    );
  assert.ok(
    timings[0]!.launchedAt < timings[1]!.finishedAt! &&
      timings[1]!.launchedAt < timings[0]!.finishedAt!,
    'the two Runs overlapped in time',
  );
});
