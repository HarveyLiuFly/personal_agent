import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, 'docs/progress/evidence/M0-desktop-smoke.json');
await mkdir(dirname(file), { recursive: true });
// Replace old evidence before starting so an unsuccessful new run cannot reuse a past success.
await writeFile(file, JSON.stringify({ status: 'running', observedAt: new Date().toISOString(), kind: 'real_electron_window_smoke' }, null, 2) + '\n');
const child = spawn(electron, ['.', '--m0-window-smoke'], { cwd: root, stdio: 'inherit', env: process.env });
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 40_000);
child.once('error', async () => {
  clearTimeout(timer);
  await writeFile(file, JSON.stringify({ status: 'blocked', code: 'ELECTRON_SPAWN_FAILED', observedAt: new Date().toISOString() }, null, 2) + '\n');
  process.exitCode = 1;
});
child.once('exit', async (code, signal) => {
  clearTimeout(timer);
  if (code !== 0) {
    const current = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...current, status: 'blocked', exitCode: code, signal, timedOut,
      code: 'ELECTRON_VALIDATION_FAILED' }, null, 2) + '\n');
    process.exitCode = 1;
  } else {
    const current = JSON.parse(await readFile(file, 'utf8'));
    if (!current.result) { process.exitCode = 1; return; }
    await writeFile(file, JSON.stringify({ ...current, status: 'passed' }, null, 2) + '\n');
    console.log('Real Electron render, isolated sandboxed Preload, and model-catalog IPC passed.');
  }
});
