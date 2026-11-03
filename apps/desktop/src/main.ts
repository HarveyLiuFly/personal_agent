import {runWorktreeRecoveryProbe} from './worktree-recovery-probe.ts';
import {runToolProbe} from './tool-probe.ts';
import {BackupService} from '../../../packages/backup/src/service.ts';
import {runBackupProbe} from './backup-probe.ts';
import {MainResourceSampler} from '../../../packages/runtime/src/resources.ts';
import {runResourceProbe} from './resource-probe.ts';
import type {BackupCommand} from '../../../packages/contracts/src/backups.ts';
import {runWorktreeCodeProbe} from './worktree-code-probe.ts';
import {runTerminalProbe} from './terminal-probe.ts';
import {TerminalService} from '../../../packages/workspace/src/terminal.ts';
import {createWorktreeFixture,runWorktreeProbe} from './worktree-probe.ts';
import {WorktreeService} from '../../../packages/workspace/src/worktrees.ts';
import type {WorktreeCommand} from '../../../packages/contracts/src/worktrees.ts';
import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createCodeFixture } from '../../../tests/fixtures/code-project.ts';
import { randomUUID } from 'node:crypto';
import { ExecutionLedger, LedgerError } from '../../../packages/store/src/ledger.ts';
import { NodeVerification } from '../../../packages/verification/src/verification.ts';
import { ForegroundExecution } from '../../../packages/runtime/src/execution.ts';
import { HistoryReconciliation } from '../../../packages/runtime/src/reconciliation.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectConnection } from '../../../packages/codex-adapter/src/smoke.ts';
import { resolveExecutable, resolveVerifierNode } from '../../../packages/codex-adapter/src/launch.ts';
import { verifiedCodex } from '../../../packages/codex-adapter/src/binary.ts';
import { RpcFailure, StdioRpcClient } from '../../../packages/codex-adapter/src/rpc.ts';
import { HistoryBrowser } from '../../../packages/codex-adapter/src/history.ts';
import type { ReadPort } from '../../../packages/codex-adapter/src/history.ts';
import { readConnection } from '../../../packages/codex-adapter/src/read-connection.ts';
import { runtimeEnvironment } from '../../../packages/codex-adapter/src/launch.ts';
import type { HostResult } from '../../../packages/contracts/src/views.ts';
import type { ConnectionInfo } from './bridge.ts';
import {nativeProbe,rejectedSecondary,runNativeProbe} from './native-probes.ts';
import {WorkspaceService,resolveWorkspaceGit} from '../../../packages/workspace/src/service.ts';
import {TaskService} from '../../../packages/runtime/src/tasks.ts';
import {OutboxPump} from '../../../packages/runtime/src/outbox.ts';
import {runTaskProbe} from './task-probe.ts';
import {runPlanProbe} from './plan-probe.ts';
import {runScheduleProbe} from './schedule-probe.ts';
import {ScheduleService} from '../../../packages/runtime/src/schedules.ts';
import {createDesktopWindow} from './desktop-window.ts';
import {runBackgroundProbe} from './background-probe.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const documentPath = resolve(directory, 'renderer/index.html');
const documentUrl = pathToFileURL(documentPath).href;
const acceptanceProbe=nativeProbe(root,process.argv);
let ownerEpoch=0;
let active = false;
let controller: AbortController | undefined;
let quitting = false;
let window: BrowserWindow | undefined;
let ledger: ExecutionLedger | undefined;
let backupService:BackupService|undefined;
const resourceSampler=new MainResourceSampler();
let execution: ForegroundExecution | undefined;
let verifier: NodeVerification | undefined;
let terminalService:TerminalService|undefined;
let terminalStopping=false;
let worktreeService:WorktreeService|undefined;
let worktreeStopping=false;
let workspaceReader:WorkspaceService|undefined;
let scheduleService:ScheduleService|undefined,scheduleTimer:ReturnType<typeof setInterval>|undefined;
let taskService:TaskService|undefined,outboxPump:OutboxPump|undefined,outboxTimer:ReturnType<typeof setInterval>|undefined;
const recoverySmoke=process.argv.includes('--m2-worktree-recovery-smoke');
const toolsSmoke=process.argv.includes('--m2-tools-smoke');
const resourcesSmoke=process.argv.includes('--m2-resources-smoke');
const rehearsalSmoke=process.argv.includes('--m2-rehearsal-smoke');
const backupSmoke=rehearsalSmoke||process.argv.includes('--m2-backups-smoke');
let backupSmokeFirstCopy=backupSmoke;
const worktreeCodePreflight=process.argv.includes('--m2-worktree-code-preflight');
const worktreeCodeSmoke=worktreeCodePreflight||process.argv.includes('--m2-worktree-code-smoke');
const recoveryProbeState=recoverySmoke?{archiveStops:0,revealed:[] as string[]}:undefined;
const terminalSmoke=process.argv.includes('--m2-terminal-smoke');
const worktreeSmoke=process.argv.includes('--m2-worktrees-smoke');
const backgroundNativeSmoke=process.argv.includes('--m2-background-native-smoke');
const backgroundSmoke=process.argv.includes('--m2-background-smoke');
const backgroundProbe=backgroundSmoke||backgroundNativeSmoke;
const nativeCodeContinuationSmoke=process.argv.includes('--m1-native-code-continuation-smoke');
const nativeCodeSmoke=process.argv.includes('--m1-native-code-smoke')||nativeCodeContinuationSmoke;
let nativeCodeWorkspace:string|undefined;
if(nativeCodeSmoke){mkdirSync(resolve(root,'.local'),{recursive:true});app.setPath('userData',mkdtempSync(resolve(root,'.local/desktop-native-code-')));}
const interactionSmoke = process.argv.includes('--m1-interaction-smoke');
const continuationSmoke=process.argv.includes('--m1-continuation-smoke');
const budgetSmoke=process.argv.includes('--m2-budget-ui-smoke');
const scheduleAutoSmoke=process.argv.includes('--m2-scheduler-auto-smoke');
const scheduleSmoke=process.argv.includes('--m2-scheduler-smoke')||scheduleAutoSmoke;
const planSmoke=process.argv.includes('--m2-plans-smoke');
const taskSmoke=process.argv.includes('--m2-tasks-smoke')||budgetSmoke||planSmoke||scheduleSmoke;
const executionSmoke = toolsSmoke || backgroundSmoke || process.argv.includes('--m1-execution-smoke') || interactionSmoke || continuationSmoke || taskSmoke;
const historySmoke = process.argv.includes('--m1-history-smoke');
const keepRunningWithoutWindow=backgroundProbe||terminalSmoke||!(resourcesSmoke||backupSmoke||worktreeCodeSmoke||recoverySmoke||worktreeSmoke||nativeCodeSmoke||executionSmoke||historySmoke||acceptanceProbe||process.argv.includes('--m0-window-smoke'));
let windowsReady=false,windowOpening:Promise<BrowserWindow>|undefined;
if(resourcesSmoke||backupSmoke||worktreeCodeSmoke||backgroundNativeSmoke||worktreeSmoke||terminalSmoke||recoverySmoke){mkdirSync(resolve(root,'.local'),{recursive:true});app.setPath('userData',mkdtempSync(resolve(root,'.local/desktop-background-native-')));}
let fixtureDirectory: string | undefined;
  if (process.argv.includes('--m0-window-smoke')) app.setPath('userData', resolve(root, '.local/desktop-smoke-data'));
  if (historySmoke) app.setPath('userData', resolve(root, '.local/desktop-history-smoke-data'));
  if (executionSmoke) app.setPath('userData', resolve(root, '.local/desktop-execution-smoke-data'));
if(acceptanceProbe)app.setPath('userData',acceptanceProbe.stateDirectory);
const singleInstanceHeld=app.requestSingleInstanceLock();
if(acceptanceProbe?.kind==='owner-secondary'){rejectedSecondary(acceptanceProbe,singleInstanceHeld);app.quit();}
else if (!singleInstanceHeld) app.quit();
else void boot().catch(async error => {
  const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'HOST_ERROR';
  console.error('DESKTOP_BOOT_FAILED', code);
  if (resourcesSmoke || backupSmoke || worktreeCodeSmoke || recoverySmoke || terminalSmoke || worktreeSmoke || backgroundProbe || acceptanceProbe || nativeCodeSmoke || executionSmoke || historySmoke || process.argv.includes('--m0-window-smoke')) {
    if (window) { try { writeFileSync(resolve(root, '.local/desktop-failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {} }
    const file = resourcesSmoke?'M2.2e-desktop':rehearsalSmoke?'M2.7b-desktop':backupSmoke?'M2.7a-desktop':worktreeCodeSmoke?(worktreeCodePreflight?'M2.1b-worktree-preflight':'M2.1b-worktree-native'):toolsSmoke?'M2.1b-tools-desktop':recoverySmoke?'M2.5b-desktop':terminalSmoke?'M2.6a-desktop':worktreeSmoke?'M2.5a-desktop':backgroundProbe?(backgroundNativeSmoke?'M2.4a-native-background':'M2.4a-desktop'):scheduleAutoSmoke?'M2.3d-desktop':scheduleSmoke?'M2.3c-desktop':planSmoke?'M2.2d-desktop':budgetSmoke?'M2.2c-desktop':taskSmoke?'M2.2b-desktop':acceptanceProbe?acceptanceProbe.kind==='workspace'?'M2.1a-desktop':`M1.4b-${acceptanceProbe.kind==='folder'?'native-folder':acceptanceProbe.kind==='restart'?'native-restart':'owner'}`:nativeCodeSmoke ? 'M1-native-code-desktop' : continuationSmoke?'M1.3c-desktop':interactionSmoke ? 'M1.2-desktop' : executionSmoke ? 'M1.1c-desktop' : historySmoke ? 'M1.1b-desktop' : 'M0-desktop-smoke';
    writeFileSync(resolve(root, `docs/progress/evidence/${file}.json`), JSON.stringify({ status: 'blocked', code, observedAt: new Date().toISOString() }) + '\n');
  }
  try {await terminalService?.stop();await worktreeService?.stop();await execution?.close(); ledger?.close();}catch{}
  app.exit(1);
});

function authorized(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== documentUrl) throw new Error('UNAUTHORIZED_IPC');
}
function executable(): string {
  return verifiedCodex(root).executable;
}
async function historyCommand<T>(event: Electron.IpcMainInvokeEvent, args: unknown[], count: number, operation: () => Promise<T>): Promise<HostResult<T>> {
  authorized(event);
  if (args.length !== count) return { ok: false, errorCode: 'UNEXPECTED_ARGUMENTS' };
  if (active || execution?.busy) return { ok: false, errorCode: 'RUNTIME_BUSY' };
  active = true; controller = new AbortController();
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, errorCode: error instanceof RpcFailure || error instanceof LedgerError ? error.code : 'HOST_ERROR' }; }
  finally { active = false; controller = undefined; if (quitting || (!keepRunningWithoutWindow&&BrowserWindow.getAllWindows().length === 0)) app.quit(); }
}
async function boot(): Promise<void> {
  await app.whenReady();
  const state = resolve(app.getPath('userData'), 'codex-state');
  if(nativeCodeSmoke){nativeCodeWorkspace=realpathSync(await mkdtemp(resolve(tmpdir(),'personal-agent-code-')));createCodeFixture(nativeCodeWorkspace);}
  let fixtureWorkspace: string | undefined;
  const fixtureMethods = new Set<string>();
  if (resourcesSmoke || backupSmoke || worktreeCodeSmoke || historySmoke || executionSmoke || backgroundNativeSmoke || worktreeSmoke || terminalSmoke || recoverySmoke) {
    mkdirSync(resolve(root, '.local'), { recursive: true });
    fixtureDirectory = worktreeCodeSmoke?realpathSync(await mkdtemp('/private/tmp/personal-agent-worktree-code-')):await mkdtemp(resolve(root, '.local/history-desktop-'));
    fixtureWorkspace = resolve(fixtureDirectory, 'workspace'); await mkdir(fixtureWorkspace);if(resourcesSmoke||worktreeSmoke||terminalSmoke||recoverySmoke)createWorktreeFixture(fixtureWorkspace);
    if(worktreeCodeSmoke){createCodeFixture(fixtureWorkspace);writeFileSync(resolve(fixtureWorkspace,'src/math.mjs'),'export const sum = (a, b) => a - b;\n// SOURCE_DIRTY_KEPT\n');}
  }
  if (!historySmoke) {
    ledger = new ExecutionLedger(resolve(fixtureDirectory ?? app.getPath('userData'), 'execution/ledger.db'), readFileSync(resolve(directory, 'schema.sql'), 'utf8'),budgetSmoke?{budgetPolicy:{dailyTokens:150,reservationTokens:60}}:{});
    ownerEpoch=ledger.startOwner(randomUUID(), true); // OS single-instance lock was acquired before boot().
    backupService=new BackupService(ledger,{directory:resolve(fixtureDirectory??app.getPath('userData'),'backups'),verificationDirectory:resolve(app.getPath('userData'),'verification/artifacts'),...(backupSmoke?{afterStage:(stage:'snapshot'|'published')=>{if(stage==='snapshot'&&backupSmokeFirstCopy){backupSmokeFirstCopy=false;throw new LedgerError('CONTROLLED_BACKUP_COPY_FAILURE');}}}:{})});
    if (!executionSmoke && process.platform === 'darwin' && process.arch === 'arm64') {
      try { verifier = new NodeVerification(ledger,{node:resolveVerifierNode(root),cli:executable(),reporter:resolve(directory,'verification-reporter.mjs'),stateDirectory:resolve(app.getPath('userData'),'verification')}); } catch {}
      try {terminalService=new TerminalService(ledger,{node:resolveVerifierNode(root),worker:resolve(directory,'terminal-worker.mjs'),stateDirectory:resolve(fixtureDirectory??app.getPath('userData'),'terminals')});}catch{}
      try {worktreeService=new WorktreeService(ledger,{git:resolveWorkspaceGit(),node:resolveVerifierNode(root),worker:resolve(directory,'worktree-worker.mjs'),stateDirectory:resolve(fixtureDirectory??app.getPath('userData'),'worktrees'),reveal:path=>{if(recoveryProbeState)recoveryProbeState.revealed.push(path);else shell.showItemInFolder(path);},...(recoverySmoke?{afterArchived:()=>{recoveryProbeState!.archiveStops++;throw new LedgerError('CONTROLLED_RECOVERY_GAP');}}:{})});}catch{}
      try {workspaceReader=new WorkspaceService(id=>ledger!.workspace(id),{node:resolveVerifierNode(root),cli:executable(),git:resolveWorkspaceGit(),worker:resolve(directory,'workspace-reader.mjs'),stateDirectory:resolve(app.getPath('userData'),'workspace-read'),managedGit:id=>ledger!.worktreeMetadata(id)});}catch{}
    }
    execution = new ForegroundExecution(ledger, { executable: executionSmoke ? resolveExecutable('node') : executable(), stateDirectory: state, mode: interactionSmoke ? 'workspaceWrite' : 'readOnly',
      ...(verifier ? { prepareCode: (token, code, signal) => verifier!.prepare(token,code,signal) } : {}),
      ...(verifier ? {prepareContinuation:(token,sourceRunId,signal)=>verifier!.prepareContinuation(token,sourceRunId,signal)} : {}),
      ...(executionSmoke ? { connect: callbacks => new StdioRpcClient({ executable: resolveExecutable('node'),
        args: [resolve(root, 'tests/fixtures/execution-server.ts'), toolsSmoke?'tool-status':backgroundSmoke||scheduleAutoSmoke?'usage':taskSmoke?'interrupt-ok':interactionSmoke ? 'approval-accept' : 'slow', resolve(fixtureDirectory!, 'execution/ledger.db'), resolve(fixtureDirectory!, 'execution-receipts')], env: runtimeEnvironment(), ...callbacks }) } : {}) });
  }
  const history = new HistoryBrowser(async read => {
    if (!resourcesSmoke && !backupSmoke && !worktreeCodeSmoke && !historySmoke && !executionSmoke && !worktreeSmoke && !terminalSmoke && !recoverySmoke) return readConnection(executable(), state, controller?.signal)(port=>read({request:async<T>(method:string,params:unknown)=>{acceptanceProbe?.readMethods.add(method);return port.request<T>(method,params);}}));
    // Fixed internal integration fixture. No Renderer API selects a process, path, or fixture mode.
    const rpc = new StdioRpcClient({ executable: resolveExecutable('node'),
      args: [resolve(root, 'tests/fixtures/history-server.ts'), fixtureWorkspace!], env: runtimeEnvironment(), signal: controller?.signal });
    const port: ReadPort = { request: async <T>(method: string, params: unknown) => {
      fixtureMethods.add(method); return rpc.request<T>(method, params);
    } };
    try {
      await rpc.request('initialize', { clientInfo: { name: 'personal_agent_history_fixture', version: '0.1.0' } });
      await rpc.notify('initialized'); return await read(port);
    } finally { await rpc.close(); }
  }, ledger ? path => ledger!.registerWorkspace(path) : undefined);
  ipcMain.handle('history:chooseProject', (event, ...args: unknown[]) => historyCommand(event, args, 0, async () => {
    if(acceptanceProbe?.kind==='workspace')return history.registerDirectory(acceptanceProbe.folderDirectory!);
    if (fixtureWorkspace) return history.registerDirectory(fixtureWorkspace);
    if (nativeCodeWorkspace) return history.registerDirectory(nativeCodeWorkspace);
    if(acceptanceProbe?.kind==='folder')acceptanceProbe.dialogOpened=true;
    const selection = await dialog.showOpenDialog(window!, { title: '选择项目目录', properties: ['openDirectory'],...(acceptanceProbe?.folderDirectory?{defaultPath:acceptanceProbe.folderDirectory}:{}) });
    if(acceptanceProbe?.kind==='folder'&&!selection.canceled){if(selection.filePaths.length!==1||realpathSync(selection.filePaths[0]!)!==acceptanceProbe.folderDirectory)throw new LedgerError('NATIVE_FOLDER_SCOPE_MISMATCH');acceptanceProbe.selectionMatched=true;}
    return selection.canceled || !selection.filePaths[0] ? null : history.registerDirectory(selection.filePaths[0]);
  }));
  ipcMain.handle('history:listThreads', (event, ...args: unknown[]) => historyCommand(event, args, 1, () => history.listThreads(args[0])));
  ipcMain.handle('history:listTurns', (event, ...args: unknown[]) => historyCommand(event, args, 1, () => history.listTurns(args[0])));
  ipcMain.handle('history:listItems', (event, ...args: unknown[]) => historyCommand(event, args, 1, () => history.listItems(args[0])));
  function executionCommand<T>(event: Electron.IpcMainInvokeEvent, args: unknown[], count: number, operation: () => T): HostResult<T> {
    authorized(event);
    if (args.length !== count) return { ok: false, errorCode: 'UNEXPECTED_ARGUMENTS' };
    try { return { ok: true, value: operation() }; }
    catch (error) { return { ok: false, errorCode: error instanceof LedgerError || error instanceof RpcFailure ? error.code : 'HOST_ERROR' }; }
  }
  if(ledger&&execution){taskService=new TaskService(ledger,execution);outboxPump=new OutboxPump(ledger);outboxTimer=setInterval(()=>{try{outboxPump?.step();}catch{/* Owner/DB failures never trigger model dispatch. */}void taskService?.stepPlans().catch(()=>{});},250);outboxTimer.unref();}
  if(ledger){scheduleService=new ScheduleService(ledger,execution);scheduleTimer=setInterval(()=>{try{scheduleService?.step();}catch{/* Failed admission transactions preserve their cursor; sent runs are never retried here. */}},1000);scheduleTimer.unref();}
  for(const [channel,method]of [['schedules:command','apply'],['schedules:list','list'],['schedules:occurrences','occurrences']] as const)ipcMain.handle(channel,(event,...args:unknown[])=>executionCommand(event,args,1,()=>{if(!scheduleService)throw new LedgerError('SCHEDULES_UNAVAILABLE');return scheduleService[method](args[0]);}));
  ipcMain.handle('execution:workspaceState', (event, ...args: unknown[]) => executionCommand(event, args, 0, () => ({ projects: ledger?.projects() ?? [], canSubmit: Boolean(execution), canCode: Boolean(verifier), canBrowseWorkspace:Boolean(workspaceReader),canManageTasks:Boolean(taskService),backgroundEnabled:keepRunningWithoutWindow,canUseTerminal:Boolean(terminalService),mode: interactionSmoke ? 'workspaceWrite' as const : 'readOnly' as const })));
  ipcMain.handle('tasks:list',(event,...args:unknown[])=>executionCommand(event,args,1,()=>{if(!taskService)throw new LedgerError('TASKS_UNAVAILABLE');return taskService.list(args[0]);}));
  ipcMain.handle('tasks:activity',(event,...args:unknown[])=>executionCommand(event,args,1,()=>{if(!taskService)throw new LedgerError('TASKS_UNAVAILABLE');return taskService.activity(args[0]);}));
  ipcMain.handle('runtime:resourceBudget',(event,...args:unknown[])=>executionCommand(event,args,0,()=>{if(!ledger)throw new LedgerError('TASKS_UNAVAILABLE');let mainProcess;try{mainProcess=resourceSampler.sample();}catch{}return{...ledger.resourceBudget(),occupancy:ledger.resourceOccupancy(),...(mainProcess?{mainProcess}:{})};}));
  ipcMain.handle('backups:list',(event,...args:unknown[])=>executionCommand(event,args,0,()=>{if(!backupService)throw new LedgerError('BACKUPS_UNAVAILABLE');return backupService.list();}));
  ipcMain.handle('backups:command',(event,...args:unknown[])=>executionCommand(event,args,1,()=>{if(!backupService)throw new LedgerError('BACKUPS_UNAVAILABLE');return backupService.command(args[0] as BackupCommand);}));
  ipcMain.handle('tasks:plans',(event,...args:unknown[])=>executionCommand(event,args,1,()=>{if(!taskService)throw new LedgerError('TASKS_UNAVAILABLE');return taskService.plans(args[0]);}));
  ipcMain.handle('tasks:cancelPlan',(event,...args:unknown[])=>executionCommand(event,args,1,()=>{if(!taskService)throw new LedgerError('TASKS_UNAVAILABLE');return taskService.cancelPlan(args[0]);}));
  ipcMain.handle('tasks:plan',async(event,...args:unknown[])=>{
    authorized(event);if(args.length!==1)return{ok:false,errorCode:'UNEXPECTED_ARGUMENTS'};
    try{if(!taskService)throw new LedgerError('TASKS_UNAVAILABLE');return{ok:true,value:await taskService.applyPlan(args[0])};}
    catch(error){return{ok:false,errorCode:error instanceof LedgerError||error instanceof RpcFailure?error.code:'HOST_ERROR'};}
  });
  ipcMain.handle('tasks:start',(event,...args:unknown[])=>executionCommand(event,args,1,()=>{if(!execution||active)throw new LedgerError('RUNTIME_BUSY');return execution.startTask(args[0]);}));
  ipcMain.handle('tasks:command',async(event,...args:unknown[])=>{
    authorized(event);if(args.length!==1)return{ok:false,errorCode:'UNEXPECTED_ARGUMENTS'};
    try{if(!taskService)throw new LedgerError('TASKS_UNAVAILABLE');return{ok:true,value:await taskService.apply(args[0])};}
    catch(error){return{ok:false,errorCode:error instanceof LedgerError||error instanceof RpcFailure?error.code:'HOST_ERROR'};}
  });
  for(const [channel,operation]of [['workspace:overview','overview'],['workspace:directory','list'],['workspace:file','preview'],['workspace:diff','diff']] as const){
    ipcMain.handle(channel,(event,...args:unknown[])=>historyCommand(event,args,1,async()=>{if(!workspaceReader)throw new LedgerError('WORKSPACE_READER_UNAVAILABLE');return workspaceReader[operation](args[0],controller?.signal);}));
  }
  for(const [channel,method]of [['terminal:open','open'],['terminal:read','view'],['terminal:write','write'],['terminal:resize','resize'],['terminal:close','close'],['terminal:reconcile','reconcile']] as const)ipcMain.handle(channel,async(event,...args:unknown[])=>{
    authorized(event);if(args.length!==1)return{ok:false,errorCode:'UNEXPECTED_ARGUMENTS'};
    try{if(!terminalService||quitting)throw new LedgerError('TERMINAL_UNAVAILABLE');return{ok:true,value:await terminalService[method](args[0])};}
    catch(error){return{ok:false,errorCode:error instanceof LedgerError?error.code:'HOST_ERROR'};}
  });
  for(const channel of ['worktrees:list','worktrees:command','worktrees:inspect','worktrees:use'])ipcMain.handle(channel,(event,...args:unknown[])=>historyCommand(event,args,1,async()=>{
    if(!worktreeService||!ledger)throw new LedgerError('WORKTREES_UNAVAILABLE');
    if(channel==='worktrees:command')return worktreeService.command(args[0] as WorktreeCommand);
    const q=args[0] as Record<string,unknown>,keys=channel==='worktrees:list'?['projectId']:['projectId','workspaceId'];
    if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).length!==keys.length||keys.some(k=>typeof q[k]!=='string'||!(q[k] as string).length||(q[k] as string).length>200)||Object.keys(q).some(k=>!keys.includes(k)))throw new LedgerError('INVALID_WORKTREE_QUERY');
    if(channel==='worktrees:list')return worktreeService.page(q.projectId as string);
    if(channel==='worktrees:inspect')return worktreeService.inspect(q.projectId as string,q.workspaceId as string);
    if(ledger.worktreeContext(q.projectId as string).projectId!==ledger.worktreeContext(q.workspaceId as string).projectId)throw new LedgerError('WORKTREE_SCOPE_MISMATCH');
    const managed=ledger.managedWorktree(q.workspaceId as string);if(managed.state!=='ready')throw new LedgerError('WORKTREE_NOT_READY');
    return history.registerDirectory(ledger.workspace(managed.id).directory);
  }));
  // Re-register persisted grants in the read-only browser; invalid directories remain blocked by Store.
  for (const project of ledger?.projects() ?? []) {
    try { ledger!.workspace(project.id); await history.registerDirectory(project.directory); } catch {}
  }
  ipcMain.handle('execution:submit', (event, ...args: unknown[]) => executionCommand(event, args, 1, () => {
    if (!execution || active) throw new LedgerError('RUNTIME_BUSY'); return execution.submit(args[0]);
  }));
  ipcMain.handle('execution:continue',(event,...args:unknown[])=>executionCommand(event,args,1,()=>{
    if(!execution||active)throw new LedgerError('RUNTIME_BUSY');return execution.continueRun(args[0]);
  }));
  ipcMain.handle('execution:list', (event, ...args: unknown[]) => executionCommand(event, args, 1, () => {
    if (!execution) throw new LedgerError('EXECUTION_UNAVAILABLE'); return execution.list(args[0]);
  }));
  ipcMain.handle('execution:view', (event, ...args: unknown[]) => executionCommand(event, args, 1, () => {
    if (!execution) throw new LedgerError('EXECUTION_UNAVAILABLE'); return execution.view(args[0]);
  }));
  const reconciliation=ledger?new HistoryReconciliation(ledger,read=>readConnection(executable(),state,controller?.signal)(read)):undefined;
  ipcMain.handle('execution:reconcile',(event,...args:unknown[])=>historyCommand(event,args,1,async()=>{
    if(!execution||!reconciliation)throw new LedgerError('EXECUTION_UNAVAILABLE');
    execution.view(args[0]);await reconciliation.reconcile(args[0]);return execution.view(args[0]);
  }));
  ipcMain.handle('execution:interactions', (event, ...args: unknown[]) => executionCommand(event, args, 1, () => {
    if (!execution) throw new LedgerError('EXECUTION_UNAVAILABLE'); return execution.interactions(args[0]);
  }));
  ipcMain.handle('execution:reply', (event, ...args: unknown[]) => executionCommand(event, args, 1, () => {
    if (!execution) throw new LedgerError('EXECUTION_UNAVAILABLE'); execution.reply(args[0]); return { state: 'submitted' as const };
  }));
  ipcMain.handle('execution:interrupt', async (event, ...args: unknown[]) => {
    authorized(event);
    if (args.length !== 1) return { ok: false, errorCode: 'UNEXPECTED_ARGUMENTS' };
    try { if (!execution) throw new LedgerError('EXECUTION_UNAVAILABLE'); await execution.interrupt(args[0]); return { ok: true, value: { state: 'requested' } }; }
    catch (error) { return { ok: false, errorCode: error instanceof LedgerError || error instanceof RpcFailure ? error.code : 'HOST_ERROR' }; }
  });
  function review(input: unknown) {
    if (!execution || !verifier) throw new LedgerError('VERIFICATION_UNAVAILABLE');
    execution.view(input); const q=input as {projectId:string;runId:string};
    const data=verifier.diff(q.projectId,q.runId),receipt=verifier.result(q.projectId,q.runId);
    return {target:data.profile?.target??null,allowedPaths:data.profile?.allowedPaths??[],requiredCases:data.profile?.requiredCases.length??0,baselineCommit:data.profile?.baselineCommit??null,
      changedFiles:data.changedFiles,diff:data.text,diffTruncated:data.text.length>=65536,
      receipt:receipt?{status:receipt.status,code:receipt.code,discovered:receipt.discovered,executed:receipt.executed,skipped:receipt.skipped,exitCode:receipt.exitCode,observedAt:receipt.observedAt}:null};
  }
  ipcMain.handle('execution:review',(event,...args:unknown[])=>executionCommand(event,args,1,()=>review(args[0])));
  ipcMain.handle('execution:verify',async(event,...args:unknown[])=>{
    authorized(event);if(args.length!==1)return{ok:false,errorCode:'UNEXPECTED_ARGUMENTS'};
    if(active||execution?.busy)return{ok:false,errorCode:'RUNTIME_BUSY'};
    active=true;controller=new AbortController();
    try{if(!execution||!verifier)throw new LedgerError('VERIFICATION_UNAVAILABLE');execution.view(args[0]);const q=args[0] as {projectId:string;runId:string};await verifier.verify(q.projectId,q.runId,controller.signal);return{ok:true,value:review(args[0])};}
    catch(error){return{ok:false,errorCode:error instanceof LedgerError?error.code:'HOST_ERROR'};}
    finally{active=false;controller=undefined;if(quitting||(!keepRunningWithoutWindow&&BrowserWindow.getAllWindows().length===0))app.quit();}
  });
  ipcMain.handle('runtime:inspect', async (event, ...args: unknown[]): Promise<ConnectionInfo> => {
    authorized(event);
    if (args.length) throw new Error('UNEXPECTED_ARGUMENTS');
    if (active || execution?.busy) return { status: 'error', errorCode: 'RUNTIME_BUSY' };
    active = true;
    controller = new AbortController();
    try { return { status: 'connected', ...await inspectConnection(executable(), state, controller.signal) }; }
    catch (error) { return { status: 'error', errorCode: error instanceof RpcFailure || error instanceof LedgerError ? error.code : 'HOST_ERROR' }; }
    finally { active = false; controller = undefined; if (quitting || (!keepRunningWithoutWindow&&BrowserWindow.getAllWindows().length === 0)) app.quit(); }
  });
  windowsReady=true;
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Personal Agent',submenu:[{label:'显示主窗口',click:()=>{void showMainWindow().catch(()=>{});}},{type:'separator'},{label:'退出并停止运行',accelerator:'CmdOrCtrl+Q',click:()=>app.quit()}]},{role:'editMenu'},{role:'windowMenu'}]));
  window=await showMainWindow();
  if(resourcesSmoke){await runResourceProbe(root,app,window,ledger!,execution!,resolve(fixtureDirectory!,'execution/ledger.db'));return;}
  if(toolsSmoke){await runToolProbe(root,app,window,ledger!);return;}
  if(backupSmoke){await runBackupProbe(root,app,window,ledger!,resolve(fixtureDirectory!,'execution/ledger.db'),resolve(fixtureDirectory!,'backups'),rehearsalSmoke);return;}
  if(worktreeCodeSmoke){await runWorktreeCodeProbe(root,app,window,ledger!,execution!,fixtureWorkspace!,resolve(fixtureDirectory!,'execution/ledger.db'),worktreeCodePreflight);return;}
  if(recoverySmoke){await runWorktreeRecoveryProbe(root,app,window,ledger!,fixtureWorkspace!,resolve(fixtureDirectory!,'execution/ledger.db'),recoveryProbeState!);return;}
  if(terminalSmoke){await runTerminalProbe(root,app,window,ledger!,terminalService!,fixtureWorkspace!,showMainWindow);return;}
  if(worktreeSmoke){await runWorktreeProbe(root,app,window,ledger!,fixtureWorkspace!);return;}
  if(backgroundProbe){await runBackgroundProbe(root,app,window,ledger!,execution!,resolve(fixtureDirectory!,'execution/ledger.db'),showMainWindow,backgroundNativeSmoke);return;}
  if(scheduleSmoke){await runScheduleProbe(root,app,window,execution!,scheduleAutoSmoke);return;}
  if(planSmoke){await runPlanProbe(root,app,window,execution!);return;}
  if(taskSmoke){await runTaskProbe(root,app,window,ledger!,execution!,budgetSmoke);return;}
  if(acceptanceProbe){await runNativeProbe(root,acceptanceProbe,app,window,{ledger:ledger!,execution:execution!,...(verifier?{verifier}:{}),ownerEpoch});return;}
  if (process.argv.includes('--m0-window-smoke')) {
    // Fixed test-only evaluation; no Renderer API accepts JS or a command string.
    const result: unknown = await window.webContents.executeJavaScript(`(async () => {
      const connection = await window.personalAgent.inspect();
      document.querySelector('[data-action="inspect"]')?.click();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && document.querySelector('[data-connected]')?.getAttribute('data-connected') !== 'true') {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return {
      title: document.title,
      rendered: document.body.textContent.includes('Personal Agent'),
      hasRequire: typeof require !== 'undefined',
      bridgeKeys: Object.keys(window.personalAgent).sort(),
      sandboxed: window.personalAgent.security.sandboxed,
      isolated: window.personalAgent.security.isolated,
      connection,
      uiConnected: document.querySelector('[data-connected]')?.getAttribute('data-connected') === 'true'
    }; })()`);
    const r = result as Record<string, unknown>;
    const passed = r.rendered === true && r.hasRequire === false && r.sandboxed === true && r.isolated === true
      && r.uiConnected === true && !app.commandLine.hasSwitch('no-sandbox')
      && (r.connection as ConnectionInfo)?.status === 'connected'
      && JSON.stringify(r.bridgeKeys) === JSON.stringify(['applyBackupCommand', 'applyScheduleCommand', 'applyTaskCommand', 'applyTaskPlan', 'applyWorktreeCommand', 'cancelTaskPlan', 'chooseProject', 'closeTerminal', 'continueRun', 'getRun', 'getVerification', 'getWorkspace', 'getWorkspaceDiff', 'inspect', 'inspectWorktree', 'interruptRun', 'listBackups', 'listInteractions', 'listItems', 'listRuns', 'listScheduleOccurrences', 'listSchedules', 'listTaskActivity', 'listTaskPlans', 'listTasks', 'listThreads', 'listTurns', 'listWorkspaceDirectory', 'listWorktrees', 'openTerminal', 'readTerminal', 'readWorkspaceFile', 'reconcileRun', 'reconcileTerminal', 'replyInteraction', 'resizeTerminal', 'resourceBudget', 'security', 'startTask', 'submitMessage', 'useWorktree', 'verifyRun', 'workspaceState', 'writeTerminal']);
    const evidence = { observedAt: new Date().toISOString(), kind: 'real_electron_window_smoke',
      status: passed ? 'passed' : 'blocked',
      browserSandbox: app.commandLine.hasSwitch('no-sandbox') ? 'disabled' : 'enabled', result };
    mkdirSync(resolve(root, 'docs/progress/evidence'), { recursive: true });
    writeFileSync(resolve(root, 'docs/progress/evidence/M0-desktop-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync(resolve(root, '.local/M0-desktop-smoke.png'), (await window.webContents.capturePage()).toPNG());
    // Use Electron's normal shutdown lifecycle before the wrapper releases its display.
    app.quit();
  }
  if (historySmoke) {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = async selector => {
        const deadline = Date.now() + 12000;
        while (!document.querySelector(selector)) {
          if (Date.now() > deadline) throw new Error('HISTORY_UI_TIMEOUT');
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        return document.querySelector(selector);
      };
      (await wait('[data-action="choose-project"]')).click();
      (await wait('[data-thread-id="fixture-thread-1"]'));
      (await wait('[data-action="next-threads"]')).click();
      await wait('[data-thread-id="fixture-thread-2"]');
      (await wait('[data-action="refresh-threads"]')).click();
      (await wait('[data-thread-id="fixture-thread-1"]')).click();
      (await wait('[data-turn-id="fixture-turn-1"]')).click();
      await wait('[data-item-id="fixture-assistant"]');
      return {
        sandboxed: window.personalAgent.security.sandboxed, isolated: window.personalAgent.security.isolated,
        hasRequire: typeof require !== 'undefined', items: document.querySelectorAll('[data-item-id]').length,
        markupShownAsText: document.body.textContent.includes('<img src=x onerror='),
        noInjectedImage: document.querySelector('[data-history-items] img') === null,
        noScriptExecution: window.__fixtureExecuted !== true,
        noPrivateToolFields: !document.body.textContent.includes('fixture-private-field'),
        sendingDisabled: document.querySelector('[data-action="send"]')?.disabled === true,
        paginationWorked: true
      };
    })()`);
    const r = result as Record<string, unknown>;
    const passed = r.sandboxed === true && r.isolated === true && r.hasRequire === false && r.items === 3
      && r.markupShownAsText === true && r.noInjectedImage === true && r.noScriptExecution === true
      && r.noPrivateToolFields === true && r.sendingDisabled === true && !app.commandLine.hasSwitch('no-sandbox')
      && ['thread/list', 'thread/read', 'thread/turns/list', 'thread/items/list'].every(method => fixtureMethods.has(method));
    const evidence = { status: passed ? 'passed' : 'blocked', observedAt: new Date().toISOString(), kind: 'real_electron_with_local_rpc_fixture',
      backend: 'synthetic_stdio_fixture', folderDialogSelection: 'fixed_fixture_substitution', inferenceRequested: false,
      methods: [...fixtureMethods].sort(), result };
    mkdirSync(resolve(root, 'docs/progress/evidence'), { recursive: true });
    writeFileSync(resolve(root, 'docs/progress/evidence/M1.1b-desktop.json'), JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync(resolve(root, '.local/M1-history-desktop.png'), (await window.webContents.capturePage()).toPNG());
    app.quit();
  }
  if (executionSmoke && !interactionSmoke && !continuationSmoke) {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = async (check) => {
        const deadline = Date.now() + 15000;
        while (!check()) { if (Date.now() > deadline) throw new Error('EXECUTION_UI_TIMEOUT'); await new Promise(r => setTimeout(r, 30)); }
      };
      document.querySelector('[data-action="choose-project"]').click();
      await wait(() => document.querySelector('[data-task-draft]'));
      const input = document.querySelector('[data-task-draft]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '<img src=x onerror="window.__executionInjected=true"> Synthetic execution question.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(() => !document.querySelector('[data-action="send"]').disabled);
      document.querySelector('[data-action="send"]').click();
      await wait(() => document.querySelector('[data-item-status="streaming"]'));
      const streamedBeforeCompletion = document.querySelector('[data-run-status]').getAttribute('data-run-status') !== 'completed';
      await wait(() => document.querySelector('[data-run-status="completed"]'));
      const state = await window.personalAgent.workspaceState();
      const projectId = state.value.projects[0].id;
      const rows = await window.personalAgent.listRuns({ projectId });
      const run = await window.personalAgent.getRun({ projectId, runId: rows.value[0].runId });
      const extra = await window.personalAgent.submitMessage({ projectId, submissionKey: 'malicious', text: 'must not send', path: '/etc' });
      const foreign = await window.personalAgent.getRun({ projectId, runId: 'foreign-run' });
      return { sandboxed: window.personalAgent.security.sandboxed, isolated: window.personalAgent.security.isolated,
        hasRequire: typeof require !== 'undefined', streamedBeforeCompletion,
        runStatus: run.value.status, taskStatus: run.value.taskStatus,
        finalText: run.value.snapshot.items.find(item => item.role === 'assistant').text,
        extraArgumentsRejected: extra.ok === false, foreignRunRejected: foreign.ok === false,
        markupShownAsText: document.body.textContent.includes('<img src=x onerror='),
        noInjectedImage: document.querySelector('[data-execution-items] img') === null,
        noScriptExecution: window.__executionInjected !== true,
        draftClearedAfterAcceptance: input.value === '' };
    })()`);
    const r = result as Record<string, unknown>;
    const passed = r.sandboxed === true && r.isolated === true && r.hasRequire === false && r.streamedBeforeCompletion === true
      && r.runStatus === 'completed' && r.taskStatus === 'needs_review' && r.finalText === 'aab'
      && r.extraArgumentsRejected === true && r.foreignRunRejected === true && r.markupShownAsText === true
      && r.noInjectedImage === true && r.noScriptExecution === true && r.draftClearedAfterAcceptance === true;
    writeFileSync(resolve(root, 'docs/progress/evidence/M1.1c-desktop.json'), JSON.stringify({ observedAt: new Date().toISOString(),
      status: passed ? 'passed' : 'blocked', kind: 'real_electron_durable_execution_with_stdio_fixture',
      backend: 'synthetic_stdio_fixture', folderDialogSelection: 'fixed_fixture_substitution', inferenceRequested: false,
      diagnostics: execution!.diagnostics, result }, null, 2) + '\n');
    writeFileSync(resolve(root, '.local/M1-execution-desktop.png'), (await window.webContents.capturePage()).toPNG());
    app.quit();
  }

  if (interactionSmoke) {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = async check => { const deadline=Date.now()+15000;while(!check()){if(Date.now()>deadline)throw new Error('INTERACTION_UI_TIMEOUT');await new Promise(r=>setTimeout(r,30));} };
      document.querySelector('[data-action="choose-project"]').click();await wait(()=>document.querySelector('[data-task-draft]'));
      const fill = text => { const input=document.querySelector('[data-task-draft]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true})); };
      fill('Synthetic approval UI fixture.');await wait(()=>!document.querySelector('[data-action="send"]').disabled);document.querySelector('[data-action="send"]').click();
      await wait(()=>document.querySelector('[data-action="accept-request"]'));
      const awaitingApproval=document.querySelector('[data-run-status]').getAttribute('data-run-status')==='waiting_approval';
      const shownCommand=document.body.textContent.includes('node --test');
      const state=await window.personalAgent.workspaceState(),projectId=state.value.projects[0].id;
      const rows=await window.personalAgent.listRuns({projectId}),runId=rows.value[0].runId;
      const pending=await window.personalAgent.listInteractions({projectId,runId}),requestId=pending.value[0].requestId;
      const foreign=await window.personalAgent.replyInteraction({projectId,runId:'foreign',requestId,decision:'accept'});
      const invalid=await window.personalAgent.replyInteraction({projectId,runId,requestId,decision:'acceptForSession'});
      document.querySelector('[data-action="accept-request"]').click();await wait(()=>document.querySelector('[data-run-status="completed"]'));
      const replay=await window.personalAgent.replyInteraction({projectId,runId,requestId,decision:'accept'});
      const final=await window.personalAgent.getRun({projectId,runId});
      return { sandboxed:window.personalAgent.security.sandboxed, isolated:window.personalAgent.security.isolated, hasRequire:typeof require!=='undefined',awaitingApproval,shownCommand,
        foreignRejected:foreign.ok===false,sessionApprovalRejected:invalid.ok===false,replayRejected:replay.ok===false,
        finalText:final.value.snapshot.items.find(item=>item.role==='assistant').text,taskStatus:final.value.taskStatus };
    })()`);
    const r=result as Record<string,unknown>;
    const passed=r.sandboxed===true&&r.isolated===true&&r.hasRequire===false&&r.awaitingApproval===true&&r.shownCommand===true
      &&r.foreignRejected===true&&r.sessionApprovalRejected===true&&r.replayRejected===true&&r.finalText==='accept'&&r.taskStatus==='needs_review';
    writeFileSync(resolve(root,'docs/progress/evidence/M1.2-desktop.json'),JSON.stringify({status:passed?'passed':'blocked',observedAt:new Date().toISOString(),
      kind:'real_electron_approval_with_synthetic_stdio',backend:'synthetic_stdio_fixture',folderDialogSelection:'fixed_fixture_substitution',inferenceRequested:false,
      syntheticEffectCreated:readFileSync(resolve(fixtureDirectory!,'execution-receipts.effect'),'utf8')==='accepted-once',result},null,2)+'\n');
    writeFileSync(resolve(root,'.local/M1-interactions-desktop.png'),(await window.webContents.capturePage()).toPNG());app.quit();
  }

  if(continuationSmoke){
    const result=await window.webContents.executeJavaScript(`(async()=>{
      const wait=async check=>{const deadline=Date.now()+15000;while(!check()){if(Date.now()>deadline)throw new Error('CONTINUATION_UI_TIMEOUT');await new Promise(r=>setTimeout(r,50));}};
      const fill=text=>{const input=document.querySelector('[data-task-draft]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));};
      document.querySelector('[data-action="choose-project"]').click();await wait(()=>document.querySelector('[data-task-draft]'));fill('Synthetic first task');await wait(()=>!document.querySelector('[data-action="send"]').disabled);document.querySelector('[data-action="send"]').click();await wait(()=>document.querySelector('[data-run-status="completed"]'));
      const state=await window.personalAgent.workspaceState(),projectId=state.value.projects[0].id,first=(await window.personalAgent.listRuns({projectId})).value[0];
      document.querySelector('[data-action="continue-run"]').click();await wait(()=>document.querySelector('[data-continuation-banner]'));fill('Synthetic explicit follow up');await wait(()=>!document.querySelector('[data-action="send"]').disabled);document.querySelector('[data-action="send"]').click();
      await wait(()=>document.querySelectorAll('[data-run-id]').length===2);await wait(()=>document.querySelector('[data-run-status="completed"]'));
      const last=(await window.personalAgent.listRuns({projectId})).value[0],view=(await window.personalAgent.getRun({projectId,runId:last.runId})).value;
      return{sameTask:first.taskId===last.taskId,sameThread:first.threadId===last.threadId,newRun:first.runId!==last.runId,status:view.status,taskStatus:view.taskStatus,finalText:view.snapshot.items.find(i=>i.role==='assistant').text,
        sandboxed:window.personalAgent.security.sandboxed,isolated:window.personalAgent.security.isolated,hasRequire:typeof require!=='undefined'};
    })()`);
    const r=result as Record<string,unknown>,passed=r.sameTask===true&&r.sameThread===true&&r.newRun===true&&r.status==='completed'&&r.taskStatus==='needs_review'&&r.finalText==='aab'&&r.sandboxed===true&&r.isolated===true&&r.hasRequire===false;
    writeFileSync(resolve(root,'docs/progress/evidence/M1.3c-desktop.json'),JSON.stringify({status:passed?'passed':'blocked',observedAt:new Date().toISOString(),kind:'real_electron_explicit_continuation_with_synthetic_stdio',inferenceRequested:false,folderDialogSelection:'fixed_fixture_substitution',result},null,2)+'\n');
    writeFileSync(resolve(root,'.local/M1-continuation-desktop.png'),(await window.webContents.capturePage()).toPNG());app.quit();
  }
  if(nativeCodeSmoke){
    const result=await window.webContents.executeJavaScript(`(async()=>{
      const wait=async check=>{const deadline=Date.now()+210000;while(!check()){if(Date.now()>deadline)throw new Error('NATIVE_CODE_UI_TIMEOUT');await new Promise(r=>setTimeout(r,100));}};
      document.querySelector('[data-action="choose-project"]').click();await wait(()=>document.querySelector('[data-code-profile]'));
      document.querySelector('[data-code-profile]').click();
      const fill=(selector,text)=>{const element=document.querySelector(selector);const prototype=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,text);element.dispatchEvent(new Event('input',{bubbles:true}));};
      await wait(()=>document.querySelector('[data-code-target]'));fill('[data-code-target]','test/math.test.mjs');fill('[data-code-paths]','src/math.mjs');
      fill('[data-task-draft]','Fix the sum(a,b) bug in src/math.mjs. Modify only that file. The four frozen Node tests must pass. Do not modify tests, run Git, use network, or create other files. Do not request escalation; the Host will independently run the frozen verification.');
      await wait(()=>!document.querySelector('[data-action="send"]').disabled);document.querySelector('[data-action="send"]').click();
      const state=await window.personalAgent.workspaceState(),projectId=state.value.projects[0].id;
      let runId,view,approvalDecisions=0;const deadline=Date.now()+200000;
      const settle=async previous=>{while(Date.now()<deadline){const rows=await window.personalAgent.listRuns({projectId});const next=rows.value[0]?.runId;if(next&&next!==previous){
        runId=next;const r=await window.personalAgent.getRun({projectId,runId});view=r.value;
        if(['completed','failed','cancelled','outcome_unknown'].includes(view.status))return;
        const pending=await window.personalAgent.listInteractions({projectId,runId});
        for(const request of pending.value.filter(r=>r.state==='pending')){await window.personalAgent.replyInteraction({projectId,runId,requestId:request.requestId,decision:'decline'});approvalDecisions++;}
      }await new Promise(r=>setTimeout(r,300));}throw new Error('NATIVE_CODE_TASK_TIMEOUT');};
      await settle();const first=view;
      if(!view||view.status!=='completed')return{runStatus:view?.status,taskStatus:view?.taskStatus,errorCode:view?.errorCode,approvalDecisions};
      if(${nativeCodeContinuationSmoke}){
        await wait(()=>document.querySelector('[data-run-status="completed"]'));document.querySelector('[data-action="continue-run"]').click();await wait(()=>document.querySelector('[data-continuation-banner]'));
        fill('[data-task-draft]','Review your prior sum fix against the four frozen tests. If any further correction is needed, change only src/math.mjs; otherwise keep the code. Do not modify tests, use Git/network, create files or request escalation. The Host will run verification.');await wait(()=>!document.querySelector('[data-action="send"]').disabled);document.querySelector('[data-action="send"]').click();
        await settle(first.runId);if(view.status!=='completed')return{runStatus:view.status,taskStatus:view.taskStatus,errorCode:view.errorCode,approvalDecisions};
      }
      await wait(()=>document.querySelector('[data-run-status="completed"]'));
      document.querySelector('[data-action="review-run"]').click();await wait(()=>document.querySelector('[data-run-diff]'));
      const diffShown=document.querySelector('[data-run-diff]').textContent.includes('src/math.mjs');
      document.querySelector('[data-action="verify-run"]').click();await wait(()=>document.querySelector('[data-verification-status="passed"]'));
      const final=await window.personalAgent.getRun({projectId,runId}),review=await window.personalAgent.getVerification({projectId,runId});
      return{runId,firstRunId:first.runId,sourceTurnId:first.turnId,codeContinuation:${nativeCodeContinuationSmoke},sameTask:first.taskId===final.value.taskId,sameThread:first.threadId===final.value.threadId,newRun:first.runId!==runId,newTurn:first.turnId!==final.value.turnId,threadId:final.value.threadId,turnId:final.value.turnId,runStatus:final.value.status,taskStatus:final.value.taskStatus,mode:final.value.mode,
        diffShown,changedFiles:review.value.changedFiles,receipt:review.value.receipt,requiredCases:review.value.requiredCases,approvalDecisions,
        sandboxed:window.personalAgent.security.sandboxed,isolated:window.personalAgent.security.isolated,hasRequire:typeof require!=='undefined'};
    })()`);
    const r=result as Record<string,unknown>,receipt=r.receipt as Record<string,unknown>|undefined;
    const firstPlan=typeof r.firstRunId==='string'?ledger!.verificationPlan(r.firstRunId):null,finalPlan=typeof r.runId==='string'?ledger!.verificationPlan(r.runId):null;
    const frozenContractInherited=Boolean(firstPlan&&finalPlan&&['baselineCommit','files','testHash','nodeHash','reporterHash','cliHash','verifierHash','target','allowedPaths','requiredCases','knownCases'].every(key=>JSON.stringify(firstPlan[key as keyof typeof firstPlan])===JSON.stringify(finalPlan[key as keyof typeof finalPlan])));
    const passed=r.runStatus==='completed'&&r.taskStatus==='completed'&&r.mode==='workspaceWrite'&&r.diffShown===true&&r.requiredCases===4
      &&r.sandboxed===true&&r.isolated===true&&r.hasRequire===false&&receipt?.status==='passed'&&receipt.executed===4&&receipt.skipped===0
      &&execution!.diagnostics.nativePolicyVerified&&JSON.stringify(r.changedFiles)===JSON.stringify(['src/math.mjs'])&&(!nativeCodeContinuationSmoke||(r.sameTask===true&&r.sameThread===true&&r.newRun===true&&r.newTurn===true&&frozenContractInherited&&execution!.diagnostics.clientThreadResumes===1&&execution!.diagnostics.clientTurnStarts===2));
    writeFileSync(resolve(root,'docs/progress/evidence/M1-native-code-desktop.json'),JSON.stringify({status:passed?'passed':'blocked',observedAt:new Date().toISOString(),kind:'real_electron_real_model_code_task_and_trusted_sandbox_verification',
      backend:'native_locked_app_server',inferenceRequested:true,folderDialogSelection:'fixed_fixture_substitution',cliVersion:verifiedCodex(root).lock.cliVersion,platform:process.platform+'-'+process.arch,verifiedMethods:['thread/start',...(nativeCodeContinuationSmoke?['thread/resume']:[]),'turn/start'],frozenContractInherited,diagnostics:execution!.diagnostics,result},null,2)+'\n');
    writeFileSync(resolve(root,'.local/M1-native-code-desktop.png'),(await window.webContents.capturePage()).toPNG());app.quit();
  }

}
function showMainWindow():Promise<BrowserWindow>{
  if(quitting)return Promise.reject(new LedgerError('RUNTIME_STOPPING'));
  if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();return Promise.resolve(window);}
  if(!windowOpening)windowOpening=createDesktopWindow(directory,documentPath,documentUrl,created=>{window=created;},closed=>{if(window===closed)window=undefined;}).finally(()=>{windowOpening=undefined;});
  return windowOpening;
}
app.on('activate',()=>{if(windowsReady&&!quitting)void showMainWindow().catch(()=>{});});
app.on('second-instance',()=>{if(windowsReady&&!quitting)void showMainWindow().catch(()=>{});});
app.on('window-all-closed',()=>{if(!keepRunningWithoutWindow&&!active)app.quit();});
app.on('before-quit', event => {
  quitting=true;
  clearInterval(outboxTimer);outboxTimer=undefined;clearInterval(scheduleTimer);scheduleTimer=undefined;
  if(terminalService&&!terminalStopping){event.preventDefault();terminalStopping=true;void terminalService.stop().finally(()=>{terminalService=undefined;app.quit();});return;}
  if(worktreeService&&!worktreeStopping){event.preventDefault();worktreeStopping=true;void worktreeService.stop().finally(()=>{worktreeService=undefined;app.quit();});return;}
  if (active) { event.preventDefault(); quitting = true; controller?.abort(); }
  else if (execution?.busy) {
    event.preventDefault(); void execution.close().finally(() => app.quit());
  } else if (fixtureDirectory) {
    event.preventDefault(); const owned = fixtureDirectory; fixtureDirectory = undefined;
    ledger?.close(); ledger = undefined;
    void rm(owned, { recursive: true, force: true }).finally(() => app.quit());
  } else if (ledger) { ledger.close(); ledger = undefined; }
});
