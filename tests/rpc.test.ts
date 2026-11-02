import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { RpcFailure, StdioRpcClient } from '../packages/codex-adapter/src/rpc.ts';
import { runtimeEnvironment } from '../packages/codex-adapter/src/launch.ts';

function client(mode: string, extra: Partial<ConstructorParameters<typeof StdioRpcClient>[0]> = {}) {
  return new StdioRpcClient({ executable: process.execPath,
    args: [resolve(import.meta.dirname, 'fixtures/rpc-server.ts'), mode], requestTimeoutMs: 2_000, ...extra });
}
test('out-of-order responses retain the correct request identity', async () => {
  const rpc = client('reverse');
  try {
    const results = await Promise.all([rpc.request('test/echo', { target: 'first' }), rpc.request('test/echo', { target: 'second' })]);
    assert.deepEqual(results, [{ target: 'first' }, { target: 'second' }]);
  } finally { await rpc.close(); }
});
test('server request with a colliding numeric ID is denied without resolving the client request', async () => {
  const rpc = client('approval', { onServerRequest: async () => ({ decision: 'decline' }) });
  try { assert.deepEqual(await rpc.request('test/start', {}), { declined: true }); }
  finally { await rpc.close(); }
});
test('an unsupported server request fails closed', async () => {
  const rpc = client('unsupported');
  try { assert.deepEqual(await rpc.request('test/start', {}), { denied: true }); }
  finally { await rpc.close(); }
});
test('UTF-8 frames split inside a code point preserve repeated text', async () => {
  const texts: string[] = [];
  const rpc = client('unicode', { onNotification: m => texts.push(String((m.params as { text: string }).text)) });
  try { await rpc.request('test/start', {}); assert.deepEqual(texts, ['你你好']); }
  finally { await rpc.close(); }
});
for (const [mode, code] of [['malformed', 'INVALID_JSON_FRAME'], ['oversize', 'FRAME_TOO_LARGE'], ['utf8', 'INVALID_JSON_FRAME']] as const) {
  test(`${mode} input closes the connection and rejects pending execution as unknown`, async () => {
    const rpc = client(mode, { maximumFrameBytes: 1024 });
    try {
      await assert.rejects(rpc.request('test/start', {}), error => error instanceof RpcFailure && error.code === code && error.outcomeUnknown);
    } finally { await rpc.close(); }
  });
}
test('a response deadline does not automatically resubmit an uncertain request', async () => {
  const rpc = client('timeout');
  try {
    // Allow enough time for a fresh Node process before asserting the silent request deadline.
    await rpc.request('test/ready', {});
    await assert.rejects(rpc.request('test/timeout', {}, 50), error => error instanceof RpcFailure && error.outcomeUnknown);
    const counts = await rpc.request<Record<string, number>>('test/count', {});
    assert.equal(counts['test/timeout'], 1);
  } finally { await rpc.close(); }
});
test('process exit rejects all outstanding requests and is not a successful empty result', async () => {
  const rpc = client('crash');
  try {
    const results = await Promise.allSettled([rpc.request('test/one', {}), rpc.request('test/two', {})]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof RpcFailure && result.reason.outcomeUnknown));
  } finally { await rpc.close(); }
});
test('closed clients reject new work and cleanup can be awaited more than once', async () => {
  const rpc = client('echo');
  await rpc.close();
  await rpc.close();
  await assert.rejects(rpc.request('test/start', {}), error => error instanceof RpcFailure && error.code === 'DISCONNECTED');
});
test('owner cancellation rejects pending work and waits for its child process to stop', async () => {
  const controller = new AbortController();
  const rpc = client('timeout', { signal: controller.signal });
  try {
    await rpc.request('test/ready', {});
    const request = rpc.request('test/timeout', {});
    const assertion = assert.rejects(request, error => error instanceof RpcFailure && error.code === 'CLIENT_ABORTED' && error.outcomeUnknown);
    controller.abort();
    await assertion;
    await rpc.waitClosed();
  } finally { await rpc.close(); }
});
test('the trusted runtime preserves injected guards but excludes unrelated application secrets', () => {
  const originalSecret = process.env.PERSONAL_AGENT_UNRELATED_SECRET;
  const originalGuard = process.env.CODEX_M0_TEST_GUARD;
  process.env.PERSONAL_AGENT_UNRELATED_SECRET = 'fixture-only';
  process.env.CODEX_M0_TEST_GUARD = 'fixture-guard';
  try {
    const env = runtimeEnvironment();
    assert.equal(env.PERSONAL_AGENT_UNRELATED_SECRET, undefined);
    assert.equal(env.CODEX_M0_TEST_GUARD, 'fixture-guard');
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    if (originalSecret === undefined) delete process.env.PERSONAL_AGENT_UNRELATED_SECRET; else process.env.PERSONAL_AGENT_UNRELATED_SECRET = originalSecret;
    if (originalGuard === undefined) delete process.env.CODEX_M0_TEST_GUARD; else process.env.CODEX_M0_TEST_GUARD = originalGuard;
  }
});
test('a diagnostic consumer failure does not break RPC error correlation or expose private error text', async () => {
  const rpc = client('remote-error', { onRemoteError: () => { throw new Error('fixture-consumer-error'); } });
  try {
    await assert.rejects(rpc.request('test/fail', {}), error => error instanceof RpcFailure
      && error.code === 'REMOTE_-32600' && !JSON.stringify(error).includes('fixture-private-diagnostic'));
    assert.deepEqual(await rpc.request('test/count', {}), { 'test/fail': 1, 'test/count': 1 });
  } finally { await rpc.close(); }
});
