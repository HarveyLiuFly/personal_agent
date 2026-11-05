import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  terminalShell,
  resolveSystemGit,
  systemToolPath,
} from '../packages/workspace/src/platform.ts';
import {
  linuxBindingCandidates,
  terminalBinding,
} from '../packages/workspace/src/terminal-binding.ts';
import {
  hostPlatform,
  shortcutLabel,
  fileManagerLabel,
} from '../apps/desktop/renderer/platform.ts';
import {
  mountFor,
  electronSandboxStatus,
  displayStatus,
  projectFilesystemStatus,
} from '../scripts/linux-preflight.mjs';
import {
  gitSupportsWorktreeListZ,
  parseWorktreeList,
} from '../packages/workspace/src/worktrees.ts';

const only =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

test('terminal shell keeps reviewed zsh on macOS and uses rc-free bash or sh on Linux', () => {
  assert.deepEqual(
    terminalShell('darwin', () => false),
    {
      path: '/bin/zsh',
      args: ['-f', '-i'],
      env: { SHELL: '/bin/zsh', PROMPT: '%# ', RPROMPT: '' },
    },
  );
  const bash = terminalShell('linux', only('/bin/bash', '/bin/sh'));
  assert.equal(bash.path, '/bin/bash');
  assert.deepEqual(bash.args, ['--noprofile', '--norc', '-i']);
  assert.equal(bash.env.SHELL, '/bin/bash');
  assert.equal(terminalShell('linux', only('/usr/bin/bash')).path, '/usr/bin/bash');
  const sh = terminalShell('linux', only('/bin/sh'));
  assert.equal(sh.path, '/bin/sh');
  assert.deepEqual(sh.args, ['-i']);
  assert.throws(() => terminalShell('linux', () => false), /TERMINAL_SHELL_UNAVAILABLE/);
});

test('Linux git resolution prefers system directories, accepts absolute PATH entries only, and fails closed', () => {
  const t = mkdtempSync(join(tmpdir(), 'personal-agent-git-'));
  try {
    const custom = join(realpathSync(t), 'git');
    writeFileSync(custom, '');
    if (existsSync('/usr/bin/git'))
      assert.equal(
        resolveSystemGit('linux', { PATH: realpathSync(t) }, only('/usr/bin/git', custom)),
        realpathSync('/usr/bin/git'),
      );
    assert.equal(
      resolveSystemGit('linux', { PATH: `relative:${realpathSync(t)}` }, only(custom)),
      custom,
    );
    assert.throws(
      () => resolveSystemGit('linux', { PATH: 'relative' }, () => false),
      /WORKSPACE_GIT_UNAVAILABLE/,
    );
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
  assert.ok(systemToolPath('linux').startsWith('/usr/local/bin:/usr/bin:/bin'));
  assert.equal(systemToolPath('darwin'), '/usr/bin:/bin:/usr/sbin:/sbin');
});

test('node-pty binding lookup follows node-pty loader order and missing installs fail with a stable code', () => {
  assert.deepEqual(linuxBindingCandidates('/p', 'linux', 'x64'), [
    '/p/build/Release/pty.node',
    '/p/build/Debug/pty.node',
    '/p/prebuilds/linux-x64/pty.node',
  ]);
  if (process.platform === 'linux') {
    let installed = true;
    try {
      import.meta.resolve('node-pty');
    } catch {
      installed = false;
    }
    const missing = join(tmpdir(), 'personal-agent-no-record.json');
    assert.throws(
      () => terminalBinding(missing),
      installed
        ? /TERMINAL_HELPER_SETUP_REQUIRED|TERMINAL_BINDING_VERSION_MISMATCH/
        : /TERMINAL_BINDING_MISSING/,
    );
  }
});

test('terminal worker spawns exactly the shell chosen by the Host and rejects relative shells', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-worker-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'cwd');
  mkdirSync(cwd);
  const log = join(root, 'spawn.json');
  const fake = join(root, 'fake-pty.cjs');
  writeFileSync(
    fake,
    `exports.spawn=(file,args,opts)=>{require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify({file,args,cwd:opts.cwd,shell:opts.env.SHELL}));const t={pid:process.pid,onData(){},onExit(cb){t.exit=cb;},write(){},resize(){},pause(){},resume(){},kill(){t.exit({exitCode:0,signal:0});}};return t;};`,
  );
  const s = lstatSync(cwd, { bigint: true }),
    identity = { device: String(s.dev), inode: String(s.ino) };
  async function run(shell: string) {
    const child = spawn(process.execPath, [resolve('packages/workspace/src/terminal-worker.mjs')], {
        stdio: ['pipe', 'pipe', 'ignore'],
      }),
      exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout }),
      seen: Array<Record<string, unknown>> = [];
    lines.on('line', (l) => seen.push(JSON.parse(l)));
    const nonce = 'n';
    child.stdin.write(
      JSON.stringify({
        kind: 'configure',
        nonce,
        module: fake,
        cwd,
        identity,
        cols: 80,
        rows: 24,
        shell,
        shellArgs: ['--noprofile', '--norc', '-i'],
        env: { SHELL: shell },
      }) + '\n',
    );
    const wait = async (kind: string) => {
      for (let i = 0; i < 200 && !seen.some((x) => x.kind === kind); i++)
        await new Promise((r) => setTimeout(r, 10));
      return seen.find((x) => x.kind === kind);
    };
    assert.ok(await wait('ready'));
    child.stdin.write(JSON.stringify({ kind: 'go', nonce }) + '\n');
    const outcome = await Promise.race([wait('started'), wait('error')]);
    child.stdin.write(JSON.stringify({ kind: 'stop', nonce }) + '\n');
    child.stdin.end();
    await exited;
    return outcome;
  }
  assert.equal((await run('/bin/bash'))?.kind, 'started');
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), {
    file: '/bin/bash',
    args: ['--noprofile', '--norc', '-i'],
    cwd,
    shell: '/bin/bash',
  });
  rmSync(log);
  assert.equal((await run('bash'))?.kind, 'error');
  assert.throws(() => readFileSync(log));
});

test('renderer labels follow the host platform', () => {
  assert.equal(hostPlatform('MacIntel'), 'mac');
  assert.equal(hostPlatform('Linux x86_64'), 'linux');
  assert.equal(hostPlatform('Win32'), 'windows');
  assert.equal(shortcutLabel('n', 'mac'), '⌘ N');
  assert.equal(shortcutLabel('k', 'linux'), 'Ctrl K');
  assert.equal(fileManagerLabel('mac'), 'Finder');
  assert.equal(fileManagerLabel('linux'), '文件管理器');
});

test('Linux preflight reads mounts and reports sandbox remedies without suggesting --no-sandbox', () => {
  const mounts =
    '/dev/sda1 / ext4 rw,relatime 0 0\n/dev/sdb1 /media/user/proj exfat rw,nosuid,nodev 0 0\n/dev/sdb2 /media/user/proj\\040two ext4 rw 0 0\n';
  assert.equal(mountFor('/media/user/proj/x/y', mounts)?.type, 'exfat');
  assert.equal(mountFor('/media/user/proj two/x', mounts)?.mountPoint, '/media/user/proj two');
  assert.equal(mountFor('/home/u', mounts)?.mountPoint, '/');
  const proc = (values: Record<string, string>) => (path: string) => values[path] ?? null;
  const blocked = electronSandboxStatus(
    '/nonexistent/electron',
    proc({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }),
  );
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.reason), /AppArmor/);
  assert.ok(blocked.remedies?.some((r) => r.includes('chmod 4755')));
  assert.ok(blocked.remedies?.some((r) => r.includes('userns,')));
  assert.ok(!JSON.stringify(blocked).includes('no-sandbox'));
  assert.equal(electronSandboxStatus('/nonexistent/electron', proc({})).ok, true);
  assert.equal(
    electronSandboxStatus(
      '/nonexistent/electron',
      proc({ '/proc/sys/kernel/unprivileged_userns_clone': '0' }),
    ).ok,
    false,
  );
  assert.deepEqual(displayStatus({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), {
    ok: true,
    kind: 'wayland',
    value: 'wayland-0',
  });
  assert.equal(displayStatus({}).ok, false);
  assert.equal(typeof projectFilesystemStatus(process.cwd()).ok, 'boolean');
});

test('worktree list uses -z on git 2.36+ and a strict newline parser on older git (Ubuntu 22.04 ships 2.34)', () => {
  assert.equal(gitSupportsWorktreeListZ('git version 2.34.1\n'), false);
  assert.equal(gitSupportsWorktreeListZ('git version 2.36.0'), true);
  assert.equal(gitSupportsWorktreeListZ('git version 2.50.1 (Apple Git-155)'), true);
  assert.equal(gitSupportsWorktreeListZ('git version 3.0.0'), true);
  assert.equal(gitSupportsWorktreeListZ(''), false);
  const head = 'HEAD ' + 'a'.repeat(40);
  const records = [
    ['worktree /repo', head, 'branch refs/heads/main'],
    ['worktree /trees/one', head, 'detached', 'locked moved disk'],
    [
      'worktree /trees/two',
      head,
      'branch refs/heads/x',
      'prunable gitdir file points to non-existent location',
    ],
  ];
  for (const nul of [true, false]) {
    const sep = nul ? '\0' : '\n',
      output = records.map((r) => r.join(sep) + sep).join(sep);
    assert.deepEqual(
      [...parseWorktreeList(output, nul)],
      [
        ['/repo', { locked: false }],
        ['/trees/one', { locked: true }],
        ['/trees/two', { locked: false }],
      ],
    );
  }
  // Old-git output with a line outside the porcelain grammar (e.g. a newline inside a path) fails closed.
  assert.throws(
    () => parseWorktreeList('worktree /a\nb\n' + head + '\n', false),
    /WORKTREE_GIT_OUTPUT_UNSUPPORTED/,
  );
  assert.throws(
    () => parseWorktreeList('worktree relative\n', false),
    /WORKTREE_GIT_OUTPUT_UNSUPPORTED/,
  );
});
