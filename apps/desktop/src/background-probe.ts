import type { App, BrowserWindow } from 'electron';
import { BrowserWindow as Windows } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import type { ExecutionLedger } from '../../../packages/store/src/ledger.ts';
import type { ForegroundExecution } from '../../../packages/runtime/src/execution.ts';
import { verifiedCodex } from '../../../packages/codex-adapter/src/binary.ts';
import { evidenceDir } from './evidence.ts';
/** Fixed owned fixture. Termination targets only this harness's BrowserWindow renderer PID. */
export async function runBackgroundProbe(
  root: string,
  app: App,
  initial: BrowserWindow,
  store: ExecutionLedger,
  execution: ForegroundExecution,
  ledgerFile: string,
  show: () => Promise<BrowserWindow>,
  native: boolean,
) {
  const owner = () => {
      const db = new DatabaseSync(ledgerFile, { readOnly: true });
      try {
        return db.prepare('SELECT runtime_epoch,instance_id,state FROM runtime_owners').get()!;
      } finally {
        db.close();
      }
    },
    before = owner(),
    mainPid = process.pid,
    rendererPid = initial.webContents.getOSProcessId();
  const text = native
    ? 'Reply exactly M2_BACKGROUND_NATIVE_OK. Do not use tools or modify files.'
    : 'Public synthetic background lifecycle fixture';
  const armed = await initial.webContents.executeJavaScript(`(async()=>{
  const wait=async check=>{const end=Date.now()+15000;while(!await check()){if(Date.now()>end)throw new Error('BACKGROUND_UI_TIMEOUT');await new Promise(r=>setTimeout(r,30));}};
  const call=async p=>{const r=await p;if(!r.ok)throw new Error(r.errorCode);return r.value;};document.querySelector('[data-action="choose-project"]').click();await wait(()=>document.querySelector('[data-action="open-tasks"]')&&!document.querySelector('[data-action="open-tasks"]').disabled);document.querySelector('[data-action="open-tasks"]').click();await wait(()=>document.querySelector('[data-task-manager]'));
  const projectId=(await call(window.personalAgent.workspaceState())).projects[0].id,task=await call(window.personalAgent.applyTaskCommand({kind:'create',projectId,commandKey:'background-task',text:${JSON.stringify(text)}})),due=Date.now()+2500;
  const schedule=await call(window.personalAgent.applyScheduleCommand({kind:'create',projectId,taskId:task.taskId,expectedTaskVersion:task.taskVersion,commandKey:'background-schedule',config:{kind:'once',timezone:'UTC',atMs:due,expiresAtMs:due+120000,misfirePolicy:'coalesce',overlapPolicy:'coalesce',maxCatchUp:1,dispatchMode:'execute_readonly_once'}}));
  return{projectId,taskId:task.taskId,scheduleId:schedule.scheduleId,dueAtMs:due,noEarlyRun:(await call(window.personalAgent.listRuns({projectId}))).length===0};
 })()`);
  if (rendererPid < 1 || rendererPid === process.pid)
    throw new Error('BACKGROUND_RENDERER_PID_INVALID');
  const gone = once(initial.webContents, 'render-process-gone');
  process.kill(rendererPid, 'SIGKILL');
  const [, details] = await gone;
  initial.destroy();
  const closedAtMs = Date.now();
  if (Windows.getAllWindows().length !== 0) throw new Error('BACKGROUND_WINDOW_NOT_CLOSED');
  const deadline = Date.now() + (native ? 150000 : 15000);
  let allWindowless = true;
  while (true) {
    allWindowless &&= Windows.getAllWindows().length === 0;
    const run = store.runs(armed.projectId)[0];
    if (run && ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(run.status)) break;
    if (Date.now() > deadline) throw new Error('BACKGROUND_RUN_TIMEOUT');
    await new Promise((done) => setTimeout(done, 40));
  }
  await execution.wait();
  const run = store.runs(armed.projectId)[0]!,
    budget = store.resourceBudget(),
    completedAtMs = Date.now(),
    afterRun = owner(),
    schedule = store.schedules(armed.projectId).find((s) => s.scheduleId === armed.scheduleId)!;
  const [reopened, duplicate] = await Promise.all([show(), show()]);
  const recovered = await reopened.webContents.executeJavaScript(`(async()=>{
  const wait=async check=>{const end=Date.now()+15000;while(!await check()){if(Date.now()>end)throw new Error('BACKGROUND_REOPEN_TIMEOUT');await new Promise(r=>setTimeout(r,30));}};await wait(()=>document.querySelector('[data-queued-status="needs_review"]'));
  document.querySelector('[data-action="open-automation"]').click();await wait(()=>document.querySelector('[data-schedule-manager]'));document.querySelector('[data-schedule-manager]').open=true;await wait(()=>document.querySelector('[data-schedule-dispatch="dispatched"]'));document.querySelector('[data-schedule-dispatch="dispatched"]').scrollIntoView({block:'start'});await new Promise(r=>setTimeout(r,80));
  const state=await window.personalAgent.workspaceState(),runs=await window.personalAgent.listRuns({projectId:${JSON.stringify(armed.projectId)}});return{backgroundEnabled:state.value.backgroundEnabled,sameRun:runs.value.length===1&&runs.value[0].runId===${JSON.stringify(run.runId)},taskVisible:document.querySelector('[data-queued-status="needs_review"]')!==null,sandboxed:window.personalAgent.security.sandboxed,isolated:window.personalAgent.security.isolated,hasRequire:typeof require!=='undefined'};
 })()`),
    afterReopen = owner();
  const reply =
      run.snapshot?.items
        .filter((i) => i.role === 'assistant' && i.kind === 'message')
        .map((i) => i.text)
        .join('') ?? '',
    toolItems =
      run.snapshot?.items.filter((i) => ['command', 'files', 'tool'].includes(i.kind)).length ?? 0;
  const checks = {
    noEarlyRun: armed.noEarlyRun,
    realRendererKilled: details.reason === 'killed' || details.reason === 'crashed',
    windowClosedBeforeDue: closedAtMs < armed.dueAtMs,
    completedWithNoWindows:
      allWindowless && run.status === 'completed' && run.taskStatus === 'needs_review',
    sameMainProcess: mainPid === process.pid,
    ownerEpochUnchanged:
      before.runtime_epoch === afterRun.runtime_epoch &&
      before.runtime_epoch === afterReopen.runtime_epoch,
    ownerInstanceUnchanged:
      before.instance_id === afterRun.instance_id && before.instance_id === afterReopen.instance_id,
    singleReopenedWindow: reopened.id === duplicate.id && Windows.getAllWindows().length === 1,
    sameRun: recovered.sameRun,
    taskVisible: recovered.taskVisible,
    backgroundEnabled: recovered.backgroundEnabled,
    sourceRunLinked: schedule.runId === run.runId,
    oneTurn: execution.diagnostics.clientTurnStarts === 1,
    noTools: toolItems === 0,
    usageSettled:
      budget.reportedTokens > 0 &&
      budget.reservedTokens === 0 &&
      budget.unknownHeldTokens === 0 &&
      budget.activeRuns === 0,
    expectedReply: !native || reply.trim() === 'M2_BACKGROUND_NATIVE_OK',
    sandboxed: recovered.sandboxed,
    isolated: recovered.isolated,
    noRequire: !recovered.hasRequire,
  };
  const passed = Object.values(checks).every((v) => v === true),
    name = native ? 'M2.4a-native-background' : 'M2.4a-desktop';
  writeFileSync(
    join(evidenceDir(root), name + '.json'),
    JSON.stringify(
      {
        status: passed ? 'passed' : 'blocked',
        observedAt: new Date().toISOString(),
        kind: 'real_electron_renderer_sigkill_windowless_schedule_and_reopen',
        backend: native ? 'native_locked_app_server' : 'synthetic_stdio',
        platform: process.platform + '-' + process.arch,
        cliVersion: native ? verifiedCodex(root).lock.cliVersion : null,
        inferenceRequested: native,
        attempts: 1,
        modelTurns: native ? execution.diagnostics.clientTurnStarts : 0,
        syntheticTurnStarts: native ? 0 : execution.diagnostics.clientTurnStarts,
        model: native ? execution.diagnostics.selectedModel : null,
        mainPid,
        rendererPid,
        rendererTerminationReason: details.reason,
        closedAtMs,
        dueAtMs: armed.dueAtMs,
        completedAtMs,
        ownerEpoch: before.runtime_epoch,
        runId: run.runId,
        taskId: armed.taskId,
        scheduleId: armed.scheduleId,
        reportedTokens: budget.reportedTokens,
        estimatedUsd: null,
        requestedExplicitQuit: true,
        independentDaemonClaimed: false,
        result: checks,
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(root, '.local/' + name + '.png'),
    (await reopened.webContents.capturePage()).toPNG(),
  );
  app.quit();
}
