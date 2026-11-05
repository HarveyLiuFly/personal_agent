import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import type { RunToken } from '../packages/store/src/ledger.ts';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import {
  CHECK_PRESETS,
  ProjectCheckService,
  ProjectCheckStore,
  parseCommandLine,
  runProjectCheck,
} from '../packages/verification/src/project-checks.ts';
import type { CheckResult } from '../packages/verification/src/project-checks.ts';

const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
function temporary(t: { after(fn: () => void): void }, onDisk = false) {
  // The Linux sandbox mounts its own /dev, so a sandboxed check cannot see /dev/shm directories.
  const base = onDisk ? resolve('.local') : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = realpathSync(mkdtempSync(join(base, 'personal-agent-checks-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a typed check command becomes arguments without a shell', () => {
  assert.deepEqual(parseCommandLine('python3 -m pytest -k "slow and not db"'), [
    'python3',
    '-m',
    'pytest',
    '-k',
    'slow and not db',
  ]);
  assert.deepEqual(parseCommandLine("go test './...'"), ['go', 'test', './...']);
  for (const line of ['npm test && rm -rf /', 'pytest | tee out', 'echo $HOME', 'make > log', ''])
    assert.throws(
      () => parseCommandLine(line),
      /CHECK_COMMAND_NEEDS_NO_SHELL|INVALID_CHECK_COMMAND/,
    );
  assert.throws(() => parseCommandLine('pytest "unclosed'), /INVALID_CHECK_COMMAND/);
  assert.ok(CHECK_PRESETS.some((preset) => preset.id === 'pytest'));
});

test('check settings are kept per project in a private file', (t) => {
  const file = join(temporary(t), 'settings', 'project-checks.json');
  const store = new ProjectCheckStore(file);
  assert.equal(store.get('p1'), null);
  store.set('p1', { argv: ['pnpm', 'test'], label: 'pnpm test', autoRun: true });
  store.set('p2', { argv: ['go', 'test', './...'], label: '', autoRun: false });
  assert.deepEqual(new ProjectCheckStore(file).get('p1'), {
    argv: ['pnpm', 'test'],
    label: 'pnpm test',
    autoRun: true,
  });
  assert.equal(new ProjectCheckStore(file).get('p2')!.label, 'go test ./...');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  store.set('p1', null);
  assert.equal(store.get('p1'), null);
  assert.ok(store.get('p2'));
  assert.throws(
    () => store.set('p3', { argv: [], label: 'x', autoRun: false }),
    /INVALID_CHECK_COMMAND/,
  );
});

let cli: string | undefined;
try {
  cli = verifiedCodex(resolve('.')).executable;
} catch {
  cli = undefined;
}
test(
  'the check runs in the Codex sandbox: workspace writable, nothing else, no network',
  { skip: !cli || process.platform === 'win32' ? 'pinned Codex not installed here' : false },
  async (t) => {
    const root = temporary(t, true),
      cwd = join(root, 'project'),
      state = join(root, 'state');
    mkdirSync(cwd);
    const run = (argv: string[], timeoutMs?: number) =>
      runProjectCheck({
        cli: cli!,
        cwd,
        argv,
        stateDirectory: state,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    const passed = await run([
      'sh',
      '-c',
      'echo ran > result.txt; echo hello; echo oops >&2; touch "$TMPDIR/scratch-ok"',
    ]);
    assert.equal(passed.status, 'passed');
    assert.equal(passed.exitCode, 0);
    assert.match(passed.output, /hello/);
    assert.match(passed.output, /oops/, 'stderr is kept too');
    assert.equal(readFileSync(join(cwd, 'result.txt'), 'utf8'), 'ran\n');
    const failed = await run(['sh', '-c', `echo nope > ${join(root, 'outside.txt')}; exit 3`]);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.exitCode, 3);
    assert.equal(
      existsSync(join(root, 'outside.txt')),
      false,
      'outside the workspace is read-only',
    );
    const network = await run(['sh', '-c', 'getent hosts example.com || exit 7']);
    assert.notEqual(network.exitCode, 0, 'no network');
    const slow = await run(['sh', '-c', 'sleep 30'], 500);
    assert.equal(slow.status, 'timeout');
    assert.deepEqual(readFileSync(join(cwd, 'result.txt'), 'utf8'), 'ran\n');
  },
);

test('the check service runs one check per project and after writing turns when asked', async (t) => {
  const root = temporary(t);
  mkdirSync(join(root, 'project'));
  const store = new ExecutionLedger(join(root, 'ledger.db'), schema);
  t.after(() => store.close());
  store.startOwner('checks-owner', true);
  const project = store.registerWorkspace(join(root, 'project'));
  const finish = (token: RunToken, n: number) => {
    const thread = store.prepare(token, `t-${n}`, 'thread_start', {});
    store.sending(token, thread.intentId, 1);
    store.accepted(token, thread.intentId, { threadId: `thread-${n}` });
    const turn = store.prepare(token, `u-${n}`, 'turn_start', {}, `thread-${n}`);
    store.sending(token, turn.intentId, 1);
    store.accepted(token, turn.intentId, { turnId: `turn-${n}` });
    store.finish(token, 'completed');
  };
  const writer = store.beginRun(project.id, 'edit', 'w1', 'workspaceWrite', undefined, undefined, {
      permissionMode: 'auto',
    }),
    reader = store.beginRun(project.id, 'look', 'r1', 'readOnly');
  finish(writer.token, 1);
  finish(reader.token, 2);
  const conversationId = store.runForHost(writer.token.runId).taskId;
  let release!: (result: CheckResult) => void;
  let calls = 0;
  const service = new ProjectCheckService(store, new ProjectCheckStore(join(root, 'checks.json')), {
    cli: () => '/unused',
    stateDirectory: join(root, 'state'),
    run: async (options) => {
      calls++;
      assert.deepEqual(options.argv, ['python3', '-m', 'pytest']);
      assert.equal(options.cwd, project.directory);
      return new Promise<CheckResult>((done) => (release = done));
    },
  });
  await assert.rejects(
    service.run({ projectId: project.id, conversationId }),
    /CHECK_NOT_CONFIGURED/,
  );
  assert.deepEqual(
    service.configure({ projectId: project.id, preset: 'pytest', autoRun: true }).config,
    {
      argv: ['python3', '-m', 'pytest'],
      label: 'pytest',
      autoRun: true,
    },
  );
  const first = service.run({ projectId: project.id, conversationId });
  await assert.rejects(service.run({ projectId: project.id, conversationId }), /CHECK_RUNNING/);
  release({
    status: 'failed',
    exitCode: 1,
    durationMs: 1200,
    output: '1 failed',
    outputTruncated: false,
  });
  const view = await first;
  assert.equal(view.status, 'failed');
  assert.equal(view.afterRunId, writer.token.runId);
  assert.equal(view.automatic, false);
  assert.deepEqual(
    service.list({ projectId: project.id, conversationId }).map((row) => row.checkId),
    [view.checkId],
  );
  // Automatic: only after a completed turn that could write.
  service.afterTurn(reader.token.runId);
  assert.equal(calls, 1);
  service.afterTurn(writer.token.runId);
  assert.equal(calls, 2);
  release({ status: 'passed', exitCode: 0, durationMs: 900, output: 'ok', outputTruncated: false });
  await new Promise((done) => setTimeout(done, 20));
  const rows = service.list({ projectId: project.id, conversationId });
  assert.equal(rows[0]!.automatic, true);
  assert.equal(rows[0]!.status, 'passed');
  // A typed command and removal.
  assert.deepEqual(
    service.configure({ projectId: project.id, command: 'go test ./pkg/...' }).config?.argv,
    ['go', 'test', './pkg/...'],
  );
  assert.equal(service.configure({ projectId: project.id, remove: true }).config, null);
  assert.throws(
    () => service.configure({ projectId: project.id, command: 'a; b' }),
    /NEEDS_NO_SHELL/,
  );
});
