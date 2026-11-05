import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { OutboxPump } from '../packages/runtime/src/outbox.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
function fixture(t: { after(fn: () => void): void }, fault?: () => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-outbox-'))),
    cwd = join(root, 'project'),
    file = join(root, 'store.db');
  mkdirSync(cwd);
  const store = new ExecutionLedger(file, schema, { afterOutboxProjectionForTests: fault });
  store.startOwner('outbox-owner', true);
  const project = store.registerWorkspace(cwd, cwd),
    db = new DatabaseSync(file);
  t.after(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const create = (key = 'create') =>
    store.taskCommand({
      projectId: project.id,
      commandKey: key,
      kind: 'create',
      text: 'synthetic sensitive input excluded from activity',
    });
  return { root, cwd, file, store, project, db, create };
}
test('outbox consumers get disjoint claims and project authoritative events once without raw input', (t) => {
  const f = fixture(t);
  f.create();
  const a = f.store.claimOutbox(1),
    b = f.store.claimOutbox(1);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0]!.outboxId, b[0]!.outboxId);
  assert.equal(f.store.claimOutbox().length, 0);
  assert.equal(f.store.deliverOutbox(a[0]!), true);
  assert.equal(f.store.deliverOutbox(a[0]!), false);
  assert.equal(f.store.deliverOutbox(b[0]!), true);
  const feed = f.store.activity(f.project.id);
  assert.equal(feed.items.length, 2);
  assert.equal(new Set(feed.items.map((x) => x.eventId)).size, 2);
  assert.ok(!JSON.stringify(feed).includes('sensitive input'));
  assert.deepEqual(f.store.outboxStatus(), { pending: 0, claimed: 0, delivered: 2, deadLetter: 0 });
});
test('expired and superseded claims cannot ack or requeue another consumers delivery', (t) => {
  const f = fixture(t);
  f.create();
  const claims = f.store.claimOutbox(),
    old = claims[0]!;
  f.store.deliverOutbox(claims[1]!);
  f.db.prepare('UPDATE outbox_events SET lease_until_ms=0 WHERE outbox_id=?').run(old.outboxId);
  assert.throws(() => f.store.deliverOutbox(old), /STALE_OUTBOX_CLAIM/);
  const fresh = f.store.claimOutbox()[0]!;
  assert.equal(fresh.claimEpoch, old.claimEpoch + 1);
  assert.throws(() => f.store.retryOutbox(old), /STALE_OUTBOX_CLAIM/);
  f.store.deliverOutbox(fresh);
  assert.equal(f.store.activity(f.project.id).items.length, 2);
});
test('projection failure rolls back both feed and ack, then the consumer applies bounded retry', (t) => {
  const f = fixture(t, () => {
    throw new Error('controlled projection failure');
  });
  f.create();
  const result = new OutboxPump(f.store).step();
  assert.equal(result.retried, 2);
  assert.equal(result.projected, 0);
  assert.equal(f.store.activity(f.project.id).items.length, 0);
  assert.equal(f.store.outboxStatus().pending, 2);
  assert.equal(f.store.claimOutbox().length, 0);
  for (const row of f.db.prepare('SELECT attempts,next_attempt_at_ms FROM outbox_events').all()) {
    assert.equal(row.attempts, 1);
    assert.ok(Number(row.next_attempt_at_ms) > Date.now());
  }
});
test('five failed deliveries reach Dead Letter and cannot silently restart', (t) => {
  const f = fixture(t);
  f.create();
  let claims = f.store.claimOutbox();
  f.store.deliverOutbox(claims[1]!);
  let claim = claims[0]!;
  for (let attempt = 1; attempt <= 5; attempt++) {
    f.store.retryOutbox(claim);
    const row = f.db.prepare('SELECT * FROM outbox_events WHERE outbox_id=?').get(claim.outboxId)!;
    assert.equal(row.attempts, attempt);
    if (attempt < 5) {
      assert.equal(row.state, 'pending');
      assert.equal(f.store.claimOutbox().length, 0);
      f.db
        .prepare('UPDATE outbox_events SET next_attempt_at_ms=0 WHERE outbox_id=?')
        .run(claim.outboxId);
      claim = f.store.claimOutbox()[0]!;
    } else assert.equal(row.state, 'dead_letter');
  }
  assert.equal(f.store.claimOutbox().length, 0);
  assert.equal(f.store.outboxStatus().deadLetter, 1);
});
test('a fifth abandoned claim becomes Dead Letter rather than an unbounded lease retry', (t) => {
  const f = fixture(t);
  f.create();
  const claims = f.store.claimOutbox();
  f.store.deliverOutbox(claims[1]!);
  let claim = claims[0]!;
  for (let n = 1; n <= 5; n++) {
    f.db.prepare('UPDATE outbox_events SET lease_until_ms=0 WHERE outbox_id=?').run(claim.outboxId);
    const next = f.store.claimOutbox();
    if (n < 5) claim = next[0]!;
    else assert.equal(next.length, 0);
  }
  assert.equal(f.store.outboxStatus().deadLetter, 1);
});
test('activity is paginated, project-scoped and suppresses tombstoned tasks', (t) => {
  const f = fixture(t);
  for (let n = 0; n < 55; n++) f.create('task-' + n);
  const pump = new OutboxPump(f.store);
  while (pump.step(100).claimed) {}
  const first = f.store.activity(f.project.id);
  assert.equal(first.items.length, 100);
  assert.ok(first.nextCursor);
  assert.equal(f.store.activity(f.project.id, first.nextCursor!).items.length, 10);
  mkdirSync(join(f.root, 'other'));
  const other = f.store.registerWorkspace(join(f.root, 'other'), join(f.root, 'other'));
  assert.equal(f.store.activity(other.id).items.length, 0);
  assert.throws(() => f.store.activity(f.project.id, -1), /INVALID_ACTIVITY_CURSOR/);
  const target = first.items[0]!.taskId;
  f.db
    .prepare('INSERT INTO privacy_tombstones VALUES (?,?,1,?)')
    .run(f.store.dotId, 'task:' + target, Date.now());
  assert.equal(
    f.store.activity(f.project.id).items.some((x) => x.taskId === target),
    false,
  );
  assert.equal(
    f.store.tasks(f.project.id).some((x) => x.taskId === target),
    false,
  );
});
test('a tombstone before delivery prevents feed publication while completing local consumption', (t) => {
  const f = fixture(t),
    task = f.create();
  f.db
    .prepare('INSERT INTO privacy_tombstones VALUES (?,?,1,?)')
    .run(f.store.dotId, task.taskId, Date.now());
  const result = new OutboxPump(f.store).step();
  assert.equal(result.claimed, 2);
  assert.equal(result.projected, 0);
  assert.equal(f.store.outboxStatus().delivered, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM main_feed').get()!.n, 0);
});
test('Owner changes invalidate old claims; pending projections resume without duplicating delivered events', (t) => {
  const f = fixture(t);
  f.create();
  const claims = f.store.claimOutbox();
  f.store.deliverOutbox(claims[0]!);
  const next = new ExecutionLedger(f.file, schema);
  next.startOwner('proven-owner-replacement-fixture', true);
  try {
    assert.throws(() => f.store.deliverOutbox(claims[1]!), /STALE_RUNTIME_OWNER/);
    assert.throws(() => next.deliverOutbox(claims[1]!), /STALE_OUTBOX_CLAIM/);
    assert.equal(new OutboxPump(next).step().projected, 1);
    assert.equal(next.activity(f.project.id).items.length, 2);
  } finally {
    next.close();
  }
});
test('mismatched event payloads cannot be accepted as legitimate activity', (t) => {
  const f = fixture(t);
  f.create();
  const claim = f.store.claimOutbox(1)[0]!;
  f.db
    .prepare('UPDATE outbox_events SET payload_json=\'{"unexpected":true}\' WHERE outbox_id=?')
    .run(claim.outboxId);
  assert.throws(() => f.store.deliverOutbox(claim), /OUTBOX_EVENT_MISMATCH/);
  assert.equal(f.store.activity(f.project.id).items.length, 0);
  assert.equal(f.store.outboxStatus().claimed, 1);
});
for (const phase of ['claimed', 'projection_transaction'])
  test(`real process SIGKILL at ${phase} recovers durable outbox with exactly one projection per event`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-outbox-crash-'))),
      cwd = join(root, 'project'),
      file = join(root, 'store.db');
    mkdirSync(cwd);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = spawn(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          'tests/fixtures/outbox-worker.ts',
          file,
          cwd,
          phase,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      ),
      closed = once(child, 'close');
    t.after(() => child.kill('SIGKILL'));
    let buffer = '';
    const ready = await new Promise<{ projectId: string; taskId: string }>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('OUTBOX_CHILD_TIMEOUT'));
      }, 5000);
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        if (buffer.includes('\n')) {
          clearTimeout(timer);
          done(JSON.parse(buffer.trim()));
        }
      });
    });
    const before = new DatabaseSync(file, { readOnly: true });
    assert.equal(before.prepare('SELECT COUNT(*) AS n FROM main_feed').get()!.n, 0);
    assert.equal(
      before.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE state='claimed'").get()!.n,
      1,
    );
    before.close();
    child.kill('SIGKILL');
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    const recovered = new ExecutionLedger(file, schema);
    recovered.startOwner('after-actual-child-exit', true);
    try {
      const pump = new OutboxPump(recovered);
      while (pump.step().claimed) {}
      const feed = recovered.activity(ready.projectId);
      assert.equal(feed.items.length, 2);
      assert.equal(new Set(feed.items.map((x) => x.eventId)).size, 2);
      assert.equal(recovered.outboxStatus().delivered, 2);
      assert.equal(recovered.tasks(ready.projectId)[0]!.taskId, ready.taskId);
      assert.equal(recovered.tasks(ready.projectId)[0]!.status, 'queued');
      assert.equal(recovered.runs(ready.projectId).length, 0);
    } finally {
      recovered.close();
    }
  });
