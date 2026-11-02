import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectConnection, runRealSmoke } from '../../../packages/codex-adapter/src/smoke.ts';
import { resolveExecutable, verifyExecutable } from '../../../packages/codex-adapter/src/launch.ts';
import { RpcFailure, StdioRpcClient } from '../../../packages/codex-adapter/src/rpc.ts';
import { HistoryBrowser } from '../../../packages/codex-adapter/src/history.ts';
import type { ReadPort } from '../../../packages/codex-adapter/src/history.ts';
import { readConnection } from '../../../packages/codex-adapter/src/read-connection.ts';
import { runtimeEnvironment } from '../../../packages/codex-adapter/src/launch.ts';
import type { HostResult } from '../../../packages/contracts/src/views.ts';
import type { ConnectionInfo, SmokeInfo } from './bridge.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const documentPath = resolve(directory, 'renderer/index.html');
const documentUrl = pathToFileURL(documentPath).href;
let active = false;
let controller: AbortController | undefined;
let quitting = false;
let window: BrowserWindow | undefined;
const historySmoke = process.argv.includes('--m1-history-smoke');
let fixtureDirectory: string | undefined;
if (!app.requestSingleInstanceLock()) app.quit();
else void boot().catch(() => app.exit(1));

function authorized(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== documentUrl) throw new Error('UNAUTHORIZED_IPC');
}
function executable(): string {
  const binary = resolveExecutable('codex');
  const lock = JSON.parse(readFileSync(resolve(root, 'codex-version.lock.json'), 'utf8')) as { executableSha256: string };
  verifyExecutable(binary, lock.executableSha256);
  return binary;
}
async function historyCommand<T>(event: Electron.IpcMainInvokeEvent, args: unknown[], count: number, operation: () => Promise<T>): Promise<HostResult<T>> {
  authorized(event);
  if (args.length !== count) return { ok: false, errorCode: 'UNEXPECTED_ARGUMENTS' };
  if (active) return { ok: false, errorCode: 'RUNTIME_BUSY' };
  active = true; controller = new AbortController();
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, errorCode: error instanceof RpcFailure ? error.code : 'HOST_ERROR' }; }
  finally { active = false; controller = undefined; if (quitting || BrowserWindow.getAllWindows().length === 0) app.quit(); }
}
async function boot(): Promise<void> {
  if (process.argv.includes('--m0-window-smoke')) app.setPath('userData', resolve(root, '.local/desktop-smoke-data'));
  if (historySmoke) app.setPath('userData', resolve(root, '.local/desktop-history-smoke-data'));
  await app.whenReady();
  const state = resolve(app.getPath('userData'), 'codex-state');
  let fixtureWorkspace: string | undefined;
  const fixtureMethods = new Set<string>();
  if (historySmoke) {
    mkdirSync(resolve(root, '.local'), { recursive: true });
    fixtureDirectory = await mkdtemp(resolve(root, '.local/history-desktop-'));
    fixtureWorkspace = resolve(fixtureDirectory, 'workspace'); await mkdir(fixtureWorkspace);
  }
  const history = new HistoryBrowser(async read => {
    if (!historySmoke) return readConnection(executable(), state, controller?.signal)(read);
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
  });
  ipcMain.handle('history:chooseProject', (event, ...args: unknown[]) => historyCommand(event, args, 0, async () => {
    if (fixtureWorkspace) return history.registerDirectory(fixtureWorkspace);
    const selection = await dialog.showOpenDialog(window!, { title: '选择项目目录', properties: ['openDirectory'] });
    return selection.canceled || !selection.filePaths[0] ? null : history.registerDirectory(selection.filePaths[0]);
  }));
  ipcMain.handle('history:listThreads', (event, ...args: unknown[]) => historyCommand(event, args, 1, () => history.listThreads(args[0])));
  ipcMain.handle('history:listTurns', (event, ...args: unknown[]) => historyCommand(event, args, 1, () => history.listTurns(args[0])));
  ipcMain.handle('history:listItems', (event, ...args: unknown[]) => historyCommand(event, args, 1, () => history.listItems(args[0])));
  ipcMain.handle('runtime:inspect', async (event, ...args: unknown[]): Promise<ConnectionInfo> => {
    authorized(event);
    if (args.length) throw new Error('UNEXPECTED_ARGUMENTS');
    if (active) return { status: 'error', errorCode: 'RUNTIME_BUSY' };
    active = true;
    controller = new AbortController();
    try { return { status: 'connected', ...await inspectConnection(executable(), state, controller.signal) }; }
    catch (error) { return { status: 'error', errorCode: error instanceof RpcFailure ? error.code : 'HOST_ERROR' }; }
    finally { active = false; controller = undefined; if (quitting || BrowserWindow.getAllWindows().length === 0) app.quit(); }
  });
  ipcMain.handle('runtime:smoke', async (event, ...args: unknown[]): Promise<SmokeInfo> => {
    authorized(event);
    if (args.length) throw new Error('UNEXPECTED_ARGUMENTS');
    if (active) return { status: 'error', errorCode: 'RUNTIME_BUSY' };
    active = true;
    controller = new AbortController();
    try {
      const result = await runRealSmoke(executable(), state, controller.signal);
      return { status: 'passed', finalText: result.finalText, threadId: result.threadId, turnId: result.turnId };
    } catch (error) { return { status: 'error', errorCode: error instanceof RpcFailure ? error.code : 'HOST_ERROR' }; }
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
      && JSON.stringify(r.bridgeKeys) === JSON.stringify(['chooseProject', 'inspect', 'listItems', 'listThreads', 'listTurns', 'runSmoke', 'security']);
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
}
app.on('window-all-closed', () => { if (!active) app.quit(); });
app.on('before-quit', event => {
  if (active) { event.preventDefault(); quitting = true; controller?.abort(); }
  else if (fixtureDirectory) {
    event.preventDefault(); const owned = fixtureDirectory; fixtureDirectory = undefined;
    void rm(owned, { recursive: true, force: true }).finally(() => app.quit());
  }
});
