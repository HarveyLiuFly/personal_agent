import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { processGone, processMarker } from '../packages/runtime/src/process-liveness.ts';

test('a process instance is gone only once its PID ends or belongs to another start', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const pid = child.pid!;
  const marker = processMarker(pid);
  if (process.platform === 'linux' || process.platform === 'darwin') assert.ok(marker);
  assert.equal(processGone(pid, marker), false, 'still running');
  assert.equal(processGone(pid, null), false, 'alive without a marker is not proof');
  if (marker)
    assert.equal(processGone(pid, marker + '-other'), true, 'PID reused by another start');
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.equal(processGone(pid, marker), true);
  assert.equal(processMarker(pid), null);
  assert.equal(processGone(1.5, null), false);
});
