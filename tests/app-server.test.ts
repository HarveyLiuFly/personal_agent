import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AppServerRuntime } from '../packages/codex-adapter/src/app-server.ts';
import { RpcFailure } from '../packages/codex-adapter/src/rpc.ts';
import { inspectCatalog } from '../packages/codex-adapter/src/smoke.ts';
import type { ReadPort } from '../packages/codex-adapter/src/history.ts';
function fixture(
  t: { after(fn: () => Promise<void>): void },
  limits: ConstructorParameters<typeof AppServerRuntime>[1] = {},
  initialMode = 'normal',
) {
  const root = mkdtempSync(join(tmpdir(), 'pa-app-server-')),
    file = join(root, 'events.jsonl'),
    home = join(root, 'home');
  mkdirSync(home);
  let mode = initialMode;
  const options = () => {
    if (mode === 'unavailable') throw new RpcFailure('PRIVACY_CLEANUP_PENDING');
    return {
      executable: process.execPath,
      args: [resolve('tests/fixtures/app-server.ts'), file, mode],
      env: { ...process.env, CODEX_HOME: home },
      requestTimeoutMs: 500,
      initializeTimeoutMs: 2000,
    };
  };
  const runtime = new AppServerRuntime(options, limits);
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const events = (): Array<{ pid: number; event: string; method?: string }> => {
    try {
      return readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s));
    } catch {
      return [];
    }
  };
  return {
    runtime,
    options,
    events,
    home,
    mode: (value: string) => {
      mode = value;
    },
  };
}
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
};
test('catalog and paginated history reuse one live PID and initialize exactly once, including concurrent callers', async (t) => {
  const f = fixture(t, {}, 'slow');
  const [a, b, c] = await Promise.all([
    f.runtime.read(inspectCatalog),
    f.runtime.read((p) => p.request<{ pid: number }>('thread/read', {})),
    f.runtime.read((p) => p.request<{ pid: number }>('thread/list', {})),
  ]);
  assert.equal(a.models, 1);
  assert.equal(b.pid, c.pid);
  assert.equal(f.runtime.snapshot().starts, 1);
  assert.equal(f.runtime.snapshot().reused, 2);
  assert.equal(f.events().filter((e) => e.method === 'initialize').length, 1);
  assert.equal(f.events().filter((e) => e.method === 'initialized').length, 1);
  assert.equal(f.runtime.snapshot().state, 'ready');
});
test('read leases cannot dispatch a model or be retained after release', async (t) => {
  const f = fixture(t);
  let leaked: ReadPort | undefined;
  await f.runtime.read(async (p) => {
    leaked = p;
    await assert.rejects(p.request('turn/start', {}), /READ_METHOD_NOT_ALLOWED/);
  });
  await assert.rejects(leaked!.request('thread/read', {}), /APP_SERVER_LEASE_EXPIRED/);
  assert.equal(f.events().filter((e) => e.method === 'turn/start').length, 0);
});
test('a process exit fails the current request once; only a subsequent explicit read builds a new generation', async (t) => {
  const f = fixture(t);
  await f.runtime.read(inspectCatalog);
  const old = f.runtime.snapshot().metadataPid!;
  await assert.rejects(
    f.runtime.read((p) => p.request('thread/turns/list', {})),
    /PROCESS_EXITED/,
  );
  assert.equal(f.events().filter((e) => e.method === 'thread/turns/list').length, 1);
  assert.equal(f.runtime.snapshot().starts, 1);
  assert.ok(gone(old));
  await f.runtime.read(inspectCatalog);
  assert.equal(f.runtime.snapshot().starts, 2);
});
test('an aborted lease is rejected at once and leaves the shared connection serving others', async (t) => {
  const f = fixture(t, { concurrency: 1 });
  await f.runtime.read(inspectCatalog);
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>((r) => {
      entered = r;
    }),
    releasePromise = new Promise<void>((r) => {
      release = r;
    });
  const first = f.runtime.read(async () => {
    entered();
    await releasePromise;
    return 1;
  });
  await enteredPromise;
  const pid = f.runtime.snapshot().metadataPid!,
    queuedAbort = new AbortController();
  let queuedEntered = false;
  const queued = f.runtime.read(async () => {
    queuedEntered = true;
  }, queuedAbort.signal);
  const rejected = assert.rejects(queued, /CLIENT_ABORTED/);
  queuedAbort.abort();
  await rejected;
  release();
  assert.equal(await first, 1);
  assert.equal(queuedEntered, false, 'a cancelled waiter never enters');
  assert.equal(f.runtime.snapshot().metadataPid, pid);
  // Abort while a request is in flight: the caller is rejected at once, the process stays.
  const abort = new AbortController();
  const begun = Date.now();
  const pending = f.runtime.read(async (p) => {
    setTimeout(() => abort.abort(), 40);
    return p.request('thread/items/list', {});
  }, abort.signal);
  await assert.rejects(pending, /CLIENT_ABORTED/);
  assert.ok(Date.now() - begun < 400, 'rejected before the request deadline');
  assert.ok(!gone(pid));
  await f.runtime.read(inspectCatalog);
  assert.equal(f.runtime.snapshot().metadataPid, pid);
  assert.equal(f.runtime.snapshot().starts, 1);
});
test('a slow read does not hold up other reads on the same connection', async (t) => {
  const f = fixture(t);
  await f.runtime.read(inspectCatalog);
  let release!: () => void;
  const slow = f.runtime.read(
    () => new Promise<string>((done) => (release = () => done('listed'))),
  );
  const begun = Date.now();
  const [a, b] = await Promise.all([
    f.runtime.read(inspectCatalog),
    f.runtime.read((p) => p.request<{ pid: number }>('thread/read', {})),
  ]);
  assert.ok(Date.now() - begun < 300, 'answered while the slow read was still open');
  assert.equal(a.models, 1);
  assert.equal(b.pid, f.runtime.snapshot().metadataPid);
  release();
  assert.equal(await slow, 'listed');
  assert.equal(f.runtime.snapshot().starts, 1);
});
test('leases beyond the concurrency limit wait in order', async (t) => {
  const f = fixture(t, { concurrency: 2 });
  await f.runtime.read(inspectCatalog);
  const order: string[] = [],
    releases: Array<() => void> = [];
  const hold = (name: string) =>
    f.runtime.read(async () => {
      order.push(name);
      await new Promise<void>((r) => releases.push(r));
      return name;
    });
  const a = hold('a'),
    b = hold('b'),
    c = hold('c');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(f.runtime.snapshot().queued, 3);
  releases[0]!();
  assert.equal(await a, 'a');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['a', 'b', 'c']);
  releases[1]!();
  releases[2]!();
  assert.deepEqual(await Promise.all([b, c]), ['b', 'c']);
});
test('concurrent first reads share one start and its failure', async (t) => {
  const f = fixture(t, {}, 'backfill');
  const results = await Promise.allSettled([
    f.runtime.read(inspectCatalog),
    f.runtime.read(inspectCatalog),
    f.runtime.read(inspectCatalog),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(String((result as PromiseRejectedResult).reason), /CODEX_STATE_INDEX_PENDING/);
  }
  assert.equal(f.runtime.snapshot().starts, 1);
});
test('a remote error in one lease keeps the connection for the others', async (t) => {
  const f = fixture(t);
  await f.runtime.read(inspectCatalog);
  const pid = f.runtime.snapshot().metadataPid!;
  const [failed, listed] = await Promise.allSettled([
    f.runtime.read((p) => p.request('thread/read', { remoteError: true })),
    f.runtime.read((p) => p.request<{ pid: number }>('thread/list', {})),
  ]);
  assert.equal(failed.status, 'rejected');
  assert.match(String((failed as PromiseRejectedResult).reason), /REMOTE_-32602/);
  assert.equal(listed.status, 'fulfilled');
  assert.equal(f.runtime.snapshot().state, 'ready');
  assert.equal(f.runtime.snapshot().metadataPid, pid);
  assert.ok(!gone(pid));
});
test('privacy reset fences queued and leaked readers, closes the process, and permits a fresh explicit connection', async (t) => {
  const f = fixture(t);
  let port: ReadPort | undefined, entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const active = f.runtime.read(async (p) => {
    port = p;
    entered();
    return p.request('thread/items/list', {});
  });
  const activeRejected = assert.rejects(active);
  await ready;
  const pid = f.runtime.snapshot().metadataPid!,
    queued = f.runtime.read(inspectCatalog),
    queuedRejected = assert.rejects(queued, /APP_SERVER_CONTEXT_CHANGED/);
  await f.runtime.reset();
  await Promise.all([activeRejected, queuedRejected]);
  assert.ok(gone(pid));
  await assert.rejects(port!.request('thread/read', {}), /APP_SERVER_LEASE_EXPIRED/);
  await f.runtime.read(inspectCatalog);
  assert.equal(f.runtime.snapshot().starts, 2);
});
test('shutdown during initialization prevents late readiness and closes all dedicated children before returning', async (t) => {
  const f = fixture(t, {}, 'slow');
  await f.runtime.read(inspectCatalog);
  const fence = await f.runtime.prepare();
  const child = f.runtime.openDedicated(f.options(), fence);
  await child.request('initialize', {});
  const pid = child.processId!;
  assert.equal(f.runtime.snapshot().dedicatedProcesses, 1);
  await f.runtime.close();
  assert.ok(gone(pid));
  assert.equal(f.runtime.snapshot().dedicatedProcesses, 0);
  assert.equal(f.runtime.snapshot().state, 'closed');
  await assert.rejects(f.runtime.read(inspectCatalog), /APP_SERVER_CLOSED/);
  assert.throws(() => f.runtime.openDedicated(f.options(), fence), /APP_SERVER_CLOSED/);
});
test('reset during initialize cannot publish a ready connection or admit a stale dedicated lease', async (t) => {
  const f = fixture(t, {}, 'slow'),
    work = f.runtime.prepare(),
    rejected = assert.rejects(work);
  await new Promise((r) => setTimeout(r, 30));
  await f.runtime.reset();
  await rejected;
  assert.equal(f.runtime.snapshot().state, 'idle');
  const fence = await f.runtime.prepare();
  await f.runtime.reset();
  assert.throws(() => f.runtime.openDedicated(f.options(), fence), /APP_SERVER_CONTEXT_CHANGED/);
});
test('queue capacity is bounded and repeated backfill errors cool down without spawning or retrying requests', async (t) => {
  let now = 1000;
  const f = fixture(t, { maximumQueue: 1, backfillCooldownMs: 100, now: () => now }, 'backfill');
  const first = f.runtime.read(inspectCatalog),
    firstError = assert.rejects(first, /CODEX_STATE_INDEX_PENDING/);
  await assert.rejects(f.runtime.read(inspectCatalog), /APP_SERVER_QUEUE_LIMIT/);
  // A long startup must not consume the cooldown before the failed process has exited.
  now += 1000;
  await firstError;
  await assert.rejects(f.runtime.read(inspectCatalog), /CODEX_STATE_INDEX_PENDING/);
  assert.equal(f.runtime.snapshot().starts, 1);
  now += 101;
  await assert.rejects(f.runtime.read(inspectCatalog), /CODEX_STATE_INDEX_PENDING/);
  assert.equal(f.runtime.snapshot().starts, 2);
  assert.equal(f.events().filter((e) => e.method === 'model/list').length, 0);
  f.mode('normal');
  await f.runtime.read(inspectCatalog);
  assert.equal(f.runtime.snapshot().starts, 3);
});
test('auth/config file identity change retires the old process; raw file content is never included in diagnostics', async (t) => {
  const f = fixture(t);
  await f.runtime.read(inspectCatalog);
  const pid = f.runtime.snapshot().metadataPid!;
  writeFileSync(join(f.home, 'auth.json'), 'synthetic-secret-never-exposed\n');
  await f.runtime.read(inspectCatalog);
  assert.equal(f.runtime.snapshot().starts, 2);
  assert.ok(gone(pid));
  assert.ok(!JSON.stringify(f.runtime.snapshot()).includes('synthetic-secret'));
});
test('request-ID exhaustion rotates before the next read instead of replaying a failed request', async (t) => {
  const f = fixture(t, { rotateAfterRequests: 2 });
  await f.runtime.read(inspectCatalog);
  const pid = f.runtime.snapshot().metadataPid!;
  await f.runtime.read(inspectCatalog);
  assert.equal(f.runtime.snapshot().starts, 2);
  assert.ok(gone(pid));
  assert.equal(f.events().filter((e) => e.method === 'model/list').length, 2);
});
test('ordinary metadata timeout remains uncertain and is not resubmitted automatically', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.runtime.read((p) => p.request('thread/items/list', {})),
    (e) => e instanceof RpcFailure && e.code === 'RESPONSE_TIMEOUT' && e.outcomeUnknown,
  );
  assert.equal(f.events().filter((e) => e.method === 'thread/items/list').length, 1);
  assert.equal(f.runtime.snapshot().starts, 1);
});
test('a revoked descriptor closes an already cached process and cannot reuse it during pending privacy cleanup', async (t) => {
  const f = fixture(t);
  await f.runtime.read(inspectCatalog);
  const pid = f.runtime.snapshot().metadataPid!;
  f.mode('unavailable');
  await assert.rejects(f.runtime.read(inspectCatalog), /PRIVACY_CLEANUP_PENDING/);
  assert.ok(gone(pid));
  assert.equal(f.runtime.snapshot().metadataPid, null);
  assert.equal(f.runtime.snapshot().starts, 1);
  assert.equal(f.runtime.snapshot().failureCode, 'PRIVACY_CLEANUP_PENDING');
  f.mode('normal');
  await f.runtime.read(inspectCatalog);
  assert.equal(f.runtime.snapshot().starts, 2);
});
test('identity changes during a read fence its result and close the old connection instead of publishing stale data', async (t) => {
  const f = fixture(t);
  await f.runtime.read(inspectCatalog);
  const pid = f.runtime.snapshot().metadataPid!;
  await assert.rejects(
    f.runtime.read(async () => {
      writeFileSync(join(f.home, 'config.toml'), '# public fixture change\n');
      return 'stale result';
    }),
    /APP_SERVER_CONTEXT_CHANGED/,
  );
  assert.ok(gone(pid));
  await f.runtime.read(inspectCatalog);
  assert.equal(f.runtime.snapshot().starts, 2);
});
test('a Run does not queue behind a slow metadata read once the index is ready', async (t) => {
  const f = fixture(t);
  // Before any connection initialized, preparing goes through the queue and starts one.
  const fence = await f.runtime.prepare();
  assert.equal(f.runtime.snapshot().starts, 1);
  let release!: () => void;
  const slow = f.runtime.read(
    () => new Promise<string>((done) => (release = () => done('listed'))),
  );
  await new Promise((r) => setTimeout(r, 20));
  const begun = Date.now();
  assert.equal(await f.runtime.prepare(), fence);
  assert.ok(Date.now() - begun < 50, 'prepared without waiting for the slow read');
  release();
  assert.equal(await slow, 'listed');
  // A reset changes the fence: the next prepare waits for a fresh initialization again.
  await f.runtime.reset();
  assert.equal(await f.runtime.prepare(), fence + 1);
  assert.equal(f.runtime.snapshot().starts, 2);
});

test('a maintenance lease may archive a thread but never read history or start work', async (t) => {
  const f = fixture(t);
  const archived = await f.runtime.maintain((p) =>
    p.request<{ params: unknown }>('thread/archive', { threadId: 'fixture-thread' }),
  );
  assert.deepEqual(archived.params, { threadId: 'fixture-thread' });
  for (const method of ['turn/start', 'thread/start', 'thread/list'])
    await assert.rejects(
      f.runtime.maintain((p) => p.request(method, {})),
      /READ_METHOD_NOT_ALLOWED/,
    );
  await assert.rejects(
    f.runtime.read((p) => p.request('thread/archive', { threadId: 'x' })),
    /READ_METHOD_NOT_ALLOWED/,
  );
  assert.equal(f.events().filter((e) => e.method === 'turn/start').length, 0);
  assert.equal(f.runtime.snapshot().starts, 1);
});
