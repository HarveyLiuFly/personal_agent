import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MainResourceSampler } from '../packages/runtime/src/resources.ts';
test('first CPU sample is unknown, RSS is real input, and a monotonic interval yields one-core percentage', () => {
  let at = 0,
    user = 100000,
    system = 100000,
    wall = 10000;
  const sampler = new MainResourceSampler({
    monotonic: () => at,
    wallClock: () => wall,
    read: () => ({ user, system, rssBytes: 67108864 }),
  });
  const first = sampler.sample();
  assert.equal(first.cpuPercent, null);
  assert.equal(first.rssBytes, 67108864);
  assert.equal(first.scope, 'main_process');
  at = 1000;
  wall = 11000;
  user += 450000;
  system += 50000;
  assert.equal(sampler.sample().cpuPercent, 50);
  at = 2000;
  wall = 12000;
  user += 1500000;
  assert.equal(sampler.sample().cpuPercent, 150);
});
test('sampling cache avoids repeated reads, returned views cannot mutate it, and wall-clock jumps do not change CPU math', () => {
  let at = 1000,
    wall = 10000,
    reads = 0,
    user = 0;
  const sampler = new MainResourceSampler({
    monotonic: () => at,
    wallClock: () => wall,
    read: () => {
      reads++;
      return { user, system: 0, rssBytes: 1024 };
    },
  });
  sampler.sample().rssBytes = 1;
  at = 1500;
  assert.equal(sampler.sample().rssBytes, 1024);
  assert.equal(reads, 1);
  at = 2000;
  wall = 500;
  user = 250000;
  const next = sampler.sample();
  assert.equal(next.cpuPercent, 25);
  assert.equal(next.observedAt, 500);
  assert.equal(reads, 2);
});
test('backwards monotonic time, counter reset and invalid CPU input remain unknown rather than fabricate usage', () => {
  let at = 1000,
    user = 10;
  const sampler = new MainResourceSampler({
    monotonic: () => at,
    wallClock: () => 10000,
    read: () => ({ user, system: 0, rssBytes: 1024 }),
  });
  sampler.sample();
  at = 500;
  assert.equal(sampler.sample().cpuPercent, null);
  at = 1500;
  user = 5;
  assert.equal(sampler.sample().cpuPercent, null);
  at = 2500;
  user = NaN;
  assert.equal(sampler.sample().cpuPercent, null);
  at = 3500;
  user = 20;
  assert.equal(sampler.sample().cpuPercent, null);
  at = 4500;
  user = 20;
  assert.equal(sampler.sample().cpuPercent, 0);
  at = 50000;
  assert.equal(sampler.sample().cpuPercent, null);
  at = 51000;
  assert.equal(sampler.sample().cpuPercent, 0);
});
test('invalid RSS and timestamps reject instead of displaying zero, while native sampler returns bounded metadata only', () => {
  for (const rssBytes of [0, -1, NaN, Infinity])
    assert.throws(
      () => new MainResourceSampler({ read: () => ({ user: 0, system: 0, rssBytes }) }).sample(),
      /RESOURCE_SAMPLE_INVALID/,
    );
  assert.throws(
    () => new MainResourceSampler({ wallClock: () => NaN }).sample(),
    /RESOURCE_SAMPLE_INVALID/,
  );
  const actual = new MainResourceSampler().sample();
  assert.ok(actual.rssBytes > 0);
  assert.equal(actual.cpuPercent, null);
  assert.deepEqual(Object.keys(actual).sort(), [
    'basis',
    'cpuPercent',
    'observedAt',
    'rssBytes',
    'scope',
  ]);
  assert.equal(JSON.stringify(actual).includes(process.cwd()), false);
});
