import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import {
  HistoryReconciliation,
  MAX_RECONCILE_ATTEMPTS,
  UnknownRunReconciler,
} from '../packages/runtime/src/reconciliation.ts';
import type { ReadPort } from '../packages/codex-adapter/src/history.ts';
function fixture(
  t: { after(fn: () => void): void },
  options: {
    closed?: boolean;
    accepted?: boolean;
    requestUnknown?: boolean;
    /** Records the executor process (pid, marker) as a crash-recovery check would find it. */
    executor?: { pid: number; marker: string | null };
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-reconciliation-'))),
    cwd = join(root, 'workspace'),
    file = join(root, 'ledger.db');
  mkdirSync(cwd);
  const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
  let store = new ExecutionLedger(file, schema);
  store.startOwner('first', true);
  const project = store.registerWorkspace(cwd),
    text = 'Controlled synthetic user message',
    input = { projectId: project.id, runId: '' };
  const { token } = store.beginRun(project.id, text, 'one', 'workspaceWrite');
  input.runId = token.runId;
  const a = store.prepare(token, 'thread', 'thread_start', {});
  store.sending(token, a.intentId, 1);
  store.accepted(token, a.intentId, { threadId: 'thread' });
  if (options.executor)
    store.executorStarted(token, 1, options.executor.pid, options.executor.marker);
  const b = store.prepare(token, 'turn', 'turn_start', {}, 'thread');
  store.sending(token, b.intentId, 1);
  if (options.accepted || options.requestUnknown) {
    store.accepted(token, b.intentId, { turnId: 'turn' });
  }
  if (options.requestUnknown) {
    const id = store.addRequest(
      token,
      1,
      'request',
      'thread',
      'turn',
      { kind: 'command', title: 'Fixture', detail: 'Fixture', canAccept: true, questions: [] },
      Date.now() + 10000,
    );
    store.responding(token, id, 1, {});
    store.responseWritten(token, id, false);
  } else store.uncertain(token, b.intentId);
  if (options.closed !== false) store.executorClosed(token, 1);
  let mutation = '';
  const calls: string[] = [];
  let reads = 0;
  const port: ReadPort = {
    request: async <T>(method: string, params: unknown): Promise<T> => {
      calls.push(method);
      const q = params as { cursor?: string };
      let result: unknown;
      if (method === 'thread/read') {
        reads++;
        result = {
          thread: {
            id: 'thread',
            cwd: mutation === 'wrong-cwd' ? root : cwd,
            historyMode: 'paginated',
            status: { type: 'notLoaded' },
            updatedAt: mutation === 'changed' && reads > 1 ? 2 : 1,
          },
        };
      } else if (method === 'thread/turns/list')
        result = {
          data: [
            { id: 'turn', status: mutation === 'running' ? 'inProgress' : 'completed' },
            ...(mutation === 'ambiguous' ? [{ id: 'second', status: 'completed' }] : []),
          ],
          nextCursor: null,
        };
      else if (method === 'thread/items/list') {
        const turnId = (params as { turnId: string }).turnId;
        const user = {
          id: 'user',
          type: 'userMessage',
          ...(mutation === 'own-client'
            ? { clientId: input.runId }
            : mutation === 'foreign-client'
              ? { clientId: 'another-run' }
              : {}),
          content: [{ type: 'text', text: mutation === 'no-match' ? 'different' : text }],
        };
        result = {
          data: [
            { turnId: mutation === 'wrong-turn' ? 'foreign' : turnId, item: user },
            {
              turnId,
              item:
                mutation === 'unsupported'
                  ? { id: 'unknown', type: 'futureItem' }
                  : {
                      id: 'assistant',
                      type: 'agentMessage',
                      text: mutation === 'oversized' ? 'a'.repeat(200000) : 'authoritative final',
                    },
            },
          ],
          nextCursor: mutation === 'cursor-loop' ? 'repeat' : null,
        };
        if (q.cursor && mutation !== 'cursor-loop') throw new Error('unexpected cursor');
      } else throw new Error('FORBIDDEN_EXECUTION_METHOD');
      return result as T;
    },
  };
  const service = () => new HistoryReconciliation(store, (read) => read(port));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    cwd,
    file,
    project,
    input,
    token,
    calls,
    service,
    store: () => store,
    mutate: (v: string) => {
      mutation = v;
    },
    reopen: () => {
      store.close();
      store = new ExecutionLedger(file, schema);
      store.startOwner('second', true);
    },
  };
}
test('a lost acceptance reconciles only from unique matching native-shaped terminal history after executor closure', async (t) => {
  const f = fixture(t);
  f.reopen();
  await f.service().reconcile(f.input);
  const view = f.store().runs(f.project.id)[0]!;
  assert.equal(view.status, 'completed');
  assert.equal(view.taskStatus, 'needs_review');
  assert.equal(view.blocked, false);
  assert.equal(view.turnId, 'turn');
  assert.equal(
    view.snapshot!.items.find((i) => i.role === 'assistant')!.text,
    'authoritative final',
  );
  assert.equal(view.snapshot!.needsSnapshot, false);
});
test('reconciliation never dispatches, resumes or adds a replacement run and is not repeatable after resolution', async (t) => {
  const f = fixture(t, { accepted: true });
  await f.service().reconcile(f.input);
  assert.ok(
    f.calls.every((method) =>
      ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(method),
    ),
  );
  assert.equal(f.store().runs(f.project.id).length, 1);
  await assert.rejects(f.service().reconcile(f.input), /RUN_NOT_RECONCILABLE/);
  const db = new DatabaseSync(f.file, { readOnly: true });
  assert.equal(
    db.prepare("SELECT state FROM execution_intents WHERE kind='turn_start'").get()!.state,
    'reconciled',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspace_write_leases').get()!.n, 0);
  db.close();
});
test('crash without executor closure and unconfirmed server responses remain blocked before any history connection', async (t) => {
  for (const options of [{ closed: false }, { requestUnknown: true }]) {
    const f = fixture(t, options);
    await assert.rejects(
      f.service().reconcile(f.input),
      /EXECUTOR_CLOSURE_UNPROVEN|UNRESOLVED_SERVER_REQUEST/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.store().runs(f.project.id)[0]!.blocked, true);
  }
});
test('wrong scope, ambiguous input, running history, changed snapshots and unsupported projections cannot unblock Unknown', async (t) => {
  for (const mutation of [
    'wrong-cwd',
    'ambiguous',
    'no-match',
    'running',
    'wrong-turn',
    'changed',
    'unsupported',
    'oversized',
    'cursor-loop',
  ]) {
    const f = fixture(t);
    f.mutate(mutation);
    await assert.rejects(f.service().reconcile(f.input));
    const view = f.store().runs(f.project.id)[0]!;
    assert.equal(view.status, 'outcome_unknown');
    assert.equal(view.blocked, true);
  }
});
test('foreign project IDs, paths and extra raw RPC fields fail before history access', async (t) => {
  const f = fixture(t);
  for (const input of [
    { ...f.input, projectId: 'foreign' },
    { ...f.input, path: f.cwd },
    { ...f.input, method: 'turn/start' },
  ])
    await assert.rejects(f.service().reconcile(input));
  assert.equal(f.calls.length, 0);
});

test('a client message ID decides the match: its own ID reconciles, another ID with the same words does not', async (t) => {
  const own = fixture(t);
  own.mutate('own-client');
  await own.service().reconcile(own.input);
  assert.equal(own.store().runs(own.project.id)[0]!.status, 'completed');
  const foreign = fixture(t);
  foreign.mutate('foreign-client');
  await assert.rejects(foreign.service().reconcile(foreign.input), /HISTORY_MATCH_NOT_FOUND/);
  assert.equal(foreign.store().runs(foreign.project.id)[0]!.status, 'outcome_unknown');
});

test('after a crash the Host proves the old executor gone, then reconciles the turn by itself', async (t) => {
  const f = fixture(t, { closed: false, executor: { pid: 424242, marker: 'fixture-marker' } });
  f.reopen();
  let alive = true,
    now = 1000;
  const errors: unknown[] = [];
  const reconciler = new UnknownRunReconciler(f.store(), f.service(), {
    now: () => now,
    processGone: (pid, marker) => {
      assert.equal(pid, 424242);
      assert.equal(marker, 'fixture-marker');
      return !alive;
    },
    onError: (_runId, error) => errors.push(error),
  });
  // Still running: no history read, no change, retried later.
  assert.equal(await reconciler.step(), 0);
  assert.equal(f.calls.length, 0);
  assert.match(String(errors[0]), /EXECUTOR_STILL_RUNNING/);
  assert.equal(await reconciler.step(), 0, 'not due again yet');
  assert.equal(errors.length, 1);
  alive = false;
  now += 30_000;
  assert.equal(await reconciler.step(), 1);
  const view = f.store().runs(f.project.id)[0]!;
  assert.equal(view.status, 'completed');
  assert.equal(view.blocked, false);
  assert.ok(
    f.calls.every((m) => ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(m)),
    'read-only',
  );
  assert.equal(f.store().runs(f.project.id).length, 1, 'nothing resent');
  assert.equal(await reconciler.step(), 0, 'nothing left');
});

test('automatic reconciliation backs off, stops after its limit and skips Runs still executing here', async (t) => {
  const f = fixture(t);
  f.mutate('no-match');
  let now = 0,
    running = true;
  const reconciler = new UnknownRunReconciler(f.store(), f.service(), {
    now: () => now,
    running: () => running,
  });
  assert.equal(await reconciler.step(), 0);
  assert.equal(f.calls.length, 0, 'a Run executing in this process is left alone');
  running = false;
  const delays: number[] = [];
  for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS + 2; attempt++) {
    const before = f.calls.length;
    await reconciler.step();
    if (f.calls.length > before) delays.push(now);
    now += 30 * 60_000;
  }
  assert.equal(delays.length, MAX_RECONCILE_ATTEMPTS);
  assert.equal(f.store().runs(f.project.id)[0]!.status, 'outcome_unknown');
});
