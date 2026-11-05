import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { LedgerError } from '../../store/src/ledger.ts';

/** Official npm 1.1.0 bytes, independently verified against registry SHA-512. */
export const terminalBindingBaseline = {
  version: '1.1.0',
  platform: 'darwin',
  arch: 'arm64',
  helperSha256: '21c589109bca43e287df884f3c34ab888033a83927ea7d273949ac5030583f26',
  bindingSha256: 'e6457d66f45af3facd02920a5b212164e80fe0bb758afe6e6eab1eceeba3fc9a',
} as const;

/**
 * Linux has no upstream prebuilt node-pty 1.1.0 binding: `pnpm install` compiles
 * build/Release/pty.node locally. There is no upstream hash to pin, so
 * `pnpm setup:terminal` records the locally built bytes (trust on first use) and
 * every start re-checks them. A rebuild (new Node ABI, reinstall) requires re-running setup.
 */
export interface LocalTerminalBindingRecord {
  version: string;
  platform: string;
  arch: string;
  binding: string;
  bindingSha256: string;
  nodeModulesAbi: string;
  recordedAt: string;
}
export const linuxTerminalPlatforms = new Set(['linux-x64', 'linux-arm64']);
export const defaultTerminalBindingRecord = () => resolve('.local/terminal-binding.json');

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function regularFile(path: string) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink()) throw new LedgerError('TERMINAL_BINDING_CHANGED');
  return s;
}

/** node-pty's own loader order on Linux: build/Release, build/Debug, prebuilds/<platform>-<arch>. */
export function linuxBindingCandidates(
  packageRoot: string,
  platform = process.platform,
  arch = process.arch,
): string[] {
  return [
    join(packageRoot, 'build/Release/pty.node'),
    join(packageRoot, 'build/Debug/pty.node'),
    join(packageRoot, `prebuilds/${platform}-${arch}/pty.node`),
  ];
}

function nodePtyRoot() {
  const require = createRequire(import.meta.url);
  let packageFile: string;
  try {
    packageFile = require.resolve('node-pty/package.json');
  } catch {
    throw new LedgerError('TERMINAL_BINDING_MISSING');
  }
  if (JSON.parse(readFileSync(packageFile, 'utf8')).version !== terminalBindingBaseline.version)
    throw new LedgerError('TERMINAL_BINDING_VERSION_MISMATCH');
  return { require, root: dirname(packageFile) };
}

export function terminalBinding(recordFile: string = defaultTerminalBindingRecord()): string {
  const platform = `${process.platform}-${process.arch}`;
  if (platform === `${terminalBindingBaseline.platform}-${terminalBindingBaseline.arch}`) {
    const { require, root } = nodePtyRoot();
    for (const [name, expected] of [
      ['spawn-helper', terminalBindingBaseline.helperSha256],
      ['pty.node', terminalBindingBaseline.bindingSha256],
    ] as const) {
      const path = join(root, 'prebuilds/darwin-arm64', name),
        s = regularFile(path);
      if (sha256(path) !== expected) throw new LedgerError('TERMINAL_BINDING_CHANGED');
      if (name === 'spawn-helper' && !(s.mode & 0o111))
        throw new LedgerError('TERMINAL_HELPER_SETUP_REQUIRED');
    }
    return realpathSync(require.resolve('node-pty'));
  }
  if (linuxTerminalPlatforms.has(platform)) {
    const { require, root } = nodePtyRoot();
    if (!existsSync(recordFile)) throw new LedgerError('TERMINAL_HELPER_SETUP_REQUIRED');
    let record: LocalTerminalBindingRecord;
    try {
      record = JSON.parse(readFileSync(recordFile, 'utf8'));
    } catch {
      throw new LedgerError('TERMINAL_HELPER_SETUP_REQUIRED');
    }
    if (
      record.version !== terminalBindingBaseline.version ||
      `${record.platform}-${record.arch}` !== platform
    )
      throw new LedgerError('TERMINAL_HELPER_SETUP_REQUIRED');
    // The binding node-pty will actually load must be the recorded one.
    const loaded = linuxBindingCandidates(root).find((path) => existsSync(path));
    if (!loaded || realpathSync(loaded) !== record.binding)
      throw new LedgerError('TERMINAL_BINDING_CHANGED');
    regularFile(loaded);
    if (sha256(loaded) !== record.bindingSha256) throw new LedgerError('TERMINAL_BINDING_CHANGED');
    return realpathSync(require.resolve('node-pty'));
  }
  throw new LedgerError('TERMINAL_PLATFORM_NOT_VERIFIED');
}

/** True when the user terminal can start on this machine (used by tests and the doctor). */
export function terminalAvailable(recordFile?: string): boolean {
  try {
    terminalBinding(recordFile);
    return true;
  } catch {
    return false;
  }
}
