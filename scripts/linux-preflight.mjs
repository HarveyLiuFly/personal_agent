// Linux desktop prerequisites that otherwise surface as opaque Electron crashes.
// Read-only: inspects /proc and file modes, never changes the system.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const readProc = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
};

/** Mount entry that contains `path` (longest mount-point prefix). */
export function mountFor(path, mounts = readProc('/proc/self/mounts') ?? '') {
  const target = resolve(path);
  let best = null;
  for (const line of mounts.split('\n')) {
    const [device, mountPoint, type, options] = line.split(' ');
    if (!mountPoint) continue;
    const point = mountPoint.replace(/\\040/g, ' ');
    if (
      (target === point || target.startsWith(point.endsWith('/') ? point : point + '/')) &&
      (!best || point.length > best.mountPoint.length)
    ) {
      best = { device, mountPoint: point, type, options: (options ?? '').split(',') };
    }
  }
  return best;
}

/**
 * Chromium's sandbox needs either unprivileged user namespaces (not blocked by
 * AppArmor, as on Ubuntu 23.10+), or a setuid-root chrome-sandbox helper on a
 * mount without `nosuid`. Returns a status plus the exact remedies; never suggests --no-sandbox.
 */
export function electronSandboxStatus(electronBinary, proc = readProc) {
  const sandbox = join(dirname(electronBinary), 'chrome-sandbox');
  const usernsClone = proc('/proc/sys/kernel/unprivileged_userns_clone');
  const maxUserNs = proc('/proc/sys/user/max_user_namespaces');
  const apparmorRestrict = proc('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
  const usernsEnabled = usernsClone !== '0' && maxUserNs !== '0';
  const apparmorBlocks = apparmorRestrict === '1';
  let setuidRoot = false;
  try {
    const s = statSync(sandbox);
    setuidRoot = s.uid === 0 && (s.mode & 0o4000) !== 0 && (s.mode & 0o755) === 0o755;
  } catch {}
  const mount = existsSync(sandbox) ? mountFor(sandbox) : null;
  const nosuid = Boolean(mount?.options.includes('nosuid'));
  const profile = apparmorBlocks ? apparmorProfileFor(electronBinary) : null;
  if (usernsEnabled && (!apparmorBlocks || profile))
    return { ok: true, mode: 'user-namespaces', sandbox, profile };
  if (setuidRoot && !nosuid) return { ok: true, mode: 'setuid-helper', sandbox };
  const remedies = [];
  if (!nosuid) remedies.push(`sudo chown root:root '${sandbox}' && sudo chmod 4755 '${sandbox}'`);
  if (apparmorBlocks) {
    remedies.push(
      `sudo tee /etc/apparmor.d/personal-agent-electron >/dev/null <<'EOF'\nabi <abi/4.0>,\ninclude <tunables/global>\nprofile personal-agent-electron '${electronBinary}' flags=(unconfined) {\n  userns,\n  include if exists <local/personal-agent-electron>\n}\nEOF\nsudo apparmor_parser -r /etc/apparmor.d/personal-agent-electron`,
    );
  }
  return {
    ok: false,
    sandbox,
    mode: 'unavailable',
    nosuid,
    mountPoint: mount?.mountPoint ?? null,
    reason: apparmorBlocks
      ? 'AppArmor blocks unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1)'
      : !usernsEnabled
        ? 'Unprivileged user namespaces are disabled (user.max_user_namespaces=0 or kernel.unprivileged_userns_clone=0; common inside containers and nested sandboxes)'
        : 'chrome-sandbox is not setuid root',
    remedies,
  };
}

function apparmorProfileFor(binary) {
  try {
    for (const name of readdirSync('/etc/apparmor.d')) {
      const file = join('/etc/apparmor.d', name);
      try {
        if (
          statSync(file).isFile() &&
          readFileSync(file, 'utf8').includes(binary) &&
          /\buserns\b/.test(readFileSync(file, 'utf8'))
        )
          return file;
      } catch {}
    }
  } catch {}
  return null;
}

export function displayStatus(env = process.env) {
  if (env.WAYLAND_DISPLAY) return { ok: true, kind: 'wayland', value: env.WAYLAND_DISPLAY };
  if (env.DISPLAY) return { ok: true, kind: 'x11', value: env.DISPLAY };
  return { ok: false, kind: 'none' };
}

/**
 * FAT-family filesystems have no symlinks or POSIX modes: pnpm links and worktrees break (fail).
 * NTFS works in practice (ntfs3 keeps symlinks and the executable bit) but is slower for
 * node_modules and is often mounted nosuid (warn).
 */
export function projectFilesystemStatus(root) {
  const mount = mountFor(root);
  const broken = new Set(['vfat', 'exfat', 'msdos']),
    slow = new Set(['ntfs', 'ntfs3', 'fuseblk']);
  const type = mount?.type ?? 'unknown';
  return {
    ok: !broken.has(type),
    warn: slow.has(type),
    type,
    mountPoint: mount?.mountPoint ?? null,
    options: mount?.options ?? [],
  };
}

/** Prints guidance before launching Electron on Linux. Non-blocking: Electron still decides. */
export function printLinuxPreflight(electronBinary, root) {
  if (process.platform !== 'linux') return;
  const sandbox = electronSandboxStatus(electronBinary);
  if (!sandbox.ok) {
    console.warn(`\n[personal-agent] Electron sandbox may fail to start: ${sandbox.reason}.`);
    console.warn('The renderer sandbox stays enabled by design. Fix it once with ONE of:');
    for (const remedy of sandbox.remedies) console.warn('\n' + remedy);
    if (sandbox.nosuid)
      console.warn(
        `\n(${sandbox.mountPoint} is mounted nosuid, so the setuid helper cannot work there; use the AppArmor profile or move node_modules to a suid-capable disk.)`,
      );
    console.warn('');
  }
  const display = displayStatus();
  if (!display.ok)
    console.warn(
      '[personal-agent] No DISPLAY/WAYLAND_DISPLAY: start from a desktop session, or use `pnpm setup:headless` (Debian x64) for Xvfb smokes.',
    );
  const fs = projectFilesystemStatus(root);
  if (!fs.ok)
    console.warn(
      `[personal-agent] Project is on ${fs.type} (${fs.mountPoint}); symlinks/permissions are unreliable there. Prefer an ext4/btrfs/xfs location.`,
    );
  else if (fs.warn)
    console.warn(
      `[personal-agent] Project is on ${fs.type} (${fs.mountPoint}); it works but installs/builds are slower than on ext4.`,
    );
}
