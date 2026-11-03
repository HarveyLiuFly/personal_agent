import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ExecutionLedger, LedgerError } from '../packages/store/src/ledger.ts';
import type { RunToken } from '../packages/store/src/ledger.ts';
const schema = readFileSync(resolve('docs/design/contracts/schema.sql'), 'utf8');
const failure = (code: string) => (e: unknown) => e instanceof LedgerError && e.code === code;
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-ledger-'))), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const file = join(root, 'state/store.db'), ledger = new ExecutionLedger(file, schema); ledger.startOwner('fixture-owner', true);
  const project = ledger.registerWorkspace(workspace);
  t.after(() => { try { ledger.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  const sql = () => new DatabaseSync(file);
  const begin = (key = 'fixture-key', mode: 'readOnly' | 'workspaceWrite' = 'readOnly') => ledger.beginRun(project.id, 'fixture task', key, mode).token;
  const thread = (token: RunToken, threadId = 'fixture-thread') => {
    const intent = ledger.prepare(token, 'thread-key', 'thread_start', { cwd: workspace });
    ledger.sending(token, intent.intentId, 1); ledger.accepted(token, intent.intentId, { threadId }); return threadId;
  };
  const turn = (token: RunToken) => {
    const threadId = thread(token); const intent = ledger.prepare(token, 'turn-key', 'turn_start', { input: 'fixture task' }, threadId);
    ledger.sending(token, intent.intentId, 1); ledger.accepted(token, intent.intentId, { turnId: 'fixture-turn' }); return intent;
  };
  return { root, workspace, file, ledger, project, sql, begin, thread, turn };
}
test('initializes common schema, persists workspace identity and protects local database permissions', t => {
  const f = fixture(t); const db = f.sql();
  try {
    assert.equal(db.prepare('SELECT schema_revision FROM schema_metadata').get()!.schema_revision, 6);
    assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    if (process.platform !== 'win32') {
      assert.equal(statSync(f.file).mode & 0o777, 0o600);
      assert.equal(statSync(join(f.root, 'state')).mode & 0o777, 0o700);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(f.ledger.registerWorkspace(f.workspace).id, f.project.id);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='execution_intents'").get());
  } finally { db.close(); }
});
test('foreign or unsupported databases are rejected without wiping existing tables', t => {
  const f = fixture(t), file = join(f.root, 'foreign.db'), db = new DatabaseSync(file);
  db.exec('CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES (\'retained\')'); db.close();
  assert.throws(() => new ExecutionLedger(file, schema), failure('LEDGER_SCHEMA_UNSUPPORTED'));
  const check = new DatabaseSync(file); assert.equal(check.prepare('SELECT value FROM user_data').get()!.value, 'retained'); check.close();
});
test('importing a Git subdirectory keeps the canonical repository and actual workspace separate', t => {
  const f = fixture(t); execFileSync('git', ['init','--quiet',f.workspace]);
  const nested = join(f.workspace, 'nested'); mkdirSync(nested);
  const project = f.ledger.registerWorkspace(nested), db = f.sql();
  try {
    const row = db.prepare('SELECT p.canonical_git_root,w.canonical_cwd FROM workspaces w JOIN projects p USING(project_id) WHERE w.workspace_id=?').get(project.id)!;
    assert.equal(row.canonical_git_root, f.workspace); assert.equal(row.canonical_cwd, nested);
  } finally { db.close(); }
});
test('duplicate submission keys return the same run; changed inputs and concurrent tasks fail', t => {
  const f = fixture(t), token = f.begin();
  const duplicate = f.ledger.beginRun(f.project.id, 'fixture task', 'fixture-key', 'readOnly');
  assert.equal(duplicate.created, false); assert.equal(duplicate.token.runId, token.runId);
  assert.throws(() => f.ledger.beginRun(f.project.id, 'changed', 'fixture-key', 'readOnly'), failure('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.begin('other-key'), failure('RUNTIME_BUSY'));
  assert.equal(f.ledger.runs(f.project.id).length, 1);
});
test('workspace lease collision rolls back the entire task/run/event claim', t => {
  const f = fixture(t), token = f.begin('first', 'workspaceWrite'); f.turn(token); f.ledger.finish(token, 'completed');
  const db = f.sql(); db.exec('PRAGMA foreign_keys=ON'); db.prepare('INSERT INTO workspace_write_leases VALUES (?,?,1,9999999999999)').run(f.project.id, token.runId);
  const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n;
  assert.throws(() => f.begin('second', 'workspaceWrite'), failure('WORKSPACE_BUSY'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, before); db.close();
});
test('turn intents require the task binding and cannot borrow a different project thread', t => {
  const f = fixture(t), token = f.begin();
  assert.throws(() => f.ledger.prepare(token, 'turn-key', 'turn_start', {}, 'foreign-thread'), failure('THREAD_NOT_BOUND'));
  const threadId = f.thread(token);
  assert.ok(f.ledger.prepare(token, 'turn-key', 'turn_start', {}, threadId));
});
test('sending is durable once only, input hashes are stable and RPC correlation is persisted', t => {
  const f = fixture(t), token = f.begin(), params = { cwd: f.workspace }, intent = f.ledger.prepare(token, 'thread-key', 'thread_start', params);
  const rpcId = f.ledger.sending(token, intent.intentId, 7), db = f.sql();
  try {
    const row = db.prepare('SELECT * FROM execution_intents').get()!;
    assert.equal(row.state, 'sending'); assert.equal(row.connection_epoch, 7); assert.equal(row.rpc_request_id, rpcId);
    assert.throws(() => f.ledger.sending(token, intent.intentId, 7), failure('INTENT_NOT_PREPARED'));
    assert.throws(() => f.ledger.prepare(token, 'thread-key', 'thread_start', { changed: true }), failure('IDEMPOTENCY_CONFLICT'));
    f.ledger.accepted(token, intent.intentId, { threadId: 'fixture-thread' });
    assert.equal(f.ledger.prepare(token, 'thread-key', 'thread_start', params).state, 'accepted');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM thread_bindings').get()!.n, 1);
  } finally { db.close(); }
});
test('invalid acceptance cannot partially bind a thread or clear an uncertain intent', t => {
  const f = fixture(t), token = f.begin(), intent = f.ledger.prepare(token, 'thread-key', 'thread_start', {});
  f.ledger.sending(token, intent.intentId, 1);
  assert.throws(() => f.ledger.accepted(token, intent.intentId, {}), failure('INVALID_THREAD_RESPONSE'));
  assert.equal(f.ledger.intent(intent.intentId).state, 'sending');
  f.ledger.uncertain(token, intent.intentId);
  assert.throws(() => f.ledger.accepted(token, intent.intentId, { threadId: 'late-thread' }), failure('RUN_DISPATCH_BLOCKED'));
});
test('restart retains unknown work, rejects stale grants and never creates a replacement run', t => {
  const f = fixture(t), token = f.begin(), intent = f.ledger.prepare(token, 'thread-key', 'thread_start', {});
  f.ledger.sending(token, intent.intentId, 1);
  // Simulates an OS-lock handover; real process crash/lock behavior is a separate E2E target.
  const next = new ExecutionLedger(f.file, schema); next.startOwner('new-owner-after-lock', true);
  try {
    assert.equal(next.intent(intent.intentId).state, 'outcome_unknown');
    assert.equal(next.runs(f.project.id)[0]!.status, 'outcome_unknown'); assert.equal(next.runs(f.project.id)[0]!.blocked, true);
    assert.throws(() => f.ledger.heartbeat(token), failure('STALE_RUNTIME_OWNER'));
    assert.throws(() => next.beginRun(f.project.id, 'new', 'new-key', 'readOnly'), failure('RUNTIME_BUSY'));
    const same = next.beginRun(f.project.id, 'fixture task', 'fixture-key', 'readOnly'); assert.equal(same.created, false);
    assert.throws(() => next.sending(same.token, intent.intentId, 2), failure('STALE_RUN'));
  } finally { next.close(); }
});
test('prepared but unsent intents are marked rejected on restart, with no dispatch authorization', t => {
  const f = fixture(t), token = f.begin(), intent = f.ledger.prepare(token, 'thread-key', 'thread_start', {});
  const next = new ExecutionLedger(f.file, schema); next.startOwner('restarted-owner', true);
  assert.equal(next.intent(intent.intentId).state, 'rejected'); assert.equal(next.runs(f.project.id)[0]!.status, 'outcome_unknown'); next.close();
});
test('completion ends the run but keeps the task awaiting verification', t => {
  const f = fixture(t), token = f.begin();
  assert.throws(() => f.ledger.finish(token, 'completed'), failure('TURN_NOT_ACCEPTED'));
  f.turn(token); f.ledger.finish(token, 'completed');
  const run = f.ledger.runs(f.project.id)[0]!;
  assert.equal(run.status, 'completed'); assert.equal(run.taskStatus, 'needs_review'); assert.equal(run.turnId, 'fixture-turn');
  assert.throws(() => f.ledger.heartbeat(token), failure('RUN_DISPATCH_BLOCKED'));
});
test('snapshot caches are scope checked and do not turn an unfinished run into success', t => {
  const f = fixture(t), token = f.begin(); f.turn(token);
  const view = { threadId: 'fixture-thread', epoch: 1, sequence: 1, needsSnapshot: false, truncated: false, unsupportedItems: false, turns: [], items: [] };
  assert.throws(() => f.ledger.saveSnapshot(token, { ...view, threadId: 'foreign-thread' }), failure('THREAD_NOT_BOUND'));
  f.ledger.saveSnapshot(token, view); assert.deepEqual(f.ledger.runs(f.project.id)[0]!.snapshot, view);
  assert.equal(f.ledger.runs(f.project.id)[0]!.status, 'running');
});
test('directory replacement and expired leases prevent further dispatch', t => {
  const f = fixture(t), token = f.begin(), db = f.sql();
  db.prepare('UPDATE task_runs SET lease_until_ms=0 WHERE run_id=?').run(token.runId); db.close();
  assert.throws(() => f.ledger.prepare(token, 'x', 'thread_start', {}), failure('RUN_GRANT_EXPIRED'));
  renameSync(f.workspace, join(f.root, 'old')); mkdirSync(f.workspace);
  assert.throws(() => f.ledger.workspace(f.project.id), failure('PROJECT_IDENTITY_CHANGED'));
});
test('workspace fence or lease expiry blocks writes even while the run lease is valid', t => {
  const f = fixture(t), token = f.begin('write-key', 'workspaceWrite'), db = f.sql();
  db.prepare('UPDATE workspaces SET write_fence=write_fence+1 WHERE workspace_id=?').run(f.project.id);
  assert.throws(() => f.ledger.prepare(token, 'x', 'thread_start', {}), failure('WORKSPACE_GRANT_EXPIRED'));
  db.close();
});
test('task events and outbox entries share a committed sequence and omit raw task input', t => {
  const f = fixture(t), token = f.begin(); f.thread(token); const db = f.sql();
  try {
    const events = db.prepare('SELECT * FROM task_events ORDER BY sequence').all();
    assert.deepEqual(events.map(row => row.sequence), events.map((_, i) => i + 1));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox_events').get()!.n, events.length);
    assert.equal(events.some(row => String(row.payload_json).includes('fixture task')), false);
  } finally { db.close(); }
});
test('real worker SIGKILL after sending commit survives reopen without authorizing a resend', async t => {
  const f = fixture(t), childFile = join(f.root, 'child-state/store.db');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'tests/fixtures/ledger-worker.ts', childFile, f.workspace], { stdio: ['ignore','pipe','ignore'] });
  const stopped = once(child, 'close'); t.after(() => { child.kill('SIGKILL'); });
  let line = '';
  const receipt = await new Promise<{ projectId: string; runId: string; intentId: string }>((done, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('FIXTURE_READY_TIMEOUT')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => { line += String(chunk); if (line.includes('\n')) { clearTimeout(timer); done(JSON.parse(line.trim())); } });
  });
  child.kill('SIGKILL'); const [code, signal] = await stopped;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  const recovered = new ExecutionLedger(childFile, schema); recovered.startOwner('after-dead-process', true);
  try {
    assert.equal(recovered.intent(receipt.intentId).state, 'outcome_unknown');
    assert.equal(recovered.runs(receipt.projectId)[0]!.runId, receipt.runId);
    assert.equal(recovered.runs(receipt.projectId)[0]!.blocked, true);
    assert.throws(() => recovered.beginRun(receipt.projectId, 'duplicate after crash', 'new-key', 'readOnly'), failure('RUNTIME_BUSY'));
  } finally { recovered.close(); }
});
