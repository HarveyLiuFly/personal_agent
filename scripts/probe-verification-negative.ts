import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { resolveVerifierNode } from '../packages/codex-adapter/src/launch.ts';
import { ExecutionLedger, LedgerError } from '../packages/store/src/ledger.ts';
import { NodeVerification } from '../packages/verification/src/verification.ts';
import { evidenceDir } from './lib/evidence.mjs';
const root = resolve(import.meta.dirname, '..'),
  binary = verifiedCodex(root),
  node = resolveVerifierNode(root);
const folder = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-verification-negative-')));
const results: Array<Record<string, unknown>> = [];
function fixture(testText?: string) {
  const state = join(folder, randomUUID()),
    cwd = join(state, 'workspace');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(cwd, 'src/math.mjs'), 'export const sum=(a,b)=>a-b;\n');
  writeFileSync(
    join(cwd, 'test/math.test.mjs'),
    testText ??
      "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {sum} from '../src/math.mjs';\ntest('fixed addition',()=>assert.equal(sum(2,3),5));\n",
  );
  const git = (args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
      stdio: 'ignore',
    });
  git(['init', '--quiet']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    'controlled verification probe',
  ]);
  const store = new ExecutionLedger(
    join(state, 'ledger.db'),
    readFileSync(join(root, 'docs/design/contracts/schema.sql'), 'utf8'),
  );
  store.startOwner(randomUUID(), true);
  const p = store.registerWorkspace(cwd),
    { token } = store.beginRun(
      p.id,
      'Verifier negative probe, no inference',
      randomUUID(),
      'workspaceWrite',
    );
  const service = new NodeVerification(store, {
    node,
    cli: binary.executable,
    reporter: join(root, 'packages/verification/src/reporter.mjs'),
    stateDirectory: join(state, 'verification'),
  });
  const prepare = (target = 'test/math.test.mjs') =>
    service.prepare(token, { profile: 'node-test', target, allowedPaths: ['src/math.mjs'] });
  const finish = () => {
    const a = store.prepare(token, 'thread', 'thread_start', {});
    store.sending(token, a.intentId, 1);
    store.accepted(token, a.intentId, { threadId: 'synthetic-thread' });
    const b = store.prepare(token, 'turn', 'turn_start', {}, 'synthetic-thread');
    store.sending(token, b.intentId, 1);
    store.accepted(token, b.intentId, { turnId: 'synthetic-turn' });
    store.finish(token, 'completed');
  };
  return { cwd, store, p, token, service, prepare, finish };
}
let failed = false;
try {
  for (const [name, source, target] of [
    ['zero_baseline', '// no named tests\n', 'test/math.test.mjs'],
    [
      'all_skipped_baseline',
      "import {test} from 'node:test';test.skip('not executed',()=>{});\n",
      'test/math.test.mjs',
    ],
    ['wrong_target', '// proper target unused\n', 'package.json'],
  ] as const) {
    const f = fixture(source);
    try {
      await assert.rejects(f.prepare(target), /BASELINE_TEST_EXECUTION_REQUIRED/);
      results.push({
        name,
        status: 'passed',
        expectedCode: 'BASELINE_TEST_EXECUTION_REQUIRED',
        modelRequests: 0,
      });
    } finally {
      f.store.close();
    }
  }
  for (const [name, change, expected] of [
    ['zero_final', 'export const sum=()=>0;process.exit(0);\n', 'REQUIRED_CASES_NOT_EXECUTED'],
    ['failing_final', 'export const sum=(a,b)=>a-b-1;\n', 'TESTS_FAILED'],
    ['modified_tests', 'export const sum=(a,b)=>a+b;\n', 'TEST_MODIFIED'],
  ] as const) {
    const f = fixture();
    try {
      await f.prepare();
      writeFileSync(join(f.cwd, 'src/math.mjs'), change);
      if (name === 'modified_tests')
        writeFileSync(join(f.cwd, 'test/math.test.mjs'), '// erased tests\n');
      f.finish();
      const receipt = await f.service.verify(f.p.id, f.token.runId);
      assert.equal(receipt.code, expected);
      assert.equal(receipt.status, 'failed');
      assert.equal(f.store.runForHost(f.token.runId).taskStatus, 'needs_review');
      results.push({
        name,
        status: 'passed',
        receiptCode: receipt.code,
        discovered: receipt.discovered,
        executed: receipt.executed,
        exitCode: receipt.exitCode,
        taskStatus: 'needs_review',
      });
    } finally {
      f.store.close();
    }
  }
  const sentinel = join(folder, 'external-sentinel');
  writeFileSync(sentinel, 'public synthetic sentinel');
  const f = fixture(`import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {sum} from '../src/math.mjs';
test('workspace is read only',()=>assert.throws(()=>writeFileSync('forbidden-write','x')));
test('external sentinel unreadable',()=>assert.throws(()=>readFileSync(${JSON.stringify(sentinel)})));
test('fixed addition',()=>assert.equal(sum(2,3),5));
`);
  try {
    await f.prepare();
    writeFileSync(join(f.cwd, 'src/math.mjs'), 'export const sum=(a,b)=>a+b;\n');
    f.finish();
    const receipt = await f.service.verify(f.p.id, f.token.runId);
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.executed, 3);
    results.push({
      name: 'native_sandbox_permissions',
      status: 'passed',
      executed: receipt.executed,
      workspaceWriteDenied: true,
      externalReadDenied: true,
    });
  } finally {
    f.store.close();
  }
} catch (error) {
  failed = true;
  results.push({
    name: 'probe_failure',
    status: 'failed',
    code: error instanceof LedgerError ? error.code : 'PROBE_ASSERTION_FAILED',
  });
}
const evidence = {
  status: failed ? 'blocked' : 'passed',
  observedAt: new Date().toISOString(),
  kind: 'real_native_sandbox_negative_verification',
  platform: binary.platform,
  cliVersion: binary.lock.cliVersion,
  inferenceRequested: false,
  modelMetadata: 'synthetic_only',
  results,
};
const file = join(evidenceDir(root), 'M1.3b-native-verifier-negative.json');
writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(
  file.replace('.json', `-${evidence.observedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
if (failed) process.exitCode = 1;
