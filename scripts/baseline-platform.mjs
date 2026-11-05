// Establish a reviewed Codex CLI pin for THIS platform (e.g. a local Linux machine).
// It never trusts a hash by itself: the candidate must report the locked CLI version and
// must regenerate exactly the locked protocol schema (all files, same fingerprint).
//
//   node scripts/baseline-platform.mjs            # dry run: compare and report only
//   node scripts/baseline-platform.mjs --write    # also record the pin + evidence
//
// Candidate lookup matches the Host: PERSONAL_AGENT_CODEX_PATH, then
// .local/codex-install (npm install --prefix .local/codex-install @openai/codex@<locked>), then PATH.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexNative } from '../packages/codex-adapter/src/binary.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'codex-version.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const write = process.argv.includes('--write');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = (directory) =>
  readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
    })
    .sort();
const fingerprint = (directory) => {
  const paths = files(directory);
  return {
    generatedTypes: paths.length,
    schemaFingerprint: digest(
      paths
        .map(
          (path) =>
            `${relative(directory, path).split(sep).join('/')}\0${digest(readFileSync(path))}\n`,
        )
        .join(''),
    ),
  };
};

const local = join(root, '.local/codex-install/node_modules/@openai/codex/bin/codex.js');
const entry =
  process.env.PERSONAL_AGENT_CODEX_PATH ??
  (existsSync(local)
    ? local
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((d) => join(d, 'codex'))
        .find((p) => existsSync(p)));
if (!entry)
  throw new Error(
    'CODEX_EXECUTABLE_MISSING: install with npm install --prefix .local/codex-install --no-audit --no-fund --save-exact @openai/codex@' +
      lock.cliVersion.replace(/^codex-cli /, ''),
  );
const executable = resolveCodexNative(entry, platform);
const executableSha256 = digest(readFileSync(executable));
const version = execFileSync(executable, ['--version'], {
  encoding: 'utf8',
  timeout: 10_000,
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
console.log(`Candidate ${version} (${platform})\n  ${executable}\n  sha256 ${executableSha256}`);
if (version !== lock.cliVersion)
  throw new Error(`CODEX_VERSION_MISMATCH: locked ${lock.cliVersion}`);

const existing = lock.platforms[platform];
if (existing?.executableSha256 === executableSha256) {
  console.log('Already pinned; nothing to do.');
  process.exit(0);
}
if (existing)
  console.log(
    `Existing ${platform} pin differs (${existing.executableSha256}); it came from: ${existing.source}`,
  );

const temporary = mkdtempSync(join(tmpdir(), 'personal-agent-baseline-'));
let generated;
try {
  execFileSync(executable, ['app-server', 'generate-ts', '--out', temporary], {
    timeout: 30_000,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  generated = fingerprint(temporary);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const repository = fingerprint(join(root, 'packages/codex-adapter/src/generated'));
const matches =
  generated.generatedTypes === lock.generatedTypes &&
  generated.schemaFingerprint === lock.schemaFingerprint &&
  repository.generatedTypes === lock.generatedTypes &&
  repository.schemaFingerprint === lock.schemaFingerprint;
console.log(
  `Schema: ${generated.generatedTypes} types, ${generated.schemaFingerprint}\nLocked: ${lock.generatedTypes} types, ${lock.schemaFingerprint}`,
);
if (!matches)
  throw new Error(
    'CODEX_PROTOCOL_FINGERPRINT_MISMATCH: this binary does not produce the locked protocol; do not pin it.',
  );

const evidencePath = `docs/progress/evidence/platform-baseline-${platform}.json`;
const source =
  existsSync(local) && entry === local
    ? `npm @openai/codex@${version.replace(/^codex-cli /, '')} (${platform} optional package) via .local/codex-install`
    : `local executable ${entry}`;
if (!write) {
  console.log(`\nSchema matches. Re-run with --write to pin ${platform} -> ${executableSha256}.`);
  process.exit(0);
}
lock.platforms[platform] = { executableSha256, source, protocolEvidence: evidencePath };
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
mkdirSync(join(root, 'docs/progress/evidence'), { recursive: true });
writeFileSync(
  join(root, evidencePath),
  JSON.stringify(
    {
      kind: 'platform_codex_baseline',
      platform,
      cliVersion: version,
      executableSha256,
      previousSha256: existing?.executableSha256 ?? null,
      source,
      generatedTypes: generated.generatedTypes,
      schemaFingerprint: generated.schemaFingerprint,
      repositoryMatches: true,
      inferenceRequested: false,
      observedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
console.log(`Pinned ${platform}. Evidence: ${evidencePath}`);
