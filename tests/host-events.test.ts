import assert from 'node:assert/strict';
import test from 'node:test';
import { HostEvents } from '../apps/desktop/src/host-events.ts';
import type { HostEvent } from '../apps/desktop/src/bridge.ts';

const tick = (ms: number) => new Promise((done) => setTimeout(done, ms));

test('ledger writes become one coalesced notice; no writes, no notice', async () => {
  let changes = 0;
  const sent: HostEvent[] = [];
  const events = new HostEvents(
    (event) => sent.push(event),
    () => changes,
    undefined,
    20,
  );
  events.check();
  await tick(40);
  assert.equal(sent.length, 0, 'nothing written, nothing sent');
  changes = 3;
  events.check();
  changes = 5;
  events.check();
  events.emit('terminal', 'project-a');
  events.emit('terminal', 'project-a');
  events.emit('terminal', 'project-b');
  await tick(40);
  assert.deepEqual(
    sent.map(({ topic, projectId }) => [topic, projectId ?? null]),
    [
      ['store', null],
      ['terminal', 'project-a'],
      ['terminal', 'project-b'],
    ],
  );
  assert.deepEqual(
    sent.map((event) => event.seq),
    [1, 2, 3],
  );
  events.close();
});

test('the Run watch checks only while Runs are active, then stops by itself', async () => {
  let changes = 0,
    active = true,
    reads = 0;
  const sent: HostEvent[] = [];
  const events = new HostEvents(
    (event) => sent.push(event),
    () => {
      reads++;
      return changes;
    },
    undefined,
    5,
  );
  events.watchWhile(() => active, 10);
  changes = 1;
  await tick(40);
  assert.ok(sent.length >= 1, 'a streaming write is noticed without any request');
  active = false;
  await tick(40);
  const after = reads;
  await tick(60);
  assert.equal(reads, after, 'no more reads once idle');
  events.close();
});

test('Renderer refreshes on notices, never overlapping, and resyncs after a gap', async () => {
  let deliver: ((event: HostEvent) => void) | undefined;
  (globalThis as { window?: unknown }).window = {
    personalAgent: {
      onEvent(listener: (event: HostEvent) => void) {
        deliver = listener;
        return () => {};
      },
    },
  };
  const { subscribeRefresh, nextHostEvent } =
    await import('../apps/desktop/renderer/host-events.ts');
  let storeCalls = 0,
    inFlight = 0,
    overlap = false;
  const stopStore = subscribeRefresh(async () => {
    storeCalls++;
    inFlight++;
    if (inFlight > 1) overlap = true;
    await tick(15);
    inFlight--;
  });
  let terminalCalls = 0;
  const stopTerminal = subscribeRefresh(() => void terminalCalls++, {
    topics: ['terminal'],
    projectId: 'project-a',
  });
  await tick(30);
  assert.equal(storeCalls, 1, 'initial load');
  assert.equal(terminalCalls, 1);
  deliver!({ seq: 1, topic: 'store' });
  deliver!({ seq: 2, topic: 'store' });
  deliver!({ seq: 3, topic: 'store' });
  await tick(60);
  assert.equal(storeCalls, 3, 'notices during a refresh collapse into one follow-up');
  assert.equal(overlap, false);
  deliver!({ seq: 4, topic: 'terminal', projectId: 'project-b' });
  await tick(10);
  assert.equal(terminalCalls, 1, 'another project terminal is ignored');
  deliver!({ seq: 5, topic: 'terminal', projectId: 'project-a' });
  await tick(10);
  assert.equal(terminalCalls, 2);
  deliver!({ seq: 9, topic: 'store' });
  await tick(40);
  assert.equal(terminalCalls, 3, 'a sequence gap refreshes every subscriber');
  const waited = nextHostEvent('store', 1000);
  deliver!({ seq: 10, topic: 'store' });
  await waited;
  const started = Date.now();
  await nextHostEvent('store', 30);
  assert.ok(Date.now() - started >= 25, 'falls back to the timeout');
  stopStore();
  stopTerminal();
  delete (globalThis as { window?: unknown }).window;
});
