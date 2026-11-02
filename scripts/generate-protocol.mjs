import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'packages/codex-adapter/src/generated');
const lockPath = resolve(root, 'codex-version.lock.json');
const baseline = JSON.parse(readFileSync(resolve(root, 'docs/design/contracts/protocol-capabilities.json'), 'utf8'));
const { executable, lock, platform } = verifiedCodex(root);
if (lock.cliVersion !== baseline.cli_version) throw new Error('CODEX_MATRIX_VERSION_MISMATCH');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
  }).sort();
}
function fingerprint(directory) {
  const paths = files(directory);
  return { generatedTypes: paths.length, schemaFingerprint: digest(paths.map(path =>
    `${relative(directory, path).split(sep).join('/')}\0${digest(readFileSync(path))}\n`).join('')) };
}
// Verify the actual platform binary's schema, not just already-checked-in files.
const temporary = mkdtempSync(join(tmpdir(), 'personal-agent-protocol-'));
try {
  execFileSync(executable, ['app-server', 'generate-ts', '--out', temporary], {
    timeout: 30_000, stdio: ['ignore', 'ignore', 'ignore'] });
  const generated = fingerprint(temporary);
  if (process.argv.includes('--verify')) {
    for (const current of [generated, fingerprint(output)]) {
      if (current.generatedTypes !== lock.generatedTypes || current.schemaFingerprint !== lock.schemaFingerprint) {
        throw new Error('CODEX_PROTOCOL_FINGERPRINT_MISMATCH');
      }
    }
    console.log(`Verified ${generated.generatedTypes} generated types from ${lock.cliVersion} (${platform}) against pinned schema and repository.`);
  } else {
    rmSync(output, { recursive: true, force: true });
    cpSync(temporary, output, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ ...lock, ...generated }, null, 2) + '\n');
    console.log(`Generated ${generated.generatedTypes} types; retained all reviewed platform pins.`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
