import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveCodexNative, verifyCodexBinary, verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import type { CodexLock } from '../packages/codex-adapter/src/binary.ts';

function npmFixture(optional: boolean, run: (entry: string, native: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'personal-agent-binary-'));
  try {
    const packageRoot = join(root, 'node_modules/@openai/codex');
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    const entry = join(packageRoot, 'bin/codex.js');
    writeFileSync(entry, 'throw new Error("wrapper must never execute");');
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
    const vendorRoot = optional ? join(root, 'node_modules/@openai/codex-darwin-arm64') : packageRoot;
    mkdirSync(vendorRoot, { recursive: true });
    if (optional) writeFileSync(join(vendorRoot, 'package.json'), JSON.stringify({ name: '@openai/codex-darwin-arm64' }));
    const native = join(vendorRoot, 'vendor/aarch64-apple-darwin/bin/codex');
    mkdirSync(join(vendorRoot, 'vendor/aarch64-apple-darwin/bin'), { recursive: true });
    writeFileSync(native, 'synthetic native bytes; never executed');
    run(entry, native, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('official npm optional package resolves native file without running wrapper', () => {
  npmFixture(true, (entry, native) => assert.equal(resolveCodexNative(entry, 'darwin-arm64'), realpathSync(native)));
});
test('legacy official npm vendor layout resolves the same target', () => {
  npmFixture(false, (entry, native) => assert.equal(resolveCodexNative(entry, 'darwin-arm64'), realpathSync(native)));
});
test('unrecognized wrappers and platform targets fail closed', () => {
  npmFixture(true, (entry, _native, root) => {
    assert.throws(() => resolveCodexNative(entry, 'unknown-x64'), /CODEX_WRAPPER_UNRECOGNIZED/);
    writeFileSync(join(root, 'node_modules/@openai/codex/package.json'), JSON.stringify({ name: 'untrusted', bin: { codex: 'bin/codex.js' } }));
    assert.throws(() => resolveCodexNative(entry, 'darwin-arm64'), /CODEX_WRAPPER_UNRECOGNIZED/);
  });
});
test('native PATH entries retain their real executable identity', () => {
  assert.equal(resolveCodexNative(process.execPath), realpathSync(process.execPath));
});
const platform = `${process.platform}-${process.arch}`;
function nodePin(): CodexLock {
  return { cliVersion: process.version, sourceCommit: null, generationMode: 'stable', generatedTypes: 0, schemaFingerprint: 'fixture',
    platforms: { [platform]: { executableSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
      source: 'test uses real Node --version, not a Codex compatibility claim', protocolEvidence: 'fixture' } } };
}
test('reviewed hash and version must both match before a binary is usable', () => {
  const lock = nodePin();
  verifyCodexBinary(process.execPath, lock);
  assert.throws(() => verifyCodexBinary(process.execPath, { ...lock, cliVersion: 'incorrect fixture version' }), /CODEX_VERSION_MISMATCH/);
  assert.throws(() => verifyCodexBinary(process.execPath, lock, 'unreviewed-platform'), /CODEX_PLATFORM_UNREVIEWED/);
});
test('a mismatched hash rejects an unexecutable fixture before launch', () => {
  npmFixture(true, (_entry, native) => {
    assert.throws(() => verifyCodexBinary(native, nodePin()), /CODEX_BINARY_MISMATCH/);
  });
});
test('configured old/mismatched binaries cannot fall through to a different candidate', () => {
  npmFixture(true, (_entry, _native, root) => {
    writeFileSync(join(root, 'codex-version.lock.json'), JSON.stringify(nodePin()));
    const previous = process.env.PERSONAL_AGENT_CODEX_PATH;
    process.env.PERSONAL_AGENT_CODEX_PATH = process.execPath;
    try {
      assert.equal(verifiedCodex(root).executable, realpathSync(process.execPath));
      const lock = nodePin(); lock.platforms[platform]!.executableSha256 = 'incorrect';
      writeFileSync(join(root, 'codex-version.lock.json'), JSON.stringify(lock));
      assert.throws(() => verifiedCodex(root), /CODEX_BINARY_MISMATCH/);
    } finally {
      if (previous === undefined) delete process.env.PERSONAL_AGENT_CODEX_PATH; else process.env.PERSONAL_AGENT_CODEX_PATH = previous;
    }
  });
});
