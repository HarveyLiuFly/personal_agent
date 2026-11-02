import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ExecutionLedger, LedgerError } from '../../../packages/store/src/ledger.ts';
import { ForegroundExecution } from '../../../packages/runtime/src/execution.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectConnection } from '../../../packages/codex-adapter/src/smoke.ts';
import { resolveExecutable } from '../../../packages/codex-adapter/src/launch.ts';
import { verifiedCodex } from '../../../packages/codex-adapter/src/binary.ts';
import { RpcFailure, StdioRpcClient } from '../../../packages/codex-adapter/src/rpc.ts';
import { HistoryBrowser } from '../../../packages/codex-adapter/src/history.ts';
import type { ReadPort } from '../../../packages/codex-adapter/src/history.ts';
import { readConnection } from '../../../packages/codex-adapter/src/read-connection.ts';
import { runtimeEnvironment } from '../../../packages/codex-adapter/src/launch.ts';
import type { HostResult } from '../../../packages/contracts/src/views.ts';
import type { ConnectionInfo } from './bridge.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const documentPath = resolve(directory, 'renderer/index.html');
const documentUrl = pathToFileURL(documentPath).href;
let active = false;
let controller: AbortController | undefined;
let quitting = false;
let window: BrowserWindow | undefined;
let ledger: ExecutionLedger | undefined;
let execution: ForegroundExecution | undefined;
const interactionSmoke = process.argv.includes('--m1-interaction-smoke');
const executionSmoke = process.argv.includes('--m1-execution-smoke') || interactionSmoke;
const historySmoke = process.argv.includes('--m1-history-smoke');
let fixtureDirectory: string | undefined;
  if (process.argv.includes('--m0-window-smoke')) app.setPath('userData', resolve(root, '.local/desktop-smoke-data'));
  if (historySmoke) app.setPath('userData', resolve(root, '.local/desktop-history-smoke-data'));
  if (executionSmoke) app.setPath('userData', resolve(root, '.local/desktop-execution-smoke-data'));
if (!app.requestSingleInstanceLock()) app.quit();
else void boot().catch(async error => {
  const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'HOST_ERROR';
  console.error('DESKTOP_BOOT_FAILED', code);
  if (executionSmoke || historySmoke || process.argv.includes('--m0-window-smoke')) {
    if (window) { try { writeFileSync(resolve(root, '.local/desktop-failure.png'), (await window.webContents.capturePage()).toPNG()); } catch {} }
    const file = interactionSmoke ? 'M1.2-desktop' : executionSmoke ? 'M1.1c-desktop' : historySmoke ? 'M1.1b-desktop' : 'M0-desktop-smoke';
    writeFileSync(resolve(root, `docs/progress/evidence/${file}.json`), JSON.stringify({ status: 'blocked', code, observedAt: new Date().toISOString() }) + '\n');
  }
  try { await execution?.close(); ledger?.close(); } catch {}
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
  finally { active = false; controller = undefined; if (quitting || BrowserWindow.getAllWindows().length === 0) app.quit(); }
}
async function boot(): Promise<void> {
  await app.whenReady();
  const state = resolve(app.getPath('userData'), 'codex-state');
  let fixtureWorkspace: string | undefined;
  const fixtureMethods = new Set<string>();
  if (historySmoke || executionSmoke) {
    mkdirSync(resolve(root, '.local'), { recursive: true });
    fixtureDirectory = await mkdtemp(resolve(root, '.local/history-desktop-'));
    fixtureWorkspace = resolve(fixtureDirectory, 'workspace'); await mkdir(fixtureWorkspace);
  }
  if (!historySmoke) {
    ledger = new ExecutionLedger(resolve(fixtureDirectory ?? app.getPath('userData'), 'execution/ledger.db'), readFileSync(resolve(directory, 'schema.sql'), 'utf8'));
    ledger.startOwner(randomUUID(), true); // OS single-instance lock was acquired before boot().
    execution = new ForegroundExecution(ledger, { executable: executionSmoke ? resolveExecutable('node') : executable(), stateDirectory: state, mode: interactionSmoke ? 'workspaceWrite' : 'readOnly',
      ...(executionSmoke ? { connect: callbacks => new StdioRpcClient({ executable: resolveExecutable('node'),
        args: [resolve(root, 'tests/fixtures/execution-server.ts'), interactionSmoke ? 'approval-accept' : 'slow', resolve(fixtureDirectory!, 'execution/ledger.db'), resolve(fixtureDirectory!, 'execution-receipts')], env: runtimeEnvironment(), ...callbacks }) } : {}) });
  }
  const history = new HistoryBrowser(async read => {
    if (!historySmoke && !executionSmoke) return readConnection(executable(), state, controller?.signal)(read);
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
    if (fixtureWorkspace) return history.registerDirectory(fixtureWorkspace);
    const selection = await dialog.showOpenDialog(window!, { title: '选择项目目录', properties: ['openDirectory'] });
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
  ipcMain.handle('execution:workspaceState', (event, ...args: unknown[]) => executionCommand(event, args, 0, () => ({ projects: ledger?.projects() ?? [], canSubmit: Boolean(execution), mode: interactionSmoke ? 'workspaceWrite' as const : 'readOnly' as const })));
  // Re-register persisted grants in the read-only browser; invalid directories remain blocked by Store.
  for (const project of ledger?.projects() ?? []) {
    try { ledger!.workspace(project.id); await history.registerDirectory(project.directory); } catch {}
  }
  ipcMain.handle('execution:submit', (event, ...args: unknown[]) => executionCommand(event, args, 1, () => {
    if (!execution || active) throw new LedgerError('RUNTIME_BUSY'); return execution.submit(args[0]);
  }));
  ipcMain.handle('execution:list', (event, ...args: unknown[]) => executionCommand(event, args, 1, () => {
    if (!execution) throw new LedgerError('EXECUTION_UNAVAILABLE'); return execution.list(args[0]);
  }));
  ipcMain.handle('execution:view', (event, ...args: unknown[]) => executionCommand(event, args, 1, () => {
    if (!execution) throw new LedgerError('EXECUTION_UNAVAILABLE'); return execution.view(args[0]);
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
  ipcMain.handle('runtime:inspect', async (event, ...args: unknown[]): Promise<ConnectionInfo> => {
    authorized(event);
    if (args.length) throw new Error('UNEXPECTED_ARGUMENTS');
    if (active || execution?.busy) return { status: 'error', errorCode: 'RUNTIME_BUSY' };
    active = true;
    controller = new AbortController();
    try { return { status: 'connected', ...await inspectConnection(executable(), state, controller.signal) }; }
    catch (error) { return { status: 'error', errorCode: error instanceof RpcFailure || error instanceof LedgerError ? error.code : 'HOST_ERROR' }; }
    finally { active = false; controller = undefined; if (quitting || BrowserWindow.getAllWindows().length === 0) app.quit(); }
  });
  window = new BrowserWindow({ width: 1120, height: 760, backgroundColor: '#0c1221', show: true,
    webPreferences: { preload: resolve(directory, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, devTools: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== documentUrl) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  await window.loadFile(documentPath);
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
      && JSON.stringify(r.bridgeKeys) === JSON.stringify(['chooseProject', 'getRun', 'inspect', 'interruptRun', 'listInteractions', 'listItems', 'listRuns', 'listThreads', 'listTurns', 'replyInteraction', 'security', 'submitMessage', 'workspaceState']);
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
  if (executionSmoke && !interactionSmoke) {
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

}
app.on('window-all-closed', () => { if (!active) app.quit(); });
app.on('before-quit', event => {
  if (active) { event.preventDefault(); quitting = true; controller?.abort(); }
  else if (execution?.busy) {
    event.preventDefault(); void execution.close().finally(() => app.quit());
  } else if (fixtureDirectory) {
    event.preventDefault(); const owned = fixtureDirectory; fixtureDirectory = undefined;
    ledger?.close(); ledger = undefined;
    void rm(owned, { recursive: true, force: true }).finally(() => app.quit());
  } else if (ledger) { ledger.close(); ledger = undefined; }
});
