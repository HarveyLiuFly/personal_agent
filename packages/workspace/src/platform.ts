import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { LedgerError } from '../../store/src/ledger.ts';

/**
 * Platform-specific choices for user-origin tools (terminal shell, git).
 * Keep every OS branch here so services stay platform-neutral.
 */

export interface TerminalShell {
  /** Absolute shell executable. */
  path: string;
  /** Arguments that start an interactive shell without user rc files. */
  args: string[];
  /** Shell-specific prompt variables; merged into the restricted terminal environment. */
  env: Record<string, string>;
}

type Exists = (path: string) => boolean;
const isExecutableFile: Exists = path => {
  try { return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0; } catch { return false; }
};

/**
 * macOS keeps the reviewed `/bin/zsh -f -i`. Linux distributions often ship without zsh,
 * so prefer bash (no profile/rc, mirroring `zsh -f`) and fall back to POSIX sh.
 */
export function terminalShell(platform: NodeJS.Platform = process.platform, exists: Exists = isExecutableFile): TerminalShell {
  if (platform === 'darwin') return { path: '/bin/zsh', args: ['-f', '-i'], env: { SHELL: '/bin/zsh', PROMPT: '%# ', RPROMPT: '' } };
  for (const path of ['/bin/bash', '/usr/bin/bash']) {
    if (exists(path)) return { path, args: ['--noprofile', '--norc', '-i'], env: { SHELL: path, PS1: '\\$ ' } };
  }
  if (exists('/bin/sh')) return { path: '/bin/sh', args: ['-i'], env: { SHELL: '/bin/sh', PS1: '$ ' } };
  throw new LedgerError('TERMINAL_SHELL_UNAVAILABLE');
}

/** System directories searched for user tools; never the project or a user-writable PATH entry first. */
export function systemToolPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/usr/bin:/bin:/usr/sbin:/sbin' : '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin';
}

/**
 * Resolve the git executable used for read-only workspace inspection.
 * macOS: the Xcode/CLT git via xcrun. Linux: the first system git, then PATH as a fallback.
 */
export function resolveSystemGit(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: Exists = isExecutableFile): string {
  if (platform === 'darwin') {
    return realpathSync(execFileSync('/usr/bin/xcrun', ['--find', 'git'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: env.HOME },
    }).trim());
  }
  const system = systemToolPath(platform).split(':').map(directory => join(directory, 'git'));
  const fromPath = (env.PATH ?? '').split(delimiter).filter(directory => directory && isAbsolute(directory)).map(directory => join(directory, 'git'));
  for (const candidate of [...system, ...fromPath]) {
    if (exists(candidate)) return realpathSync(candidate);
  }
  throw new LedgerError('WORKSPACE_GIT_UNAVAILABLE');
}
