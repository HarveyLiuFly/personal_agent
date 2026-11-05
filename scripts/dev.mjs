import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { printLinuxPreflight } from './linux-preflight.mjs';
await import('./build.mjs');
printLinuxPreflight(electron, resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const child = spawn(electron, ['.'], { stdio: 'inherit', env: process.env });
// Ctrl+C / SIGTERM on this launcher quit Electron normally instead of orphaning it.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
child.once('error', () => { console.error('Electron failed to start.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
