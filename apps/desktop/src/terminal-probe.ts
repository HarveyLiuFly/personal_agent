import type { App, BrowserWindow } from 'electron';
import { BrowserWindow as Windows } from 'electron';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExecutionLedger } from '../../../packages/store/src/ledger.ts';
import { TerminalService } from '../../../packages/workspace/src/terminal.ts';
import { evidenceDir } from './evidence.ts';
import { DESKTOP_API_KEYS } from './api-keys.ts';
async function wait(check: () => boolean, ms = 10000, stage = 'UNKNOWN') {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw Error('TERMINAL_DESKTOP_TIMEOUT_' + stage);
    await new Promise((done) => setTimeout(done, 30));
  }
}
const click = async (win: BrowserWindow, selector: string) =>
  win.webContents.executeJavaScript(
    `(async()=>{const until=Date.now()+15000;while(!document.querySelector(${JSON.stringify(selector)})||document.querySelector(${JSON.stringify(selector)}).disabled){if(Date.now()>until)throw Error('TERMINAL_UI_TIMEOUT');await new Promise(done=>setTimeout(done,30));}document.querySelector(${JSON.stringify(selector)}).click();})()`,
  );
const terminalText = (service: TerminalService, projectId: string) =>
  service
    .view({ projectId, afterSequence: 0 })
    .chunks.map((c) => Buffer.from(c.data, 'base64').toString('utf8'))
    .join('');
async function type(win: BrowserWindow, command: string) {
  win.show();
  win.focus();
  win.webContents.focus();
  await click(win, '[data-action="focus-terminal"]');
  await win.webContents.executeJavaScript(
    `(async()=>{document.querySelector('[data-terminal-screen]').scrollIntoView({block:'center'});document.querySelector('[data-terminal-screen] .xterm-helper-textarea')?.focus();await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));})()`,
  );
  for (const char of command) {
    const modifiers: Array<'shift'> = /[A-Z]/.test(char) ? ['shift'] : [];
    win.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: char === ' ' ? 'Space' : char,
      modifiers,
    });
    win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
    win.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: char === ' ' ? 'Space' : char,
      modifiers,
    });
    await new Promise((done) => setTimeout(done, 2));
  }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
}
/** Fixed public input typed through the real xterm renderer. Never exposed over IPC. */
export async function runTerminalProbe(
  root: string,
  app: App,
  initial: BrowserWindow,
  store: ExecutionLedger,
  service: TerminalService,
  source: string,
  show: () => Promise<BrowserWindow>,
) {
  await click(initial, '[data-action="choose-project"]');
  await click(initial, '[data-action="open-workspace"]');
  await initial.webContents.executeJavaScript(
    `(async()=>{const until=Date.now()+12000;while(!document.querySelector('[data-terminal-panel]')){if(Date.now()>until)throw Error('TERMINAL_PANEL_TIMEOUT');await new Promise(done=>setTimeout(done,30));}document.querySelector('[data-terminal-panel]').open=true;})()`,
  );
  await click(initial, '[data-action="open-terminal"]');
  const scope = store.projects()[0]!.id;
  await wait(() => store.terminalLatest(scope)?.state === 'running');
  const session = store.terminalLatest(scope)!,
    host = store.terminalHost(scope, session.sessionId);
  await type(
    initial,
    "test -t 0 && test -t 1 && test -f public.txt && printf '\\nTTY_DESKTOP_OK\\n'; printf A >> terminal-count.txt",
  );
  await wait(
    () => terminalText(service, scope).includes('\r\nTTY_DESKTOP_OK\r\n'),
    10000,
    'FIRST_OUTPUT',
  );
  await wait(
    () => readFileSync(resolve(source, 'terminal-count.txt'), 'utf8') === 'A',
    10000,
    'FIRST_FILE',
  );
  const beforePaste = store.terminalLatest(scope)!.lastInputSequence;
  await initial.webContents.executeJavaScript(
    `(()=>{const data=new DataTransfer();data.setData('text/plain','x'.repeat(100000));document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true}));})()`,
  );
  await wait(() => store.terminalLatest(scope)!.lastInputSequence === beforePaste);
  const oversizedPaste = await initial.webContents.executeJavaScript(
    `(async()=>{const until=Date.now()+5000;while(!document.querySelector('[data-terminal-error="TERMINAL_INPUT_TOO_LARGE"]')){if(Date.now()>until)throw Error('OVERSIZED_PASTE_NOT_BLOCKED');await new Promise(done=>setTimeout(done,30));}return true;})()`,
  );
  if (store.terminalLatest(scope)!.lastInputSequence !== beforePaste)
    throw Error('OVERSIZED_PASTE_WAS_SENT');
  const rejected = await initial.webContents.executeJavaScript(
    `(async()=>{const a=await window.personalAgent.openTerminal({projectId:${JSON.stringify(scope)},commandKey:'raw',cols:80,rows:24,shell:'/bin/sh'}),b=await window.personalAgent.writeTerminal({projectId:'foreign',sessionId:${JSON.stringify(session.sessionId)},sequence:999,text:'must not write'});return{extra:!a.ok,foreign:!b.ok};})()`,
  );
  await click(initial, '[data-action="resize-terminal"]');
  await wait(() => store.terminalLatest(scope)?.cols === 100, 10000, 'SIZE_SAVED');
  await type(initial, 'stty size');
  await wait(() => terminalText(service, scope).includes('30 100'), 10000, 'SIZE_OUTPUT');
  const renderer = initial.webContents.getOSProcessId(),
    gone = once(initial.webContents, 'render-process-gone');
  process.kill(renderer, 'SIGKILL');
  const [, reason] = await gone;
  initial.destroy();
  const windowless = Windows.getAllWindows().length === 0,
    stillRunning = store.terminalLatest(scope)?.state === 'running';
  const reopened = await show();
  await click(reopened, '[data-action="open-workspace"]');
  await reopened.webContents.executeJavaScript(
    `(async()=>{const until=Date.now()+12000;while(!document.querySelector('[data-terminal-panel]')){if(Date.now()>until)throw Error('TERMINAL_PANEL_TIMEOUT');await new Promise(done=>setTimeout(done,30));}document.querySelector('[data-terminal-panel]').open=true;})()`,
  );
  await click(reopened, '[data-action="focus-terminal"]');
  const recovery = await reopened.webContents.executeJavaScript(
    `(async()=>{const until=Date.now()+12000;while(!document.querySelector('[data-terminal-screen]')?.textContent.includes('TTY_DESKTOP_OK')){if(Date.now()>until)throw Error('TERMINAL_OUTPUT_NOT_RENDERED');await new Promise(done=>setTimeout(done,30));}return{sameSession:document.querySelector('[data-terminal-screen]').dataset.terminalSession===${JSON.stringify(session.sessionId)},apiCount:Object.keys(window.personalAgent).length,sandboxed:window.personalAgent.security.sandboxed,isolated:window.personalAgent.security.isolated,noRequire:typeof require==='undefined'};})()`,
  );
  await type(reopened, "printf '\\nREOPEN_INPUT_OK\\n'; printf B >> terminal-count.txt");
  await wait(
    () => terminalText(service, scope).includes('\r\nREOPEN_INPUT_OK\r\n'),
    10000,
    'SECOND_OUTPUT',
  );
  await wait(
    () => readFileSync(resolve(source, 'terminal-count.txt'), 'utf8') === 'AB',
    10000,
    'SECOND_FILE',
  );
  await click(reopened, '[data-action="close-terminal"]');
  await wait(() => store.terminalLatest(scope)?.state === 'exited', 10000, 'EXIT');
  const stopped = [host.supervisorPid!, host.ptyPid!].every((pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  });
  const result = {
    oversizedPasteBlocked: oversizedPaste,
    realTty: true,
    realXtermKeyboardInput: true,
    resized: true,
    extraRejected: rejected.extra,
    foreignRejected: rejected.foreign,
    realRendererSigkill: reason.reason === 'killed' || reason.reason === 'crashed',
    windowless,
    shellKeptWhileWindowless: stillRunning,
    sameSession: recovery.sameSession,
    replayedOutputVisible: true,
    noDuplicateInput: readFileSync(resolve(source, 'terminal-count.txt'), 'utf8') === 'AB',
    realProcessesStopped: stopped,
    noModelRuns: store.runs(scope).length === 0,
    apiCount: recovery.apiCount === DESKTOP_API_KEYS.length,
    sandboxed: recovery.sandboxed,
    isolated: recovery.isolated,
    noRequire: recovery.noRequire,
  };
  mkdirSync(resolve(evidenceDir(root), 'screenshots'), { recursive: true });
  writeFileSync(
    resolve(evidenceDir(root), 'screenshots/M2.6a-terminal.png'),
    (await reopened.webContents.capturePage()).toPNG(),
  );
  await click(reopened, '[data-action="open-terminal"]');
  await wait(() => store.terminalLatest(scope)?.state === 'running', 10000, 'QUIT_SESSION_RUNNING');
  const quitSession = store.terminalLatest(scope)!,
    quitHost = store.terminalHost(scope, quitSession.sessionId);
  await type(reopened, 'sleep 120 & print $! > quit-child.pid; wait');
  await wait(
    () => {
      try {
        return Number(readFileSync(resolve(source, 'quit-child.pid'), 'utf8').trim()) > 1;
      } catch {
        return false;
      }
    },
    10000,
    'QUIT_JOB_STARTED',
  );
  writeFileSync(
    resolve(root, '.local/M2.6a-quit-private.json'),
    JSON.stringify({
      mainPid: process.pid,
      pids: [
        quitHost.supervisorPid,
        quitHost.ptyPid,
        Number(readFileSync(resolve(source, 'quit-child.pid'), 'utf8').trim()),
      ],
    }),
  );
  writeFileSync(
    resolve(evidenceDir(root), 'M2.6a-desktop.json'),
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        status: Object.values(result).every(Boolean) ? 'passed' : 'blocked',
        kind: 'real_electron_nodepty_xterm_renderer_kill_and_reopen',
        modelTurns: 0,
        historyMetadata: 'synthetic_fixture',
        activeTerminalOnExplicitQuit: true,
        result,
      },
      null,
      2,
    ) + '\n',
  );
  app.quit();
}
