import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BackgroundScheduler } from '../apps/desktop/src/background-scheduler.ts';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';

const tick = (ms: number) => new Promise((done) => setTimeout(done, ms));

function fixture(
  options: { writesPerRun?: (call: number) => number; due?: () => number | null } = {},
) {
  let changes = 0,
    calls = 0;
  const order: string[] = [];
  const scheduler = new BackgroundScheduler({
    steps: [
      {
        name: 'a',
        run: () => {
          calls++;
          order.push('a');
          changes += options.writesPerRun?.(calls) ?? 0;
        },
      },
      { name: 'b', run: async () => void order.push('b') },
    ],
    changeCount: () => changes,
    nextDueAt: options.due ?? (() => null),
    minIntervalMs: 20,
    safetyMs: 10_000,
    maxChained: 3,
  });
  return {
    scheduler,
    order,
    write: (n = 1) => void (changes += n),
    calls: () => calls,
  };
}

test('no writes, no cycle; an outside write runs every step once, later kicks coalesce', async () => {
  const f = fixture();
  f.scheduler.kick();
  await tick(40);
  assert.equal(f.scheduler.cycles, 0);
  f.write();
  for (let i = 0; i < 5; i++) f.scheduler.kick();
  await tick(60);
  assert.equal(f.scheduler.cycles, 1);
  assert.deepEqual(f.order, ['a', 'b']);
  f.scheduler.kick();
  await tick(40);
  assert.equal(f.scheduler.cycles, 1, 'its own state does not count as a change');
  f.scheduler.stop();
});

test('steps that keep writing stop after the chain limit instead of spinning', async () => {
  const f = fixture({ writesPerRun: () => 1 });
  f.write();
  f.scheduler.kick();
  await tick(80);
  assert.equal(f.calls(), 4, 'one round plus three follow-ups');
  f.scheduler.kick();
  await tick(80);
  assert.equal(f.calls(), 4, 'writes made by cycles never start another cycle');
  f.scheduler.stop();
});

test('chained progress continues until a round writes nothing', async () => {
  const f = fixture({ writesPerRun: (call) => (call <= 2 ? 1 : 0) });
  f.scheduler.request();
  await tick(60);
  assert.equal(f.calls(), 3);
  assert.equal(f.scheduler.cycles, 1);
  f.scheduler.stop();
});

test('a due time runs a cycle without any change', async () => {
  const due = Date.now() + 60;
  const f = fixture({ due: () => (Date.now() < due ? due : null) });
  f.scheduler.request();
  await tick(20);
  assert.equal(f.scheduler.cycles, 1, 'startup cycle');
  await tick(100);
  assert.equal(f.scheduler.cycles, 2, 'due cycle');
  f.scheduler.stop();
});

test('disabled cycles run no step; a failing step does not stop the others', async () => {
  let enabled = false,
    changes = 1;
  const errors: string[] = [],
    ran: string[] = [];
  const scheduler = new BackgroundScheduler({
    steps: [
      {
        name: 'broken',
        run: () => {
          throw new Error('boom');
        },
      },
      { name: 'fine', run: () => void ran.push('fine') },
    ],
    changeCount: () => changes,
    nextDueAt: () => null,
    enabled: () => enabled,
    onError: (step) => errors.push(step),
    minIntervalMs: 0,
    safetyMs: 10_000,
  });
  changes++;
  scheduler.kick();
  await tick(20);
  assert.deepEqual(ran, []);
  enabled = true;
  scheduler.request();
  await tick(20);
  assert.deepEqual(errors, ['broken']);
  assert.deepEqual(ran, ['fine']);
  scheduler.stop();
});

test('the ledger reports the next schedule or budget period as background due time', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-due-')));
  const store = new ExecutionLedger(
    join(root, 'store.db'),
    readFileSync('docs/design/contracts/schema.sql', 'utf8'),
  );
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.startOwner('due-owner', true);
  const now = Date.now();
  assert.equal(store.nextBackgroundDueAt(now), null);
  const raw = new DatabaseSync(join(root, 'store.db'));
  try {
    raw
      .prepare("INSERT INTO budget_buckets VALUES ('due-bucket',?,NULL,'tokens',?,?,100,0,0)")
      .run(store.dotId, now - 1000, now + 5000);
  } finally {
    raw.close();
  }
  assert.equal(store.nextBackgroundDueAt(now), now + 5000);
  assert.equal(store.nextBackgroundDueAt(now + 6000), null, 'ended periods are ignored');
});
