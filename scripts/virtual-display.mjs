import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

function executable(root, name) {
  const local = resolve(root, '.local/system/usr/bin', name);
  if (existsSync(local)) return local;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const file = join(directory, name);
    if (existsSync(file)) return file;
  }
  throw new Error(`HEADLESS_DEPENDENCY_MISSING_${name}`);
}

/** Uses an existing display or an authenticated, local-only Xvfb owned by this invocation. */
export async function openDisplay(root) {
  // Native desktop platforms do not use DISPLAY or X11 dependencies.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return { env: process.env, kind: 'native_desktop', close: async () => {} };
  }
  if (process.platform !== 'linux') throw new Error('DISPLAY_PLATFORM_UNSUPPORTED');
  // X11 or a Wayland session (Electron uses XWayland/Ozone as configured by the desktop).
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return { env: process.env, kind: process.env.WAYLAND_DISPLAY ? 'existing_wayland_display' : 'existing_display', close: async () => {} };
  const xvfb = executable(root, 'Xvfb');
  const xauth = executable(root, 'xauth');
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-display-'));
  await chmod(directory, 0o700);
  let server;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = new Promise(resolveStopped => server.once('close', resolveStopped));
      server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 2_000);
      try { await stopped; } finally { clearTimeout(timer); }
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    // Xvfb atomically chooses a free display; no stale-lock removal or external X server access.
    const authority = join(directory, 'Xauthority');
    const cookie = randomBytes(16).toString('hex');
    const auth = spawnSync(xauth, ['-f', authority, 'add', ':0', 'MIT-MAGIC-COOKIE-1', cookie], { stdio: 'ignore' });
    if (auth.status !== 0) throw new Error('XAUTH_INITIALIZATION_FAILED');
    await chmod(authority, 0o600);
    server = spawn(xvfb, ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-auth', authority],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    const display = await new Promise((resolveDisplay, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('XVFB_START_TIMEOUT')), 8_000);
      const fail = () => { clearTimeout(timer); reject(new Error('XVFB_START_FAILED')); };
      server.once('error', fail);
      server.once('exit', fail);
      server.stdio[3].on('data', chunk => {
        output += chunk.toString('utf8');
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        if (!/^\d+\n$/.test(output)) { reject(new Error('XVFB_INVALID_DISPLAY')); return; }
        server.removeListener('exit', fail);
        resolveDisplay(`:${Number(output.trim())}`);
      });
    });
    // xauth entries select client cookies; Xvfb accepts the same cookie for its chosen display.
    const selected = spawnSync(xauth, ['-f', authority, 'add', display, 'MIT-MAGIC-COOKIE-1', cookie], { stdio: 'ignore' });
    if (selected.status !== 0) throw new Error('XAUTH_SELECTION_FAILED');
    await access(`/tmp/.X11-unix/X${display.slice(1)}`);
    return { kind: 'authenticated_xvfb', env: { ...process.env, DISPLAY: display, XAUTHORITY: authority }, close };
  } catch (error) { await close(); throw error; }
}
