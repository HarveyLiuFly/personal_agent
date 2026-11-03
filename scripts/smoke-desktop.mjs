import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { openDisplay } from './virtual-display.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recovery=process.argv.includes('--worktree-recovery');
const tools=process.argv.includes('--tools');
const rehearsal=process.argv.includes('--rehearsal');
const resources=process.argv.includes('--resources');
const backups=rehearsal||process.argv.includes('--backups');
const worktreeCodePreflight=process.argv.includes('--worktree-code-preflight');
const worktreeCode=worktreeCodePreflight||process.argv.includes('--worktree-code');
const terminal=process.argv.includes('--terminal');
const worktrees=process.argv.includes('--worktrees');
const backgroundNative=process.argv.includes('--background-native');
const background=process.argv.includes('--background')||backgroundNative;
const codeContinuation=process.argv.includes('--native-code-continue');
const nativeCode=process.argv.includes('--native-code')||codeContinuation;
const continuation=process.argv.includes('--continuation');
const schedulerAuto=process.argv.includes('--scheduler-auto');
const scheduler=process.argv.includes('--scheduler')||schedulerAuto;
const plans=process.argv.includes('--plans');
const budget=process.argv.includes('--budget');
const tasks=process.argv.includes('--tasks')||budget||plans||scheduler;
const interactions = process.argv.includes('--interactions');
const execution = process.argv.includes('--execution') || interactions;
const history = process.argv.includes('--history');
const file = resolve(root, `docs/progress/evidence/${resources?'M2.2e-desktop':rehearsal?'M2.7b-desktop':backups?'M2.7a-desktop':worktreeCode?(worktreeCodePreflight?'M2.1b-worktree-preflight':'M2.1b-worktree-native'):tools?'M2.1b-tools-desktop':recovery?'M2.5b-desktop':terminal?'M2.6a-desktop':worktrees?'M2.5a-desktop':background?(backgroundNative?'M2.4a-native-background':'M2.4a-desktop'):schedulerAuto?'M2.3d-desktop':scheduler?'M2.3c-desktop':plans?'M2.2d-desktop':budget?'M2.2c-desktop':tasks?'M2.2b-desktop':nativeCode ? 'M1-native-code-desktop' : continuation?'M1.3c-desktop': interactions ? 'M1.2-desktop' : execution ? 'M1.1c-desktop' : history ? 'M1.1b-desktop' : 'M0-desktop-smoke'}.json`);
await mkdir(dirname(file), { recursive: true });
// Replace old evidence before starting so an unsuccessful new run cannot reuse a past success.
await writeFile(file, JSON.stringify({ status: 'running', observedAt: new Date().toISOString(), kind: history ? 'real_electron_with_local_rpc_fixture' : 'real_electron_window_smoke' }, null, 2) + '\n');
let display;
let evidence;
try {
  display = await openDisplay(root);
  if(terminal)await rm(resolve(root,'.local/M2.6a-quit-private.json'),{force:true});
  const child = spawn(electron, ['.', resources?'--m2-resources-smoke':rehearsal?'--m2-rehearsal-smoke':backups?'--m2-backups-smoke':worktreeCode?(worktreeCodePreflight?'--m2-worktree-code-preflight':'--m2-worktree-code-smoke'):tools?'--m2-tools-smoke':recovery?'--m2-worktree-recovery-smoke':terminal?'--m2-terminal-smoke':worktrees?'--m2-worktrees-smoke':background?(backgroundNative?'--m2-background-native-smoke':'--m2-background-smoke'):schedulerAuto?'--m2-scheduler-auto-smoke':scheduler?'--m2-scheduler-smoke':plans?'--m2-plans-smoke':budget?'--m2-budget-ui-smoke':tasks?'--m2-tasks-smoke':codeContinuation?'--m1-native-code-continuation-smoke':nativeCode ? '--m1-native-code-smoke' : continuation?'--m1-continuation-smoke':interactions ? '--m1-interaction-smoke' : execution ? '--m1-execution-smoke' : history ? '--m1-history-smoke' : '--m0-window-smoke'], { cwd: root, stdio: 'inherit', env: display.env });
  let timedOut = false;
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  }, (worktreeCode&&!worktreeCodePreflight)||nativeCode||backgroundNative ? 240_000 : terminal?60000:40_000);
  let outcome;
  try {
    outcome = await new Promise((resolveOutcome, reject) => {
      child.once('error', () => reject(new Error('ELECTRON_SPAWN_FAILED')));
      child.once('close', (exitCode, signal) => resolveOutcome({ exitCode, signal }));
    });
  } finally { clearTimeout(timer); clearTimeout(killTimer); }
  const current = JSON.parse(await readFile(file, 'utf8'));
  evidence = { ...current, observedAt: new Date().toISOString(), display: display.kind, ...outcome, timedOut,
    platform: `${process.platform}-${process.arch}`,
    ...(background?{explicitQuitProcessExited:outcome.exitCode===0}:{}),
    status: outcome.exitCode === 0 && current.status === 'passed' && current.result ? 'passed' : 'blocked' };
  if(terminal&&outcome.exitCode===0){
    let confirmed=false;try{const receipt=JSON.parse(await readFile(resolve(root,'.local/M2.6a-quit-private.json'),'utf8'));confirmed=receipt.mainPid===child.pid&&receipt.pids.length===3&&receipt.pids.every(pid=>{if(!Number.isSafeInteger(pid)||pid<2)return false;try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});}catch{}
    evidence.explicitQuitProcessesStopped=confirmed;if(!confirmed)evidence.status='blocked';await rm(resolve(root,'.local/M2.6a-quit-private.json'),{force:true});
  }
  if (evidence.status !== 'passed') evidence.code = current.code ?? 'ELECTRON_VALIDATION_FAILED';
} catch (error) {
  const code = error instanceof Error && /^[A-Z0-9_a-z]+$/.test(error.message) ? error.message : 'HOST_ERROR';
  evidence = { status: 'blocked', observedAt: new Date().toISOString(), kind: 'real_electron_window_smoke', code };
} finally { await display?.close(); }
await writeFile(file, JSON.stringify(evidence, null, 2) + '\n');
await writeFile(file.replace('.json', `-${evidence.observedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
if (evidence.status !== 'passed') process.exitCode = 1;
