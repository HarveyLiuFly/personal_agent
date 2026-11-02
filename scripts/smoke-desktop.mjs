import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { openDisplay } from './virtual-display.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const history = process.argv.includes('--history');
const file = resolve(root, `docs/progress/evidence/${history ? 'M1.1b-desktop' : 'M0-desktop-smoke'}.json`);
await mkdir(dirname(file), { recursive: true });
// Replace old evidence before starting so an unsuccessful new run cannot reuse a past success.
await writeFile(file, JSON.stringify({ status: 'running', observedAt: new Date().toISOString(), kind: history ? 'real_electron_with_local_rpc_fixture' : 'real_electron_window_smoke' }, null, 2) + '\n');
let display;
let evidence;
try {
  display = await openDisplay(root);
  const child = spawn(electron, ['.', history ? '--m1-history-smoke' : '--m0-window-smoke'], { cwd: root, stdio: 'inherit', env: display.env });
  let timedOut = false;
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  }, 40_000);
  let outcome;
  try {
    outcome = await new Promise((resolveOutcome, reject) => {
      child.once('error', () => reject(new Error('ELECTRON_SPAWN_FAILED')));
      child.once('close', (exitCode, signal) => resolveOutcome({ exitCode, signal }));
    });
  } finally { clearTimeout(timer); clearTimeout(killTimer); }
  const current = JSON.parse(await readFile(file, 'utf8'));
  evidence = { ...current, observedAt: new Date().toISOString(), display: display.kind, ...outcome, timedOut,
    status: outcome.exitCode === 0 && current.status === 'passed' && current.result ? 'passed' : 'blocked' };
  if (evidence.status !== 'passed') evidence.code = 'ELECTRON_VALIDATION_FAILED';
} catch (error) {
  const code = error instanceof Error && /^[A-Z0-9_a-z]+$/.test(error.message) ? error.message : 'HOST_ERROR';
  evidence = { status: 'blocked', observedAt: new Date().toISOString(), kind: 'real_electron_window_smoke', code };
} finally { await display?.close(); }
await writeFile(file, JSON.stringify(evidence, null, 2) + '\n');
await writeFile(file.replace('.json', `-${evidence.observedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
if (evidence.status !== 'passed') process.exitCode = 1;
