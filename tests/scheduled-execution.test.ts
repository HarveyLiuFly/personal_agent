import { terminalAvailable } from '../packages/workspace/src/terminal-binding.ts';
import { TerminalService } from '../packages/workspace/src/terminal.ts';
import { resolveVerifierNode } from '../packages/codex-adapter/src/launch.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { ForegroundExecution } from '../packages/runtime/src/execution.ts';
import { ScheduleService } from '../packages/runtime/src/schedules.ts';
import { StdioRpcClient } from '../packages/codex-adapter/src/rpc.ts';
import { SINGLE_RUN_POLICY } from './fixtures/policies.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8'),
  start = Date.parse('2026-11-03T03:00:00Z');
function fixture(t: { after(fn: () => unknown): void }, mode = 'ok', fault?: () => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-scheduled-execution-'))),
    cwd = join(root, 'project'),
    file = join(root, 'store.db');
  mkdirSync(cwd);
  let now = start,
    connections = 0;
  const store = new ExecutionLedger(file, schema, {
    budgetPolicy: SINGLE_RUN_POLICY,
    schedulerClock: () => now,
    afterScheduledClaimForTests: fault,
  });
  store.startOwner('scheduled-execution-owner', true);
  const project = store.registerWorkspace(cwd, cwd),
    db = new DatabaseSync(file);
  const execution = new ForegroundExecution(store, {
      executable: process.execPath,
      stateDirectory: join(root, 'state'),
      timeoutMs: 5000,
      interruptTimeoutMs: 40,
      connect: (callbacks) => {
        connections++;
        return new StdioRpcClient({
          executable: process.execPath,
          args: [resolve('tests/fixtures/execution-server.ts'), mode, file],
          ...callbacks,
        });
      },
    }),
    service = new ScheduleService(store, execution);
  t.after(async () => {
    await execution.close();
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const arm = (key = 'task', automatic = true) => {
    const task = store.taskCommand({
      projectId: project.id,
      commandKey: key,
      kind: 'create',
      text: 'public scheduled task ' + key,
    });
    return store.scheduleCommand({
      kind: 'create',
      projectId: project.id,
      taskId: task.taskId,
      expectedTaskVersion: 2,
      commandKey: 'schedule-' + key,
      config: {
        kind: 'once',
        timezone: 'UTC',
        atMs: start + 60000,
        expiresAtMs: start + 3600000,
        misfirePolicy: 'coalesce',
        overlapPolicy: 'coalesce',
        maxCatchUp: 1,
        ...(automatic ? { dispatchMode: 'execute_readonly_once' } : {}),
      },
    });
  };
  const due = () => {
    now = start + 60000;
    store.stepSchedules();
    store.deliverScheduleWakes();
  };
  return {
    root,
    cwd,
    file,
    store,
    project,
    db,
    execution,
    service,
    arm,
    due,
    clock: (at: number) => {
      now = at;
    },
    connections: () => connections,
  };
}
test('default queue-only schedules never dispatch; explicit readonly once uses one Run, source receipt and Intent pipeline', async (t) => {
  const f = fixture(t),
    queue = f.arm('queue', false),
    automatic = f.arm('auto');
  f.clock(start + 60000);
  f.service.step();
  await f.execution.wait();
  assert.equal(f.connections(), 1);
  assert.equal(f.execution.diagnostics.clientTurnStarts, 1);
  assert.equal(f.store.runs(f.project.id).length, 1);
  assert.equal(
    f.store.tasks(f.project.id).find((x) => x.taskId === queue.taskId)!.status,
    'queued',
  );
  assert.equal(
    f.store.tasks(f.project.id).find((x) => x.taskId === automatic.taskId)!.status,
    'needs_review',
  );
  assert.equal(
    f.store.schedules(f.project.id).find((s) => s.scheduleId === automatic.scheduleId)!
      .dispatchState,
    'dispatched',
  );
  const trigger = f.store.scheduleOccurrences(f.project.id, automatic.scheduleId)[0]!.triggerId!,
    original = f.store.runs(f.project.id)[0]!;
  assert.equal(f.execution.startScheduled(f.project.id, trigger).runId, original.runId);
  for (let n = 0; n < 3; n++) f.service.step();
  assert.equal(f.connections(), 1);
  assert.equal(f.execution.diagnostics.clientTurnStarts, 1);
  assert.equal(f.store.scheduledCandidates().length, 0);
  assert.ok(
    JSON.parse(
      String(
        f.db.prepare('SELECT module_hashes_json FROM prompt_manifests').get()!.module_hashes_json,
      ),
    ).schedule,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) AS n FROM execution_intents WHERE state='accepted' AND kind='turn_start'",
      )
      .get()!.n,
    1,
  );
});
test('automatic Cron and workspace-write profiles are rejected without granting execution', (t) => {
  const f = fixture(t),
    task = f.store.taskCommand({
      projectId: f.project.id,
      commandKey: 'code',
      kind: 'create',
      text: 'code fixture',
      code: { profile: 'node-test', target: 'test.mjs', allowedPaths: ['math.mjs'] },
    }),
    config = {
      kind: 'once',
      timezone: 'UTC',
      atMs: start + 60000,
      expiresAtMs: start + 3600000,
      misfirePolicy: 'coalesce',
      overlapPolicy: 'coalesce',
      maxCatchUp: 1,
      dispatchMode: 'execute_readonly_once',
    };
  assert.throws(
    () =>
      f.store.scheduleCommand({
        kind: 'create',
        projectId: f.project.id,
        taskId: task.taskId,
        expectedTaskVersion: 2,
        commandKey: 'auto-code',
        config,
      }),
    /SCHEDULE_EXECUTION_MODE_UNAVAILABLE/,
  );
  const { atMs, ...cron } = config;
  assert.throws(
    () =>
      f.store.scheduleCommand({
        kind: 'create',
        projectId: f.project.id,
        taskId: task.taskId,
        expectedTaskVersion: 2,
        commandKey: 'auto-cron',
        config: { ...cron, kind: 'cron', expression: '* * * * *' },
      }),
    /SCHEDULE_EXECUTION_MODE_UNAVAILABLE/,
  );
  assert.equal(f.store.schedules(f.project.id).length, 0);
  assert.equal(f.connections(), 0);
});
test('old contract v1 retains queue-only permission, and never acquires execute permission on upgrade', (t) => {
  const f = fixture(t),
    s = f.arm('old', false),
    row = f.db.prepare('SELECT spec_json FROM schedules').get()!,
    spec = JSON.parse(String(row.spec_json));
  spec.contractVersion = 1;
  f.db.prepare('UPDATE schedules SET spec_json=?').run(JSON.stringify(spec));
  f.clock(start + 60000);
  f.service.step();
  assert.equal(f.connections(), 0);
  assert.equal(f.store.tasks(f.project.id)[0]!.status, 'queued');
  assert.equal(f.store.schedules(f.project.id)[0]!.dispatchState, 'not_requested');
  assert.throws(
    () =>
      f.store.claimScheduledTask(
        f.project.id,
        f.store.scheduleOccurrences(f.project.id, s.scheduleId)[0]!.triggerId!,
      ),
    /SCHEDULE_DISPATCH_REVOKED/,
  );
});
test('saved wake version defeats a later Task edit instead of using the latest version', (t) => {
  const f = fixture(t),
    s = f.arm();
  f.due();
  const task = f.store.tasks(f.project.id)[0]!;
  f.store.taskCommand({
    kind: 'rename',
    projectId: f.project.id,
    taskId: task.taskId,
    expectedVersion: task.version,
    commandKey: 'edited-after-wake',
    title: 'edited before dispatch',
  });
  f.service.step();
  assert.equal(f.connections(), 0);
  assert.equal(f.store.runs(f.project.id).length, 0);
  assert.equal(
    f.db.prepare('SELECT reason_code FROM trigger_deliveries').get()!.reason_code,
    'AUTO_SKIPPED_TASK_VERSION_CONFLICT',
  );
  assert.equal(f.store.schedules(f.project.id)[0]!.dispatchState, 'stopped');
  assert.equal(f.store.tasks(f.project.id)[0]!.status, 'queued');
});
test('budget waits create no Run or RPC and resume only after the blocking real period expires', async (t) => {
  const f = fixture(t);
  f.arm();
  f.due();
  const at = Date.now();
  f.db
    .prepare("INSERT INTO budget_buckets VALUES ('controlled-period',?,NULL,'tokens',?,?,0,0,0)")
    .run(f.store.dotId, at - 1, at + 500);
  f.service.step();
  assert.equal(f.connections(), 0);
  assert.equal(f.store.runs(f.project.id).length, 0);
  assert.equal(
    f.db.prepare('SELECT reason_code FROM trigger_deliveries').get()!.reason_code,
    'AUTO_WAIT_TOKEN_BUDGET_EXHAUSTED',
  );
  const events = f.db.prepare('SELECT COUNT(*) AS n FROM task_events').get()!.n;
  f.service.step();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_events').get()!.n, events);
  await new Promise((done) => setTimeout(done, 600));
  f.service.step();
  await f.execution.wait();
  assert.equal(f.connections(), 1);
  assert.equal(f.store.runs(f.project.id).length, 1);
  assert.equal(f.execution.diagnostics.clientTurnStarts, 1);
});
test('revoking a queued automatic schedule stops dispatch while leaving its already applied wake factual', (t) => {
  const f = fixture(t),
    s = f.arm();
  f.due();
  f.store.scheduleCommand({
    kind: 'cancel',
    projectId: f.project.id,
    scheduleId: s.scheduleId,
    expectedVersion: 1,
    commandKey: 'revoke-auto',
  });
  f.service.step();
  assert.equal(f.connections(), 0);
  assert.equal(f.store.tasks(f.project.id)[0]!.status, 'queued');
  assert.equal(f.store.scheduledCandidates().length, 0);
  assert.equal(
    f.store.scheduleOccurrences(f.project.id, s.scheduleId)[0]!.deliveryState,
    'acknowledged',
  );
  assert.equal(f.store.schedules(f.project.id)[0]!.dispatchState, 'stopped');
});
test('automatic work waits for the existing foreground execution without taking its session', async (t) => {
  const f = fixture(t, 'slow'),
    manual = f.execution.submit({
      projectId: f.project.id,
      text: 'public foreground fixture',
      submissionKey: 'manual',
    }),
    scheduled = f.arm();
  f.clock(start + 60000);
  f.service.step();
  assert.equal(f.store.runs(f.project.id).length, 1);
  assert.equal(f.store.runs(f.project.id)[0]!.runId, manual.runId);
  assert.equal(
    f.store.tasks(f.project.id).find((t) => t.taskId === scheduled.taskId)!.status,
    'queued',
  );
  await f.execution.wait();
  f.service.step();
  await f.execution.wait();
  assert.equal(f.store.runs(f.project.id).length, 2);
  assert.equal(f.execution.diagnostics.clientTurnStarts, 2);
  assert.equal(f.connections(), 2);
});
test('Source, policy, privacy and deadline are rechecked after queue delivery and before Run creation', (t) => {
  for (const change of ['source', 'policy', 'privacy', 'expiry']) {
    const f = fixture(t);
    f.arm();
    f.due();
    if (change === 'source') f.db.exec('UPDATE sources SET enabled=0');
    else if (change === 'policy') f.db.exec('UPDATE dots SET policy_epoch=policy_epoch+1');
    else if (change === 'privacy') f.db.exec('UPDATE dots SET privacy_epoch=privacy_epoch+1');
    else f.clock(start + 3600000);
    f.service.step();
    assert.equal(f.connections(), 0, change);
    assert.equal(f.store.runs(f.project.id).length, 0, change);
    assert.equal(f.store.scheduledCandidates().length, 0, change);
  }
});
test('unknown scheduled execution is never repeated by a new pump, key, or direct Host call', async (t) => {
  const f = fixture(t, 'interrupt-timeout'),
    s = f.arm();
  f.clock(start + 60000);
  f.service.step();
  const deadline = Date.now() + 3000;
  while (!f.store.runs(f.project.id)[0]?.turnId) {
    if (Date.now() > deadline) throw new Error('SCHEDULED_TURN_TIMEOUT');
    await new Promise((done) => setTimeout(done, 10));
  }
  const run = f.store.runs(f.project.id)[0]!;
  await f.execution.interrupt({ projectId: f.project.id, runId: run.runId });
  await f.execution.wait();
  assert.equal(f.store.runs(f.project.id)[0]!.status, 'outcome_unknown');
  const next = new ScheduleService(f.store, f.execution);
  for (let n = 0; n < 3; n++) next.step();
  assert.equal(
    f.execution.startScheduled(
      f.project.id,
      f.store.scheduleOccurrences(f.project.id, s.scheduleId)[0]!.triggerId!,
    ).runId,
    run.runId,
  );
  assert.equal(f.connections(), 1);
  assert.equal(f.execution.diagnostics.clientTurnStarts, 1);
  assert.equal(f.store.runs(f.project.id).length, 1);
  assert.throws(
    () =>
      f.store.scheduleCommand({
        kind: 'create',
        projectId: f.project.id,
        taskId: s.taskId,
        expectedTaskVersion: f.store.tasks(f.project.id)[0]!.version,
        commandKey: 'new-key-after-unknown',
        config: { ...s.config!, atMs: start + 120000 },
      }),
    /TASK_NOT_SCHEDULABLE/,
  );
});
test('claim rollback leaves no Run, source event, manifest or reservation before a safe first claim', (t) => {
  let fault = true;
  const f = fixture(t, 'ok', () => {
    if (fault) throw new Error('controlled scheduled claim fault');
  });
  f.arm();
  f.due();
  const trigger = f.store.scheduledCandidates()[0]!.triggerId;
  assert.throws(() => f.store.claimScheduledTask(f.project.id, trigger), /controlled/);
  assert.equal(f.store.runs(f.project.id).length, 0);
  assert.equal(f.store.resourceBudget().reservedTokens, 0);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM task_events WHERE event_type='scheduled_run_claimed'")
      .get()!.n,
    0,
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM prompt_manifests').get()!.n, 0);
  fault = false;
  assert.equal(f.store.claimScheduledTask(f.project.id, trigger).created, true);
  assert.equal(f.store.claimScheduledTask(f.project.id, trigger).created, false);
});
test('real SIGKILL around scheduled Run commit never repeats a committed claim after restart', async (t) => {
  for (const phase of ['inside', 'committed']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-scheduled-claim-crash-'))),
      cwd = join(root, 'project'),
      file = join(root, 'store.db');
    mkdirSync(cwd);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = spawn(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          'tests/fixtures/scheduled-claim-worker.ts',
          file,
          cwd,
          phase,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      ),
      closed = once(child, 'close');
    t.after(() => child.kill('SIGKILL'));
    let buffer = '';
    const ready = await new Promise<{ projectId: string; triggerId: string }>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('SCHEDULED_CLAIM_CHILD_TIMEOUT'));
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
    assert.equal(
      before.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n,
      phase === 'committed' ? 1 : 0,
    );
    before.close();
    child.kill('SIGKILL');
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    const store = new ExecutionLedger(file, schema, { schedulerClock: () => start + 60000 });
    store.startOwner('recovered-after-owned-child-exit', true);
    try {
      const claimed = store.claimScheduledTask(ready.projectId, ready.triggerId);
      assert.equal(claimed.created, phase === 'inside');
      assert.equal(store.runs(ready.projectId).length, 1);
      if (phase === 'committed') {
        assert.equal(store.runs(ready.projectId)[0]!.status, 'outcome_unknown');
        assert.equal(store.scheduledCandidates().length, 0);
      }
      assert.equal(store.claimScheduledTask(ready.projectId, ready.triggerId).created, false);
      t.diagnostic(
        'SCHEDULED_CLAIM_CRASH_RECEIPT ' +
          JSON.stringify({
            phase,
            signal,
            exitCode: code,
            ...ready,
            runId: claimed.token.runId,
            newClaimAfterRecovery: claimed.created,
            runStatus: store.runs(ready.projectId)[0]!.status,
            totalRuns: 1,
            rpcOrModelStarted: false,
          }),
      );
    } finally {
      store.close();
    }
  }
});

test(
  'real user PTY makes automatic scheduling wait without a Run, then one synthetic dispatch follows close',
  { skip: !terminalAvailable() },
  async (t) => {
    const f = fixture(t),
      schedule = f.arm('terminal-wait'),
      terminal = new TerminalService(f.store, {
        node: resolveVerifierNode(resolve('.')),
        worker: resolve('packages/workspace/src/terminal-worker.mjs'),
        stateDirectory: join(f.root, 'terminals'),
      });
    try {
      const opened = await terminal.open({
        projectId: f.project.id,
        commandKey: 'terminal',
        cols: 80,
        rows: 24,
      });
      f.due();
      f.service.step();
      assert.equal(f.connections(), 0);
      assert.equal(f.store.runs(f.project.id).length, 0);
      assert.equal(f.store.resourceBudget().reservedTokens, 0);
      assert.equal(
        f.db.prepare('SELECT reason_code FROM trigger_deliveries').get()!.reason_code,
        'AUTO_WAIT_WORKSPACE_TERMINAL_ACTIVE',
      );
      assert.equal(f.store.scheduledCandidates().length, 1);
      await terminal.close({
        projectId: f.project.id,
        sessionId: opened.session!.sessionId,
        commandKey: 'stop',
      });
      f.service.step();
      await f.execution.wait();
      assert.equal(f.connections(), 1);
      assert.equal(f.execution.diagnostics.clientTurnStarts, 1);
      assert.equal(
        f.db.prepare('SELECT reason_code FROM trigger_deliveries').get()!.reason_code,
        'AUTO_DISPATCHED',
      );
    } finally {
      await terminal.stop();
    }
  },
);
