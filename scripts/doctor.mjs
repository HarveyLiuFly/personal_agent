// `pnpm diagnose`: read-only environment report for this machine. No model requests,
// no writes outside a temporary directory, no credential access.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayStatus, electronSandboxStatus, projectFilesystemStatus } from './linux-preflight.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const rows = [];
const report = (status, name, detail, hint) => rows.push({ status, name, detail, hint });
const pass = (n, d) => report('ok', n, d), warn = (n, d, h) => report('warn', n, d, h), fail = (n, d, h) => report('fail', n, d, h);
const code = error => (error instanceof Error ? (error.code && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : error.message) : String(error)).slice(0, 200);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

const platform = `${process.platform}-${process.arch}`;
pass('Platform', `${platform}${process.platform === 'linux' ? ' · ' + (readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] ?? 'Linux') : ''}`);

const [major, minor] = process.versions.node.split('.').map(Number);
if (major === 24 && minor >= 19) pass('Node', process.version);
else fail('Node', process.version, 'Use Node 24.19+ (<25), e.g. `nvm install 24`.');

if (!existsSync(join(root, 'node_modules'))) fail('Dependencies', 'node_modules missing', 'Run `pnpm install --frozen-lockfile`.');
else pass('Dependencies', 'node_modules present');

let electronBinary;
try {
  electronBinary = require('electron');
  if (typeof electronBinary === 'string' && existsSync(electronBinary)) pass('Electron', electronBinary);
  else { fail('Electron', 'runtime not downloaded', 'Run `pnpm exec install-electron`.'); electronBinary = undefined; }
} catch (error) { fail('Electron', code(error), 'Run `pnpm install` then `pnpm exec install-electron`.'); }

if (process.platform === 'linux') {
  if (electronBinary) {
    const s = electronSandboxStatus(electronBinary);
    if (s.ok) pass('Electron sandbox', s.mode === 'setuid-helper' ? 'setuid chrome-sandbox' : `user namespaces${s.profile ? ' (AppArmor profile ' + s.profile + ')' : ''}`);
    else fail('Electron sandbox', s.reason, s.remedies.join('\n   or\n'));
  }
  const d = displayStatus();
  if (d.ok) pass('Display', `${d.kind} ${d.value}`); else warn('Display', 'no DISPLAY / WAYLAND_DISPLAY', 'Run from a desktop session; headless smokes use `pnpm setup:headless` (Debian x64 only).');
  const fs = projectFilesystemStatus(root);
  if (fs.ok && fs.warn) warn('Project filesystem', `${fs.type} at ${fs.mountPoint}`, 'Works, but node_modules installs and builds are slower than on ext4/btrfs/xfs.');
  else if (fs.ok) pass('Project filesystem', `${fs.type} at ${fs.mountPoint}`);
  else fail('Project filesystem', `${fs.type} at ${fs.mountPoint}`, 'Move the checkout to ext4/btrfs/xfs; symlinks and modes are required.');
}

// Codex CLI: same lookup and pin check as the Host (packages/codex-adapter/src/binary.ts).
let codexExecutable;
try {
  const { resolveCodexNative } = await import('../packages/codex-adapter/src/binary.ts');
  const lock = JSON.parse(readFileSync(join(root, 'codex-version.lock.json'), 'utf8'));
  const local = join(root, '.local/codex-install/node_modules/@openai/codex/bin/codex.js');
  const entry = process.env.PERSONAL_AGENT_CODEX_PATH ?? (existsSync(local) ? local
    : (process.env.PATH ?? '').split(':').filter(Boolean).map(d => join(d, 'codex')).find(p => existsSync(p)));
  if (!entry) fail('Codex CLI', 'not found', 'Install the pinned CLI locally: npm install --prefix .local/codex-install --no-audit --no-fund --save-exact @openai/codex@0.163.0');
  else {
    const native = resolveCodexNative(entry, platform);
    const hash = sha256(native);
    const version = spawnSync(native, ['--version'], { encoding: 'utf8', timeout: 10_000 }).stdout?.trim();
    const pin = lock.platforms[platform];
    if (!pin) fail('Codex CLI', `${version} · ${native}`, `No reviewed pin for ${platform} in codex-version.lock.json. Add one only after comparing the generated schema (see docs/progress/LINUX_PLATFORM.md).`);
    else if (version !== lock.cliVersion) fail('Codex CLI', `${version} (locked ${lock.cliVersion})`, 'Install the locked version into .local/codex-install (see README).');
    else if (hash !== pin.executableSha256) fail('Codex CLI', `${version} hash ${hash.slice(0, 16)}… ≠ pinned ${pin.executableSha256.slice(0, 16)}…`, `Binary at ${native} differs from the reviewed ${platform} baseline. Follow docs/progress/LINUX_PLATFORM.md §3 to establish a local baseline; do not just replace the hash.`);
    else { pass('Codex CLI', `${version} · pinned hash matches`); codexExecutable = native; }
    const login = spawnSync(native, ['login', 'status'], { encoding: 'utf8', timeout: 10_000 });
    // The CLI may print setup warnings first; report the status line itself.
    const loginLine = `${login.stdout}\n${login.stderr}`.split('\n').map(line => line.trim()).find(line => line && !/^WARNING\b/.test(line));
    if (login.status === 0) pass('Codex login', loginLine ?? 'ok');
    else warn('Codex login', 'not logged in or status unavailable', 'Run `codex login` with your supported account.');
  }
} catch (error) { fail('Codex CLI', code(error)); }

let verifierNode;
try {
  const { resolveVerifierNode } = await import('../packages/codex-adapter/src/launch.ts');
  verifierNode = resolveVerifierNode(root);
  pass('Verifier Node', verifierNode);
} catch (error) { fail('Verifier Node', code(error), 'Code tasks, terminal and workspace browsing need Node 24.19+ on PATH (or .local/node-v24.19.0-<platform>/bin/node).'); }

try {
  const { resolveSystemGit } = await import('../packages/workspace/src/platform.ts');
  pass('git', resolveSystemGit());
} catch (error) { fail('git', code(error), 'Install git (e.g. `sudo apt install git`).'); }

try {
  const { terminalBinding } = await import('../packages/workspace/src/terminal-binding.ts');
  const { terminalShell } = await import('../packages/workspace/src/platform.ts');
  const module = terminalBinding(join(root, '.local/terminal-binding.json'));
  const shell = terminalShell();
  if (verifierNode) {
    const probe = spawnSync(verifierNode, ['-e', `require(${JSON.stringify(module)})`], { encoding: 'utf8', timeout: 10_000 });
    if (probe.status === 0) pass('Terminal (node-pty)', `loads under verifier Node · shell ${shell.path} ${shell.args.join(' ')}`);
    else fail('Terminal (node-pty)', 'binding does not load under the verifier Node (ABI mismatch?)', 'Run `pnpm rebuild node-pty && pnpm setup:terminal` using the same Node 24 that is on PATH.');
  } else warn('Terminal (node-pty)', 'binding verified; verifier Node missing');
} catch (error) {
  const reason = code(error);
  fail('Terminal (node-pty)', reason, reason === 'TERMINAL_HELPER_SETUP_REQUIRED' || reason === 'TERMINAL_BINDING_CHANGED'
    ? 'Install build tools (python3, make, g++), then `pnpm rebuild node-pty && pnpm setup:terminal`.'
    : reason === 'TERMINAL_BINDING_MISSING' ? 'Run `pnpm install --frozen-lockfile` (node-pty compiles on Linux; needs python3, make, g++).' : undefined);
}

// Same sandbox invocation the code verifier uses, running a no-op Node script.
if (codexExecutable && verifierNode) {
  const scratchRoot = mkdtempSync(join(realpathSync(tmpdir()), 'personal-agent-doctor-'));
  try {
    const home = join(scratchRoot, 'home'), scratch = join(scratchRoot, 'scratch'), cwd = join(scratchRoot, 'project');
    for (const d of [home, scratch, cwd]) mkdirSync(d, { mode: 0o700 });
    writeFileSync(join(cwd, 'probe.mjs'), 'process.exit(0)\n');
    const readRoots = [dirname(dirname(verifierNode))];
    if (process.platform === 'linux' && existsSync('/etc/ssl')) readRoots.push(realpathSync('/etc/ssl'));
    writeFileSync(join(home, 'config.toml'), '[permissions.personal-agent-verifier]\nextends=":read-only"\n[permissions.personal-agent-verifier.filesystem]\n":root"="deny"\n":minimal"="read"\n'
      + readRoots.map(p => `${JSON.stringify(p)}="read"\n`).join('') + `${JSON.stringify(scratch)}="write"\n[permissions.personal-agent-verifier.filesystem.":workspace_roots"]\n"."="read"\n[permissions.personal-agent-verifier.network]\nenabled=false\n`, { mode: 0o600 });
    const result = spawnSync(codexExecutable, ['sandbox', '--include-managed-config', '--permission-profile', 'personal-agent-verifier', '-C', cwd, '--', verifierNode, 'probe.mjs'],
      { cwd, encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: scratch, LANG: 'C.UTF-8', TZ: 'UTC' } });
    if (result.status === 0) pass('Codex sandbox', 'verifier profile runs Node inside the Codex sandbox');
    else {
      const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
      const noUserns = /create new namespace|unprivileged user namespaces/i.test(output);
      const bundledBwrap = join(dirname(dirname(codexExecutable)), 'codex-resources', 'bwrap');
      fail('Codex sandbox', `exit ${result.status ?? result.signal}: ${output.trim().split('\n').filter(line => !/^WARNING\b/.test(line)).slice(-1)[0]?.slice(0, 160) ?? ''}`,
        noUserns
          ? `Codex runs commands through its bundled bubblewrap (${bundledBwrap}), which needs unprivileged user namespaces. `
            + 'Inside a container or another sandbox they are usually unavailable: run `pnpm diagnose` on the host. '
            + 'On the host check `sysctl user.max_user_namespaces` (>0) and, on Ubuntu 23.10+, allow that bwrap path the same way as Electron (AppArmor `userns` profile).'
          : 'On Linux the Codex sandbox needs bubblewrap with user namespaces plus Landlock/seccomp (kernel ≥ 5.13). Code verification and workspace browsing stay disabled until this passes.');
    }
  } finally { rmSync(scratchRoot, { recursive: true, force: true }); }
} else warn('Codex sandbox', 'skipped (needs pinned Codex CLI and verifier Node)');

const icon = { ok: '✓', warn: '!', fail: '✗' };
const width = Math.max(...rows.map(r => r.name.length));
for (const r of rows) {
  console.log(`${icon[r.status]} ${r.name.padEnd(width)}  ${r.detail}`);
  if (r.hint) console.log('   ' + r.hint.split('\n').join('\n   '));
}
const failed = rows.filter(r => r.status === 'fail').length;
console.log(failed ? `\n${failed} check(s) need attention.` : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
