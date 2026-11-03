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
test('durable client request IDs cannot be reused after success or while pending', async () => {
  const rpc = client('echo');
  try {
    const first = rpc.requestWithId('durable-fixture-id', 'test/echo', {});
    await assert.rejects(rpc.requestWithId('durable-fixture-id', 'test/echo', {}), /INVALID_CLIENT_REQUEST_ID/);
    await first;
    await assert.rejects(rpc.requestWithId('durable-fixture-id', 'test/echo', {}), /INVALID_CLIENT_REQUEST_ID/);
  } finally { await rpc.close(); }
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
test('the native child preserves configured authentication/proxy bindings but cannot inherit the parent agent tool bridge or sandbox identity', () => {
  const env=runtimeEnvironment({PATH:'/fixture/bin',HOME:'/fixture/home',CODEX_HOME:'/fixture/codex',OIC_MANIFEST_PATH:'/fixture/identity',HTTPS_PROXY:'https://fixture.invalid',
    PERSONAL_AGENT_UNRELATED_SECRET:'fixture-only',CODEX_M0_TEST_GUARD:'fixture-guard',CODEX_APP_TOOLS_PIPE_PATH:'/fixture/parent-tools',CODEX_SANDBOX:'seatbelt',CODEX_THREAD_ID:'parent-thread',CODEX_SESSION_ID:'parent-session'});
  assert.equal(env.PATH,'/fixture/bin');assert.equal(env.HOME,'/fixture/home');assert.equal(env.CODEX_HOME,'/fixture/codex');assert.equal(env.OIC_MANIFEST_PATH,'/fixture/identity');assert.equal(env.HTTPS_PROXY,'https://fixture.invalid');
  for(const key of ['PERSONAL_AGENT_UNRELATED_SECRET','CODEX_M0_TEST_GUARD','CODEX_APP_TOOLS_PIPE_PATH','CODEX_SANDBOX','CODEX_THREAD_ID','CODEX_SESSION_ID'])assert.equal(env[key],undefined);
});
test('a diagnostic consumer failure does not break RPC error correlation or expose private error text', async () => {
  const rpc = client('remote-error', { onRemoteError: () => { throw new Error('fixture-consumer-error'); } });
  try {
    await assert.rejects(rpc.request('test/fail', {}), error => error instanceof RpcFailure
      && error.code === 'REMOTE_-32600' && !JSON.stringify(error).includes('fixture-private-diagnostic'));
    assert.deepEqual(await rpc.request('test/count', {}), { 'test/fail': 1, 'test/count': 1 });
  } finally { await rpc.close(); }
});
test('cold initialization has its own deadline; ordinary uncertain requests retain their deadline and are not repeated', async () => {
  const rpc = client('slow-startup', { requestTimeoutMs: 30, initializeTimeoutMs: 500 });
  try {
    // Wait for the child to be ready before measuring the shorter ordinary deadline.
    await rpc.request('test/ready', {}, 2_000);
    assert.deepEqual(await rpc.request('initialize', {}), { ready: true });
    await assert.rejects(rpc.request('test/timeout', {}), error => error instanceof RpcFailure && error.code === 'RESPONSE_TIMEOUT' && error.outcomeUnknown);
    const counts = await rpc.request<Record<string, number>>('test/count', {}, 2_000);
    assert.equal(counts.initialize, 1); assert.equal(counts['test/timeout'], 1);
  } finally { await rpc.close(); }
});
for (const mode of ['backfill-exit', 'backfill-timeout']) {
  test(`${mode} is a sanitized initialization failure and never a login failure or business success`, async () => {
    const rpc = client(mode, { initializeTimeoutMs: 200 });
    try {
      await rpc.request('test/ready', {});
      await assert.rejects(rpc.request('initialize', {}), error => error instanceof RpcFailure
        && error.code === 'CODEX_STATE_INDEX_PENDING' && !error.outcomeUnknown && !JSON.stringify(error).includes('private-history'));
      if (mode === 'backfill-timeout') {
        await assert.rejects(rpc.request('test/timeout', {}, 30), error => error instanceof RpcFailure && error.code === 'RESPONSE_TIMEOUT' && error.outcomeUnknown);
        assert.equal((await rpc.request<Record<string, number>>('test/count', {})).initialize, 1);
      }
    } finally { await rpc.close(); }
  });
}
