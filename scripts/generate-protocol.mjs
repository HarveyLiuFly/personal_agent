import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { delimiter, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'packages/codex-adapter/src/generated');
const lockPath = resolve(root, 'codex-version.lock.json');
const baseline = JSON.parse(readFileSync(resolve(root, 'docs/design/contracts/protocol-capabilities.json'), 'utf8'));
const executable = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => resolve(dir, 'codex')).find(path => {
  try { return statSync(path).isFile(); } catch { return false; }
});
if (!executable) throw new Error('Codex executable not found.');
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const executableSha256 = digest(readFileSync(executable));
if (version !== baseline.cli_version || executableSha256 !== baseline.executable_sha256) {
  throw new Error('Codex binary differs from reviewed baseline; verify compatibility before updating the lock.');
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
  }).sort();
}
if (!process.argv.includes('--verify')) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  execFileSync(executable, ['app-server', 'generate-ts', '--out', output], { stdio: ['ignore', 'ignore', 'ignore'] });
}
const generatedFiles = files(output);
const fingerprint = digest(generatedFiles.map(path => `${relative(output, path)}\0${digest(readFileSync(path))}\n`).join(''));
const lock = { cliVersion: version, executableSha256, sourceCommit: null, generationMode: 'stable',
  generatedTypes: generatedFiles.length, schemaFingerprint: fingerprint };
if (process.argv.includes('--verify')) {
  const expected = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (JSON.stringify(lock) !== JSON.stringify(expected)) throw new Error('Protocol fingerprint or executable changed.');
  console.log(`Verified ${generatedFiles.length} generated types against ${version}.`);
} else {
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  console.log(`Generated ${generatedFiles.length} types and recorded the binary/schema fingerprints.`);
}
