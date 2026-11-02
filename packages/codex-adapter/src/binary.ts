import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';

export interface BinaryPin {
  executableSha256: string;
  source: string;
  protocolEvidence: string;
}
export interface CodexLock {
  cliVersion: string;
  sourceCommit: string | null;
  generationMode: 'stable';
  generatedTypes: number;
  schemaFingerprint: string;
  platforms: Record<string, BinaryPin>;
}

const targets: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

/** Inspect the official npm layout without ever executing its JavaScript wrapper. */
export function resolveCodexNative(entry: string, platform = `${process.platform}-${process.arch}`): string {
  const file = realpathSync(entry);
  if (!file.endsWith('.js')) return file;
  const packageRoot = resolve(dirname(file), '..');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: string; bin?: { codex?: string } };
  const target = targets[platform];
  if (!target || manifest.name !== '@openai/codex' || manifest.bin?.codex !== 'bin/codex.js'
      || resolve(packageRoot, manifest.bin.codex) !== file) throw new Error('CODEX_WRAPPER_UNRECOGNIZED');
  const packageName = `@openai/codex-${platform}`;
  let vendor = join(packageRoot, 'vendor');
  try { vendor = join(dirname(createRequire(file).resolve(`${packageName}/package.json`)), 'vendor'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
  }
  return realpathSync(join(vendor, target, 'bin', platform.startsWith('win32-') ? 'codex.exe' : 'codex'));
}

/** Hash first, then run only the reviewed native executable for its version. */
export function verifyCodexBinary(executable: string, lock: CodexLock, platform = `${process.platform}-${process.arch}`): void {
  const pin = lock.platforms[platform];
  if (!pin) throw new Error('CODEX_PLATFORM_UNREVIEWED');
  const hash = createHash('sha256').update(readFileSync(executable)).digest('hex');
  if (hash !== pin.executableSha256) throw new Error('CODEX_BINARY_MISMATCH');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000,
    maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (version !== lock.cliVersion) throw new Error('CODEX_VERSION_MISMATCH');
}

export function verifiedCodex(root: string): { executable: string; lock: CodexLock; platform: string } {
  const lock = JSON.parse(readFileSync(join(root, 'codex-version.lock.json'), 'utf8')) as CodexLock;
  const platform = `${process.platform}-${process.arch}`;
  if (!lock.platforms[platform]) throw new Error('CODEX_PLATFORM_UNREVIEWED');
  const local = join(root, '.local/codex-install/node_modules/@openai/codex/bin/codex.js');
  const configured = process.env.PERSONAL_AGENT_CODEX_PATH;
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const entry = configured ?? (existsSync(local) ? local : (process.env.PATH ?? '').split(delimiter).filter(Boolean)
    .map(directory => join(directory, name)).find(path => { try { return statSync(path).isFile(); } catch { return false; } }));
  if (!entry) throw new Error('CODEX_EXECUTABLE_MISSING');
  const executable = resolveCodexNative(entry, platform);
  verifyCodexBinary(executable, lock, platform);
  return { executable, lock, platform };
}
