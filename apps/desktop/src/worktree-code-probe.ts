import type { App, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { ExecutionLedger } from '../../../packages/store/src/ledger.ts';
import type { ForegroundExecution } from '../../../packages/runtime/src/execution.ts';
import { verifiedCodex } from '../../../packages/codex-adapter/src/binary.ts';
import { resolveWorkspaceGit } from '../../../packages/workspace/src/service.ts';
import { evidenceDir } from './evidence.ts';
import { DESKTOP_API_KEYS } from './api-keys.ts';
/** One explicitly requested model Turn, always through the existing ledger. No retry path. */
export async function runWorktreeCodeProbe(
  root: string,
  app: App,
  window: BrowserWindow,
  store: ExecutionLedger,
  execution: ForegroundExecution,
  source: string,
  database: string,
  preflight: boolean,
) {
  const original = readFileSync(resolve(source, 'src/math.mjs'), 'utf8');
  const git = (args: string[]) =>
    execFileSync(
      resolveWorkspaceGit(),
      ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-C', source, ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/var/empty',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  const sourceHead = git(['rev-parse', 'HEAD']).trim(),
    sourceStatus = git(['status', '--porcelain']);
  const prepared = await window.webContents.executeJavaScript(`(async()=>{
    const call=async p=>{const r=await p;if(!r.ok)throw Error(r.errorCode);return r.value;},wait=async f=>{const until=Date.now()+20000;while(!f()){if(Date.now()>until)throw Error('WORKTREE_CODE_PREPARE_TIMEOUT');await new Promise(r=>setTimeout(r,30));}},click=async s=>{await wait(()=>document.querySelector(s)&&!document.querySelector(s).disabled);document.querySelector(s).click();};
    await click('[data-action="choose-project"]');await click('[data-action="open-workspace"]');await wait(()=>document.querySelector('[data-worktree-name]'));await click('[data-worktree-tools] > summary');
    const state=await call(window.personalAgent.workspaceState()),sourceId=state.projects[0].id;
    const input=document.querySelector('[data-worktree-name]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'代码集成工作树');input.dispatchEvent(new Event('input',{bubbles:true}));await click('[data-action="create-worktree"]');await wait(()=>document.querySelector('[data-action="use-worktree"]'));
    const page=await call(window.personalAgent.listWorktrees({projectId:sourceId})),tree=page.worktrees[0];await click('[data-action="use-worktree"]');await wait(()=>document.querySelector('.project-select').value===tree.id);await wait(()=>document.querySelector('[data-workspace-path="src"]'));
    await click('[data-action="project-tasks"]');await wait(()=>document.querySelector('[data-code-profile]'));const mode=document.querySelector('[data-code-profile]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(mode,'code');mode.dispatchEvent(new Event('change',{bubbles:true}));await wait(()=>document.querySelector('[data-code-target]'));
    const fill=(s,v)=>{const e=document.querySelector(s);Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));};
    fill('[data-code-target]','test/math.test.mjs');fill('[data-code-paths]','src/math.mjs');fill('[data-task-draft]','Fix the sum(a,b) bug in src/math.mjs using the built-in apply_patch tool. Modify only src/math.mjs. The four frozen Node tests must pass. Do not modify tests, run Git, use network, or create any other files. Do not request escalation. The Host independently runs the frozen verification.');await wait(()=>!document.querySelector('[data-action="send"]').disabled);
    return{sourceId,workspaceId:tree.id,directory:tree.directory,baseCommit:tree.baseCommit,branch:tree.branch,created:page.operations[0].state==='completed',selected:document.querySelector('.project-select').value===tree.id,sendReady:!document.querySelector('[data-action="send"]').disabled};
  })()`);
  if (preflight) {
    const result = {
      created: prepared.created,
      selected: prepared.selected,
      sendReady: prepared.sendReady,
      noRuns:
        store.runs(prepared.sourceId).length === 0 && store.runs(prepared.workspaceId).length === 0,
      sourceUnchanged:
        readFileSync(resolve(source, 'src/math.mjs'), 'utf8') === original &&
        git(['status', '--porcelain']) === sourceStatus,
    };
    writeFileSync(
      resolve(evidenceDir(root), 'M2.1b-worktree-preflight.json'),
      JSON.stringify(
        {
          status: Object.values(result).every(Boolean) ? 'passed' : 'blocked',
          observedAt: new Date().toISOString(),
          kind: 'real_electron_git_code_form_preflight',
          inferenceRequested: false,
          history: 'synthetic_metadata',
          result,
        },
        null,
        2,
      ) + '\n',
    );
    app.quit();
    return;
  }
  const observed = await window.webContents.executeJavaScript(`(async()=>{
    const call=async p=>{const r=await p;if(!r.ok)throw Error(r.errorCode);return r.value;},projectId=${JSON.stringify(prepared.workspaceId)},until=Date.now()+200000,wait=async f=>{while(!f()){if(Date.now()>until)throw Error('WORKTREE_CODE_UI_TIMEOUT');await new Promise(r=>setTimeout(r,50));}};
    document.querySelector('[data-action="send"]').click();let view,declinedApprovals=0;
    while(Date.now()<until){const rows=await call(window.personalAgent.listRuns({projectId}));if(rows[0]){view=await call(window.personalAgent.getRun({projectId,runId:rows[0].runId}));if(['completed','failed','cancelled','outcome_unknown'].includes(view.status))break;const requests=await call(window.personalAgent.listInteractions({projectId,runId:view.runId}));for(const request of requests.filter(r=>r.state==='pending')){await call(window.personalAgent.replyInteraction({projectId,runId:view.runId,requestId:request.requestId,decision:'decline'}));declinedApprovals++;}}await new Promise(r=>setTimeout(r,200));}
    if(!view||view.status!=='completed')return{runId:view?.runId,runStatus:view?.status,taskStatus:view?.taskStatus,errorCode:view?.errorCode,declinedApprovals};
    const needsReviewBeforeVerification=view.taskStatus==='needs_review';await wait(()=>document.querySelector('[data-run-status="completed"]'));
    await wait(()=>document.querySelector('[data-run-diff]'));
    const diffShown=document.querySelector('[data-run-diff]').textContent.includes('src/math.mjs');document.querySelector('[data-action="verify-run"]').click();await wait(()=>document.querySelector('[data-verification-status="passed"]'));
    view=await call(window.personalAgent.getRun({projectId,runId:view.runId}));const review=await call(window.personalAgent.getVerification({projectId,runId:view.runId}));
    const nativeItems=view.snapshot.items.filter(i=>['command','files','tool','agent'].includes(i.kind)),rows=[...document.querySelectorAll('[data-tool-id]')];
    for(const row of rows)row.open=true;document.querySelector('[data-agent-tools]').scrollIntoView();
    return{runId:view.runId,runStatus:view.status,taskStatus:view.taskStatus,needsReviewBeforeVerification,mode:view.mode,diffShown,changedFiles:review.changedFiles,receipt:review.receipt,requiredCases:review.requiredCases,declinedApprovals,toolCount:nativeItems.length,toolPanelCount:rows.length,toolKinds:nativeItems.map(i=>i.kind),toolStates:nativeItems.map(i=>i.toolStatus??'unknown'),commandExitCodes:nativeItems.filter(i=>i.kind==='command').map(i=>i.exitCode??null),sandboxed:window.personalAgent.security.sandboxed,isolated:window.personalAgent.security.isolated,noRequire:typeof require==='undefined',apiCount:Object.keys(window.personalAgent).length};
  })()`);
  await execution.wait();
  const budget = store.resourceBudget(),
    db = new DatabaseSync(database, { readOnly: true });
  let durable;
  try {
    durable = {
      runs: Number(db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n),
      turnIntents: Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM execution_intents WHERE kind='turn_start' AND state='accepted'",
          )
          .get()!.n,
      ),
      worktrees: Number(
        db.prepare("SELECT count(*) AS n FROM managed_worktrees WHERE state='ready'").get()!.n,
      ),
    };
  } finally {
    db.close();
  }
  const receipt = observed.receipt;
  const checks = {
    created: prepared.created,
    selected: prepared.selected,
    oneManagedWorkspace: durable.worktrees === 1,
    oneRun:
      durable.runs === 1 &&
      store.runs(prepared.workspaceId).length === 1 &&
      store.runs(prepared.sourceId).length === 0,
    oneDurableTurn:
      durable.turnIntents === 1 &&
      execution.diagnostics.clientTurnStarts === 1 &&
      execution.diagnostics.clientThreadStarts === 1,
    sourceUnchanged:
      readFileSync(resolve(source, 'src/math.mjs'), 'utf8') === original &&
      git(['rev-parse', 'HEAD']).trim() === sourceHead &&
      git(['status', '--porcelain']) === sourceStatus,
    baseFrozen: prepared.baseCommit === sourceHead,
    needsReviewBeforeVerification: observed.needsReviewBeforeVerification === true,
    taskCompleted: observed.runStatus === 'completed' && observed.taskStatus === 'completed',
    workspaceWrite: observed.mode === 'workspaceWrite',
    onlyAllowedChange: JSON.stringify(observed.changedFiles) === JSON.stringify(['src/math.mjs']),
    independentVerification:
      receipt?.status === 'passed' &&
      receipt.exitCode === 0 &&
      receipt.discovered === 4 &&
      receipt.executed === 4 &&
      receipt.skipped === 0 &&
      observed.requiredCases === 4,
    diffShown: observed.diffShown === true,
    nativeToolRecords: observed.toolCount > 0 && observed.toolPanelCount === observed.toolCount,
    nativePolicyVerified: execution.diagnostics.nativePolicyVerified,
    usageSettled:
      budget.reportedTokens > 0 &&
      budget.reservedTokens === 0 &&
      budget.unknownHeldTokens === 0 &&
      budget.activeRuns === 0,
    sandboxed: observed.sandboxed === true,
    isolated: observed.isolated === true,
    noRequire: observed.noRequire === true,
    apiCount: observed.apiCount === DESKTOP_API_KEYS.length,
  };
  const passed = Object.values(checks).every(Boolean);
  writeFileSync(
    resolve(evidenceDir(root), 'M2.1b-worktree-native.json'),
    JSON.stringify(
      {
        status: passed ? 'passed' : 'blocked',
        observedAt: new Date().toISOString(),
        kind: 'real_electron_managed_worktree_native_code_and_independent_verification',
        backend: 'native_locked_app_server',
        history: 'synthetic_metadata',
        folderSelection: 'owned_fixture_substitution',
        platform: process.platform + '-' + process.arch,
        cliVersion: verifiedCodex(root).lock.cliVersion,
        inferenceRequested: true,
        attempts: 1,
        modelTurns: execution.diagnostics.clientTurnStarts,
        model: execution.diagnostics.selectedModel,
        reportedTokens: budget.reportedTokens,
        estimatedUsd: null,
        toolCount: observed.toolCount ?? 0,
        toolKinds: observed.toolKinds ?? [],
        toolStates: observed.toolStates ?? [],
        commandExitCodes: observed.commandExitCodes ?? [],
        receipt: receipt ?? null,
        declinedApprovals: observed.declinedApprovals,
        errorCode: observed.errorCode ?? null,
        result: checks,
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    resolve(root, '.local/M2.1b-worktree-native.png'),
    (await window.webContents.capturePage()).toPNG(),
  );
  app.quit();
}
