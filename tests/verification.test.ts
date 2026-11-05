import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  rmSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { NodeVerification, codeInput } from '../packages/verification/src/verification.ts';
import type { TestResult } from '../packages/verification/src/verification.ts';
async function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-verification-'))),
    cwd = join(root, 'workspace');
  mkdirSync(cwd);
  mkdirSync(join(cwd, 'src'));
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(cwd, 'src/math.mjs'), 'export const sum=(a,b)=>a-b;\n');
  writeFileSync(
    join(cwd, 'test/math.test.mjs'),
    "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {sum} from '../src/math.mjs';\ntest('adds positive integers',()=>assert.equal(sum(2,3),5));\n",
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
    'baseline',
  ]);
  const store = new ExecutionLedger(
    join(root, 'store.db'),
    readFileSync('docs/design/contracts/schema.sql', 'utf8'),
  );
  store.startOwner('verification-fixture', true);
  const p = store.registerWorkspace(cwd),
    { token } = store.beginRun(p.id, 'fix sum fixture', 'key', 'workspaceWrite');
  const command = join(root, 'synthetic-command'),
    reporter = join(root, 'reporter.mjs');
  writeFileSync(command, 'synthetic command identity; never executed');
  writeFileSync(reporter, readFileSync('packages/verification/src/reporter.mjs'));
  let calls = 0,
    override: TestResult | undefined;
  const runner = async (): Promise<TestResult> => {
    calls++;
    if (override) return override;
    const passed = readFileSync(join(cwd, 'src/math.mjs'), 'utf8').includes('a+b');
    return {
      exitCode: passed ? 0 : 1,
      timedOut: false,
      cases: [
        {
          name: 'adds positive integers',
          file: 'test/math.test.mjs',
          line: 4,
          column: 1,
          passed,
          skipped: false,
        },
      ],
    };
  };
  const service = new NodeVerification(store, {
    node: command,
    cli: command,
    reporter,
    stateDirectory: join(root, 'verification'),
    testRunner: runner,
  });
  const input = {
    profile: 'node-test',
    target: 'test/math.test.mjs',
    allowedPaths: ['src/math.mjs'],
  };
  await service.prepare(token, input);
  const finish = () => {
    const a = store.prepare(token, 'thread', 'thread_start', {});
    store.sending(token, a.intentId, 1);
    store.accepted(token, a.intentId, { threadId: 'thread' });
    const b = store.prepare(token, 'turn', 'turn_start', {}, 'thread');
    store.sending(token, b.intentId, 1);
    store.accepted(token, b.intentId, { turnId: 'turn' });
    store.finish(token, 'completed');
  };
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    cwd,
    store,
    p,
    token,
    service,
    input,
    finish,
    command,
    reporter,
    calls: () => calls,
    setResult: (r: TestResult) => {
      override = r;
    },
    fix: () => writeFileSync(join(cwd, 'src/math.mjs'), 'export const sum=(a,b)=>a+b;\n'),
  };
}
test('trusted verification ends review only after required cases pass and publishes a hash-bound receipt', async (t) => {
  const f = await fixture(t);
  f.fix();
  f.finish();
  assert.equal(f.store.runs(f.p.id)[0]!.taskStatus, 'needs_review');
  const receipt = await f.service.verify(f.p.id, f.token.runId);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.executed, 1);
  assert.equal(f.calls(), 2);
  assert.equal(f.store.runs(f.p.id)[0]!.taskStatus, 'completed');
  assert.deepEqual(f.service.result(f.p.id, f.token.runId), receipt);
  assert.ok(f.service.diff(f.p.id, f.token.runId).text.includes('a+b'));
});
test('tests that fail keep the task awaiting review, with real attempt identity rather than cached success', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.cwd, 'src/math.mjs'), 'export const sum=(a,b)=>a-b-1;\n');
  f.finish();
  const first = await f.service.verify(f.p.id, f.token.runId);
  assert.equal(first.code, 'TESTS_FAILED');
  assert.equal(f.store.runs(f.p.id)[0]!.taskStatus, 'needs_review');
  f.fix();
  const next = await f.service.verify(f.p.id, f.token.runId);
  assert.equal(next.status, 'passed');
  assert.notEqual(first.verificationId, next.verificationId);
  assert.equal(f.calls(), 3);
});
test('zero cases, all skipped cases, wrong targets and missing necessary cases cannot complete a task', async (t) => {
  for (const result of [
    { exitCode: 0, timedOut: false, cases: [] },
    {
      exitCode: 0,
      timedOut: false,
      cases: [
        {
          name: 'adds positive integers',
          file: 'test/math.test.mjs',
          line: 4,
          column: 1,
          passed: true,
          skipped: true,
        },
      ],
    },
    {
      exitCode: 0,
      timedOut: false,
      cases: [
        {
          name: 'adds positive integers',
          file: 'wrong-target.mjs',
          line: 4,
          column: 1,
          passed: true,
          skipped: false,
        },
      ],
    },
    {
      exitCode: 0,
      timedOut: false,
      cases: [
        {
          name: 'unrelated',
          file: 'test/math.test.mjs',
          line: 4,
          column: 1,
          passed: true,
          skipped: false,
        },
      ],
    },
  ]) {
    const f = await fixture(t);
    f.fix();
    f.finish();
    f.setResult(result);
    const receipt = await f.service.verify(f.p.id, f.token.runId);
    assert.equal(receipt.status, 'failed');
    assert.equal(f.store.runs(f.p.id)[0]!.taskStatus, 'needs_review');
  }
});
test('modified tests, changed verifiers and edits outside scope fail before running the new tests', async (t) => {
  for (const kind of ['tests', 'verifier', 'outside']) {
    const f = await fixture(t);
    f.fix();
    f.finish();
    if (kind === 'tests')
      writeFileSync(join(f.cwd, 'test/math.test.mjs'), '// zero tests, exit zero\n');
    if (kind === 'verifier') writeFileSync(f.reporter, 'fake reporter');
    if (kind === 'outside') writeFileSync(join(f.cwd, '.ignored-output'), 'unexpected');
    const receipt = await f.service.verify(f.p.id, f.token.runId);
    assert.equal(receipt.status, 'failed');
    assert.equal(f.calls(), 1);
  }
});
test('unknown model outcome and foreign runs cannot obtain a trusted completion claim', async (t) => {
  const f = await fixture(t);
  f.store.uncertain(f.token);
  await assert.rejects(f.service.verify(f.p.id, f.token.runId), /RUN_NOT_VERIFIABLE/);
  await assert.rejects(f.service.verify('foreign-project', f.token.runId), /UNKNOWN_PROJECT/);
  assert.equal(f.calls(), 1);
});
test('a receipt file altered after publication is rejected by its stored hash', async (t) => {
  const f = await fixture(t);
  f.fix();
  f.finish();
  const receipt = await f.service.verify(f.p.id, f.token.runId);
  writeFileSync(
    join(f.root, 'verification/artifacts', receipt.verificationId + '.json'),
    '{"status":"passed"}\n',
  );
  assert.throws(() => f.service.result(f.p.id, f.token.runId), /VERIFICATION_RECEIPT_CHANGED/);
});
test('profile paths reject traversal, test editing and arbitrary command fields', () => {
  for (const input of [
    { profile: 'shell', target: 'test.mjs', allowedPaths: ['src.mjs'] },
    { profile: 'node-test', target: '../escape', allowedPaths: ['src.mjs'] },
    { profile: 'node-test', target: 'test.mjs', allowedPaths: ['test.mjs'] },
    {
      profile: 'node-test',
      target: 'test.mjs',
      allowedPaths: ['src.mjs'],
      command: 'touch /tmp/x',
    },
  ])
    assert.throws(() => codeInput(input));
});
test('verification Git rejects included clean filters before any helper can execute', async (t) => {
  const f = await fixture(t),
    marker = join(f.root, 'helper-effect'),
    helper = join(f.root, 'helper.sh');
  writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  chmodSync(helper, 0o700);
  writeFileSync(join(f.cwd, '.git/filter-config'), `[filter "evil"]\nclean = ${helper}\n`);
  writeFileSync(join(f.cwd, '.git/info/attributes'), 'src/math.mjs filter=evil\n');
  execFileSync('git', ['-C', f.cwd, 'config', 'include.path', 'filter-config']);
  f.fix();
  assert.throws(() => f.service.diff(f.p.id, f.token.runId), /GIT_FILTERS_UNSUPPORTED/);
  assert.equal(existsSync(marker), false);
});
test('continuation inherits the original file/test/case contract and verifies accumulated allowed changes', async (t) => {
  const f = await fixture(t);
  f.finish();
  writeFileSync(join(f.cwd, 'src/math.mjs'), 'export const sum=(a,b)=>a-b-1;\n');
  const before = f.service.plan(f.p.id, f.token.runId)!;
  const next = f.store.beginContinuation(
    f.p.id,
    f.token.runId,
    'continue fixed synthetic task',
    'follow-up',
  );
  await f.service.prepareContinuation(next.token, f.token.runId);
  const after = f.service.plan(f.p.id, next.token.runId)!;
  for (const key of [
    'baselineCommit',
    'files',
    'testHash',
    'nodeHash',
    'reporterHash',
    'cliHash',
    'verifierHash',
    'requiredCases',
    'knownCases',
    'allowedPaths',
    'target',
  ] as const)
    assert.deepEqual(after[key], before[key]);
  assert.notEqual(before.specId, after.specId);
  assert.equal(after.runId, next.token.runId);
  const resume = f.store.prepare(next.token, 'resume', 'thread_resume', {}, 'thread');
  f.store.sending(next.token, resume.intentId, 2);
  f.store.accepted(next.token, resume.intentId, { threadId: 'thread' });
  const turn = f.store.prepare(next.token, 'next-turn', 'turn_start', {}, 'thread');
  f.store.sending(next.token, turn.intentId, 2);
  f.store.accepted(next.token, turn.intentId, { turnId: 'next-turn' });
  f.fix();
  f.store.finish(next.token, 'completed');
  const result = await f.service.verify(f.p.id, next.token.runId);
  assert.equal(result.status, 'passed');
  await assert.rejects(f.service.verify(f.p.id, f.token.runId), /RUN_NOT_VERIFIABLE/);
  assert.throws(
    () =>
      f.store.beginContinuation(f.p.id, next.token.runId, 'cannot reopen completed task', 'closed'),
    /RUN_NOT_CONTINUABLE/,
  );
});
test('continuation cannot silently accept changed tests or missing required cases as a weaker baseline', async (t) => {
  for (const kind of ['test_modified', 'case_missing']) {
    const f = await fixture(t);
    f.finish();
    const next = f.store.beginContinuation(f.p.id, f.token.runId, 'same contract', 'next');
    if (kind === 'test_modified')
      writeFileSync(join(f.cwd, 'test/math.test.mjs'), '// erased test\n');
    else f.setResult({ exitCode: 0, timedOut: false, cases: [] });
    await assert.rejects(
      f.service.prepareContinuation(next.token, f.token.runId),
      /TEST_MODIFIED|BASELINE_TEST_EXECUTION_REQUIRED/,
    );
    assert.equal(f.service.plan(f.p.id, next.token.runId), null);
  }
});
