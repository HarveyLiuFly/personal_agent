import { readFileSync } from 'node:fs';
import { ExecutionLedger } from '../../packages/store/src/ledger.ts';
const [file, cwd, phase] = process.argv.slice(2),
  start = Date.parse('2026-11-03T03:00:00Z');
let now = start,
  ready: { projectId: string; triggerId: string };
const stop = () => {
  process.stdout.write(JSON.stringify(ready) + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
};
const store = new ExecutionLedger(file!, readFileSync('docs/design/contracts/schema.sql', 'utf8'), {
  schedulerClock: () => now,
  ...(phase === 'inside' ? { afterScheduledClaimForTests: stop } : {}),
});
store.startOwner('owned-scheduled-claim-fixture', true);
const project = store.registerWorkspace(cwd!, cwd!),
  task = store.taskCommand({
    kind: 'create',
    projectId: project.id,
    commandKey: 'task',
    text: 'public scheduled claim crash fixture',
  });
store.scheduleCommand({
  kind: 'create',
  projectId: project.id,
  taskId: task.taskId,
  expectedTaskVersion: 2,
  commandKey: 'schedule',
  config: {
    kind: 'once',
    timezone: 'UTC',
    atMs: start + 60000,
    expiresAtMs: start + 3600000,
    misfirePolicy: 'coalesce',
    overlapPolicy: 'coalesce',
    maxCatchUp: 1,
    dispatchMode: 'execute_readonly_once',
  },
});
now = start + 60000;
store.stepSchedules();
store.deliverScheduleWakes();
ready = { projectId: project.id, triggerId: store.scheduledCandidates()[0]!.triggerId };
store.claimScheduledTask(ready.projectId, ready.triggerId);
if (phase === 'committed') stop();
store.close();
