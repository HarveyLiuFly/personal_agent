import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { ForegroundExecution } from '../packages/runtime/src/execution.ts';
import { StdioRpcClient } from '../packages/codex-adapter/src/rpc.ts';
function fixture(t: { after(fn: () => Promise<void>): void }, mode: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-interaction-rpc-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const file = join(root, 'store.db'),
    receipts = join(root, 'receipts'),
    store = new ExecutionLedger(file, readFileSync('docs/design/contracts/schema.sql', 'utf8'));
  store.startOwner('real-stdio-fixture', true);
  const p = store.registerWorkspace(workspace);
  const runtime = new ForegroundExecution(store, {
    executable: process.execPath,
    stateDirectory: root,
    mode: 'workspaceWrite',
    timeoutMs: 2000,
    interruptTimeoutMs: 100,
    interactionTimeoutMs: 1000,
    connect: (callbacks) =>
      new StdioRpcClient({
        executable: process.execPath,
        args: [
          '--disable-warning=ExperimentalWarning',
          resolve('tests/fixtures/execution-server.ts'),
          mode,
          file,
          receipts,
        ],
        requestTimeoutMs: 1000,
        ...callbacks,
      }),
  });
  const run = runtime.submit({
      projectId: p.id,
      submissionKey: 'key',
      text: 'interaction stdio fixture',
    }),
    q = { projectId: p.id, runId: run.runId };
  t.after(async () => {
    await runtime.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const pending = async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const r = runtime.interactions(q).find((r) => r.state === 'pending');
      if (r) return r;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('PENDING_TIMEOUT');
  };
  return { root, receipts, store, runtime, q, pending };
}
test('real stdio accept/decline controls one synthetic side effect and replies cannot be replayed', async (t) => {
  for (const decision of ['accept', 'decline'] as const) {
    const f = fixture(t, 'approval-' + decision),
      r = await f.pending();
    f.runtime.reply({ ...f.q, requestId: r.requestId, decision });
    await f.runtime.wait();
    assert.equal(f.runtime.view(f.q).status, 'completed');
    assert.equal(existsSync(f.receipts + '.effect'), decision === 'accept');
    assert.equal(f.runtime.interactions(f.q)[0]!.state, 'responded');
    assert.throws(
      () => f.runtime.reply({ ...f.q, requestId: r.requestId, decision: 'accept' }),
      /STALE_SERVER_REQUEST/,
    );
  }
});
test('real stdio question receives only supplied question-ID answers and resumes the same run', async (t) => {
  const f = fixture(t, 'input'),
    r = await f.pending();
  assert.equal(f.runtime.view(f.q).status, 'waiting_input');
  f.runtime.reply({
    ...f.q,
    requestId: r.requestId,
    decision: 'accept',
    answers: { scope: 'continue' },
  });
  await f.runtime.wait();
  assert.equal(f.runtime.view(f.q).status, 'completed');
  assert.ok(f.runtime.view(f.q).snapshot!.items.some((i) => i.text.includes('continue')));
});
test('interrupt acknowledgment plus authoritative interrupted turn cancels the run exactly once', async (t) => {
  const f = fixture(t, 'interrupt-ok');
  while (!f.runtime.view(f.q).turnId) await new Promise((r) => setTimeout(r, 10));
  await Promise.all([f.runtime.interrupt(f.q), f.runtime.interrupt(f.q)]);
  await f.runtime.wait();
  assert.equal(f.runtime.view(f.q).status, 'cancelled');
  assert.equal(readFileSync(f.receipts, 'utf8').split('turn/interrupt').length - 1, 1);
});
test('interrupt acceptance without final confirmation and lost acceptance both remain Unknown', async (t) => {
  for (const mode of ['interrupt-ack-only', 'interrupt-timeout']) {
    const f = fixture(t, mode);
    while (!f.runtime.view(f.q).turnId) await new Promise((r) => setTimeout(r, 10));
    await f.runtime.interrupt(f.q);
    await f.runtime.wait();
    assert.equal(f.runtime.view(f.q).status, 'outcome_unknown');
    assert.equal(f.runtime.view(f.q).blocked, true);
    assert.equal(readFileSync(f.receipts, 'utf8').split('turn/interrupt').length - 1, 1);
  }
});
