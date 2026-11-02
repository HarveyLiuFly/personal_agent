import { app, BrowserWindow, ipcMain } from 'electron';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectConnection, runRealSmoke } from '../../../packages/codex-adapter/src/smoke.ts';
import { resolveExecutable, verifyExecutable } from '../../../packages/codex-adapter/src/launch.ts';
import { RpcFailure } from '../../../packages/codex-adapter/src/rpc.ts';
import type { ConnectionInfo, SmokeInfo } from './bridge.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const documentPath = resolve(directory, 'renderer/index.html');
const documentUrl = pathToFileURL(documentPath).href;
let active = false;
let controller: AbortController | undefined;
let quitting = false;
let window: BrowserWindow | undefined;
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
async function boot(): Promise<void> {
  if (process.argv.includes('--m0-window-smoke')) app.setPath('userData', resolve(root, '.local/desktop-smoke-data'));
  await app.whenReady();
  const state = resolve(app.getPath('userData'), 'codex-state');
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
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  await window.loadFile(documentPath);
  if (process.argv.includes('--m0-window-smoke')) {
    // Fixed test-only evaluation; no Renderer API accepts JS or a command string.
    const result: unknown = await window.webContents.executeJavaScript(`(async () => ({
      title: document.title,
      rendered: document.body.textContent.includes('Personal Agent'),
      hasRequire: typeof require !== 'undefined',
      bridgeKeys: Object.keys(window.personalAgent).sort(),
      sandboxed: window.personalAgent.security.sandboxed,
      isolated: window.personalAgent.security.isolated,
      connection: await window.personalAgent.inspect()
    }))()`);
    const evidence = { observedAt: new Date().toISOString(), kind: 'real_electron_window_smoke',
      browserSandbox: app.commandLine.hasSwitch('no-sandbox') ? 'disabled' : 'enabled', result };
    mkdirSync(resolve(root, 'docs/progress/evidence'), { recursive: true });
    writeFileSync(resolve(root, 'docs/progress/evidence/M0-desktop-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
    const r = result as Record<string, unknown>;
    app.exit(r.rendered === true && r.hasRequire === false && r.sandboxed === true && r.isolated === true
      && evidence.browserSandbox === 'enabled' && (r.connection as ConnectionInfo)?.status === 'connected'
      && JSON.stringify(r.bridgeKeys) === JSON.stringify(['inspect', 'runSmoke', 'security']) ? 0 : 1);
  }
}
app.on('window-all-closed', () => { if (!active) app.quit(); });
app.on('before-quit', event => {
  if (active) { event.preventDefault(); quitting = true; controller?.abort(); }
});
