import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryBrowser } from '../packages/codex-adapter/src/history.ts';
import type { ReadPort } from '../packages/codex-adapter/src/history.ts';
import { RpcFailure } from '../packages/codex-adapter/src/rpc.ts';

type Override = (method: string, params: Record<string, unknown>, normal: unknown) => unknown;
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  override?: Override,
  mode = 'paginated',
  options: ConstructorParameters<typeof HistoryBrowser>[2] = {},
) {
  // macOS tmpdir can itself be a /var -> /private/var symlink. Backend fixtures
  // must use the canonical cwd that the Host actually grants.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'personal-agent-history-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project');
  const other = join(directory, 'other');
  await mkdir(root);
  await mkdir(other);
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const port: ReadPort = {
    request: async <T>(method: string, params: unknown): Promise<T> => {
      const p = params as Record<string, unknown>;
      calls.push({ method, params: p });
      let response: unknown;
      if (method === 'thread/list')
        response = {
          data: [
            {
              id: 'thread',
              cwd: root,
              preview: 'Test history',
              updatedAt: 1,
              status: { type: 'idle' },
            },
          ],
          nextCursor: null,
        };
      else if (method === 'thread/read')
        response = {
          thread: {
            id: p.threadId,
            cwd: root,
            historyMode: mode,
            turns: Array.from({ length: 25 }, (_, i) => ({
              id: `turn-${i}`,
              status: 'completed',
              items: [{ type: 'agentMessage', id: `item-${i}`, text: 'stored-fixture' }],
            })),
          },
        };
      else if (method === 'thread/turns/list')
        response = { data: [{ id: 'turn', status: 'completed' }], nextCursor: null };
      else if (method === 'thread/items/list')
        response = {
          data: [
            {
              turnId: p.turnId,
              item: { type: 'agentMessage', id: 'item', text: 'stored-fixture' },
            },
          ],
          nextCursor: null,
        };
      else throw new Error(`UNEXPECTED_TEST_METHOD_${method}`);
      return (override ? override(method, p, response) : response) as T;
    },
  };
  const browser = new HistoryBrowser(async (read) => read(port), undefined, options);
  const project = await browser.registerDirectory(root);
  const navigate = async () => {
    await browser.listThreads({ projectId: project.id });
    await browser.listTurns({ projectId: project.id, threadId: 'thread' });
  };
  return { directory, root, other, calls, browser, project, navigate };
}
const failure = (code: string) => (error: unknown) =>
  error instanceof RpcFailure && error.code === code;

test('folder grants canonicalize symlinks, deduplicate roots and export detached view objects', async (t) => {
  const f = await fixture(t);
  const link = join(f.directory, 'link');
  await symlink(f.root, link);
  const copy = await f.browser.registerDirectory(link);
  assert.equal(copy.id, f.project.id);
  assert.equal(copy.directory, f.root);
  copy.directory = '/outside';
  assert.equal((await f.browser.registerDirectory(f.root)).directory, f.root);
});
test('unknown project IDs and arbitrary path or extra RPC parameters fail before accessing the backend', async (t) => {
  const f = await fixture(t);
  for (const input of [
    null,
    'path',
    { projectId: f.project.id, path: '/etc' },
    { projectId: f.project.id, cursor: 1 },
  ]) {
    await assert.rejects(f.browser.listThreads(input), failure('INVALID_HISTORY_QUERY'));
  }
  await assert.rejects(
    f.browser.listThreads({ projectId: 'unregistered' }),
    failure('UNKNOWN_PROJECT'),
  );
  assert.equal(f.calls.length, 0);
});
test('thread queries fix cwd and page size, and export bounded summaries without raw metadata', async (t) => {
  const f = await fixture(t, (method, _p, normal) =>
    method === 'thread/list'
      ? {
          data: [
            {
              id: 'thread',
              cwd: f.root,
              preview: 'x'.repeat(500),
              path: '/private-rollout',
              status: { type: 'idle' },
            },
          ],
          nextCursor: null,
        }
      : normal,
  );
  const page = await f.browser.listThreads({ projectId: f.project.id });
  assert.equal(f.calls[0]?.params.cwd, f.root);
  assert.equal(f.calls[0]?.params.limit, 20);
  assert.equal(page.items[0]?.title.length, 160);
  assert.equal(JSON.stringify(page).includes('/private-rollout'), false);
});
test('a mixed-scope server page is rejected atomically and grants no thread navigation authority', async (t) => {
  const f = await fixture(t, (method, _p, normal) =>
    method === 'thread/list'
      ? {
          data: [
            { id: 'allowed', cwd: f.root },
            { id: 'foreign', cwd: f.other },
          ],
          nextCursor: null,
        }
      : normal,
  );
  await assert.rejects(
    f.browser.listThreads({ projectId: f.project.id }),
    failure('HISTORY_SCOPE_MISMATCH'),
  );
  const count = f.calls.length;
  await assert.rejects(
    f.browser.listTurns({ projectId: f.project.id, threadId: 'allowed' }),
    failure('THREAD_NOT_IN_PROJECT'),
  );
  assert.equal(f.calls.length, count);
});
test('thread IDs seen under one folder cannot be read under another folder grant', async (t) => {
  const f = await fixture(t);
  await f.browser.listThreads({ projectId: f.project.id });
  const other = await f.browser.registerDirectory(f.other);
  const count = f.calls.length;
  await assert.rejects(
    f.browser.listTurns({ projectId: other.id, threadId: 'thread' }),
    failure('THREAD_NOT_IN_PROJECT'),
  );
  assert.equal(f.calls.length, count);
});
test('fresh thread metadata is checked before reading message history', async (t) => {
  const f = await fixture(t, (method, p, normal) =>
    method === 'thread/read'
      ? { thread: { id: p.threadId, cwd: f.other, historyMode: 'paginated' } }
      : normal,
  );
  await f.browser.listThreads({ projectId: f.project.id });
  await assert.rejects(
    f.browser.listTurns({ projectId: f.project.id, threadId: 'thread' }),
    failure('HISTORY_SCOPE_MISMATCH'),
  );
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['thread/list', 'thread/read'],
  );
});
test('native pagination cursors are replaced with scoped handles and refresh invalidates old handles', async (t) => {
  let refreshed!: () => void;
  const done = new Promise<void>((r) => (refreshed = r));
  const f = await fixture(
    t,
    (method, _p, normal) =>
      method === 'thread/list'
        ? { ...(normal as object), nextCursor: 'native-sensitive-cursor' }
        : normal,
    'paginated',
    { refreshAfterMs: 0, onRefreshed: () => refreshed() },
  );
  const page = await f.browser.listThreads({ projectId: f.project.id });
  const token = page.nextCursor!;
  assert.ok(token);
  assert.notEqual(token, 'native-sensitive-cursor');
  const other = await f.browser.registerDirectory(f.other);
  await assert.rejects(
    f.browser.listThreads({ projectId: other.id, cursor: token }),
    failure('INVALID_HISTORY_CURSOR'),
  );
  await assert.rejects(
    f.browser.listTurns({ projectId: f.project.id, threadId: 'thread', cursor: token }),
    failure('INVALID_HISTORY_CURSOR'),
  );
  await f.browser.listThreads({ projectId: f.project.id, cursor: token });
  assert.equal(f.calls.at(-1)?.params.cursor, 'native-sensitive-cursor');
  // The cached first page still answers at once; its background refresh replaces the handle.
  assert.equal((await f.browser.listThreads({ projectId: f.project.id })).nextCursor, token);
  await done;
  await assert.rejects(
    f.browser.listThreads({ projectId: f.project.id, cursor: token }),
    failure('INVALID_HISTORY_CURSOR'),
  );
  assert.notEqual((await f.browser.listThreads({ projectId: f.project.id })).nextCursor, token);
});
test('the first thread page is cached, shared and refreshed in the background', async (t) => {
  let now = 1000,
    title = 'first',
    fail = false,
    refreshed = 0,
    wake!: () => void;
  const f = await fixture(
    t,
    (method, _p, normal) => {
      if (method !== 'thread/list') return normal;
      if (fail) throw new RpcFailure('RESPONSE_TIMEOUT');
      const page = normal as { data: Array<Record<string, unknown>> };
      return { ...page, data: [{ ...page.data[0], preview: title }] };
    },
    'paginated',
    {
      refreshAfterMs: 100,
      now: () => now,
      onRefreshed: () => {
        refreshed++;
        wake?.();
      },
    },
  );
  const lists = () => f.calls.filter((c) => c.method === 'thread/list').length;
  const input = { projectId: f.project.id };
  // Concurrent first callers share one live read.
  const [a, b] = await Promise.all([f.browser.listThreads(input), f.browser.listThreads(input)]);
  assert.equal(lists(), 1);
  assert.equal(a.items[0]!.title, 'first');
  assert.deepEqual(a, b);
  // Within the interval: served from the cache, no read.
  title = 'second';
  now += 50;
  assert.equal((await f.browser.listThreads(input)).items[0]!.title, 'first');
  assert.equal(lists(), 1);
  // After the interval: still answered from the cache at once, refreshed in the background.
  now += 100;
  const woke = new Promise<void>((r) => (wake = r));
  assert.equal((await f.browser.listThreads(input)).items[0]!.title, 'first');
  await woke;
  assert.equal(lists(), 2);
  assert.equal(refreshed, 1);
  assert.equal((await f.browser.listThreads(input)).items[0]!.title, 'second');
  // A failed refresh keeps the last page and does not retry before the next interval.
  fail = true;
  now += 100;
  assert.equal((await f.browser.listThreads(input)).items[0]!.title, 'second');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(lists(), 3);
  assert.equal((await f.browser.listThreads(input)).items[0]!.title, 'second');
  assert.equal(lists(), 3);
  assert.equal(refreshed, 1);
  // Clearing the cache makes the next call read live again.
  fail = false;
  title = 'third';
  f.browser.clearCache();
  assert.equal((await f.browser.listThreads(input)).items[0]!.title, 'third');
  assert.equal(lists(), 4);
});
test('turn authority and every returned item entry are checked before content export', async (t) => {
  const f = await fixture(t, (method, _p, normal) =>
    method === 'thread/items/list'
      ? {
          data: [
            {
              turnId: 'foreign-turn',
              item: { type: 'agentMessage', id: 'private', text: 'must-not-export' },
            },
          ],
          nextCursor: null,
        }
      : normal,
  );
  await f.navigate();
  const count = f.calls.length;
  await assert.rejects(
    f.browser.listItems({ projectId: f.project.id, threadId: 'thread', turnId: 'guessed' }),
    failure('TURN_NOT_IN_THREAD'),
  );
  assert.equal(f.calls.length, count);
  await assert.rejects(
    f.browser.listItems({ projectId: f.project.id, threadId: 'thread', turnId: 'turn' }),
    failure('HISTORY_SCOPE_MISMATCH'),
  );
});
test('large tool/message output stays within per-item and aggregate budgets and excludes private tool fields', async (t) => {
  const f = await fixture(t, (method, p, normal) =>
    method === 'thread/items/list'
      ? {
          data: Array.from({ length: 20 }, (_, i) => ({
            turnId: p.turnId,
            item: {
              type: 'commandExecution',
              id: `i-${i}`,
              command: 'fixture',
              aggregatedOutput: 'x'.repeat(20_000),
              arguments: { token: 'fixture-private-field' },
            },
          })),
          nextCursor: null,
        }
      : normal,
  );
  await f.navigate();
  const page = await f.browser.listItems({
    projectId: f.project.id,
    threadId: 'thread',
    turnId: 'turn',
  });
  assert.equal(page.items.length, 20);
  assert.equal(page.truncated, true);
  assert.ok(page.items.every((item) => item.text.length <= 16_384));
  assert.ok(page.items.reduce((sum, item) => sum + item.text.length, 0) <= 65_536);
  assert.equal(JSON.stringify(page).includes('fixture-private-field'), false);
});
test('oversized server pages fail closed rather than silently dropping unexpected rows', async (t) => {
  const f = await fixture(t, (method, _p, normal) =>
    method === 'thread/list'
      ? {
          data: Array.from({ length: 21 }, (_, i) => ({ id: `t-${i}`, cwd: f.root })),
          nextCursor: null,
        }
      : normal,
  );
  await assert.rejects(
    f.browser.listThreads({ projectId: f.project.id }),
    failure('HISTORY_PAGE_TOO_LARGE'),
  );
});
test('legacy history uses bounded read-only snapshots and local paging without Resume or paginated RPC calls', async (t) => {
  const f = await fixture(t, undefined, 'legacy');
  await f.browser.listThreads({ projectId: f.project.id });
  const first = await f.browser.listTurns({ projectId: f.project.id, threadId: 'thread' });
  assert.equal(first.mode, 'legacy');
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0]?.id, 'turn-24');
  const second = await f.browser.listTurns({
    projectId: f.project.id,
    threadId: 'thread',
    cursor: first.nextCursor!,
  });
  assert.equal(second.items.length, 5);
  const page = await f.browser.listItems({
    projectId: f.project.id,
    threadId: 'thread',
    turnId: 'turn-24',
  });
  assert.equal(page.items[0]?.text, 'stored-fixture');
  assert.ok(
    f.calls.every((call) => call.method === 'thread/list' || call.method === 'thread/read'),
  );
  assert.ok(f.calls.some((call) => call.params.includeTurns === true));
});
test('replacing an authorized project directory invalidates its grant before any history read', async (t) => {
  const f = await fixture(t);
  await rename(f.root, join(f.directory, 'moved'));
  await mkdir(f.root);
  await assert.rejects(
    f.browser.listThreads({ projectId: f.project.id }),
    failure('PROJECT_IDENTITY_CHANGED'),
  );
  assert.equal(f.calls.length, 0);
});
test('read errors propagate without automatic retries or fallback execution methods', async (t) => {
  const f = await fixture(t, () => {
    throw new RpcFailure('REMOTE_-32600');
  });
  await assert.rejects(
    f.browser.listThreads({ projectId: f.project.id }),
    failure('REMOTE_-32600'),
  );
  assert.equal(f.calls.length, 1);
});
