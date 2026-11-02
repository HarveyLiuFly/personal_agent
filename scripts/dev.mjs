import { spawn } from 'node:child_process';
import electron from 'electron';
await import('./build.mjs');
const child = spawn(electron, ['.'], { stdio: 'inherit', env: process.env });
child.once('error', () => { console.error('Electron failed to start.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
