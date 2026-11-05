import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ExecutionLedger, LEDGER_SCHEMA_REVISION } from '../packages/store/src/ledger.ts';
import type { RunToken } from '../packages/store/src/ledger.ts';
import type { ConversationSummary } from '../packages/contracts/src/conversations.ts';
import { DOWNGRADE_TO_REVISION_7 } from './fixtures/schema-history.ts';

const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-conversations-'))),
    file = join(root, 'store.db');
  for (const name of ['a', 'b']) mkdirSync(join(root, name));
  // Generous capacity: the list tests create many conversations; each finishes before the next.
  const store = new ExecutionLedger(file, schema, {
    budgetPolicy: { dailyTokens: 1e9, reservationTokens: 1000, maxActiveRuns: 8 },
  });
  store.startOwner('conversation-owner', true);
  const a = store.registerWorkspace(join(root, 'a')),
    b = store.registerWorkspace(join(root, 'b'));
  t.after(() => {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, store, a, b };
}

let turns = 0;
/** Drives a Run through accepted thread/turn intents and finishes it as completed. */
function complete(store: ExecutionLedger, token: RunToken, threadId: string, resume = false): void {
  const n = ++turns;
  const thread = store.prepare(
    token,
    `thread-${n}`,
    resume ? 'thread_resume' : 'thread_start',
    {},
    resume ? threadId : null,
  );
  store.sending(token, thread.intentId, 1);
  store.accepted(token, thread.intentId, { threadId });
  const turn = store.prepare(token, `turn-${n}`, 'turn_start', {}, threadId);
  store.sending(token, turn.intentId, 1);
  store.accepted(token, turn.intentId, { turnId: `${threadId}-turn-${n}` });
  store.finish(token, 'completed');
}
/** Starts a new conversation and completes its first turn. */
function conversation(store: ExecutionLedger, projectId: string, text: string) {
  const { token } = store.beginRun(projectId, text, `key-${text}`, 'readOnly');
  const threadId = `thread-of-${text}`;
  complete(store, token, threadId);
  return { runId: token.runId, taskId: store.runForHost(token.runId).taskId, threadId };
}
const ids = (rows: ConversationSummary[]) => rows.map((row) => row.conversationId);

test('a long conversation list pages by position and finds any conversation by ID', (t) => {
  const { store, a, b } = fixture(t);
  const made = Array.from({ length: 35 }, (_, i) =>
    conversation(store, a.id, `question ${String(i).padStart(2, '0')}`),
  );
  // Assistant-internal tasks and another project's conversation never show in A's list.
  const hidden = store.beginRun(a.id, 'route this', 'key-hidden', 'readOnly');
  store.prepareRoleTask(hidden.token, 'dot-router');
  store.finish(hidden.token, 'failed');
  const other = conversation(store, b.id, 'elsewhere');

  const first = store.conversations({ projectId: a.id });
  assert.equal(first.pinned.length, 0);
  assert.equal(first.items.length, 30);
  assert.ok(first.nextCursor);
  const second = store.conversations({ projectId: a.id, cursor: first.nextCursor! });
  assert.equal(second.items.length, 5);
  assert.equal(second.nextCursor, null);
  const listed = [...ids(first.items), ...ids(second.items)];
  assert.equal(new Set(listed).size, 35);
  assert.deepEqual(new Set(listed), new Set(made.map((m) => m.taskId)));
  const times = [...first.items, ...second.items].map((row) => row.updatedAt);
  assert.deepEqual(
    times,
    [...times].sort((x, y) => y - x),
    'most recently active first',
  );
  assert.ok(!listed.includes(store.runForHost(hidden.token.runId).taskId));

  // Lookup by ID does not depend on any "latest N" window.
  const oldest = made[0]!;
  const found = store.conversationSummary({ projectId: a.id, conversationId: oldest.taskId });
  assert.equal(found.title, 'question 00');
  assert.equal(found.threadId, oldest.threadId);
  assert.equal(found.turns, 1);
  assert.equal(found.latestRunId, oldest.runId);
  assert.equal(found.status, 'needs_review');
  assert.equal(found.permissionMode, 'readOnly');
  assert.equal(found.model, null);
  assert.throws(
    () => store.conversationSummary({ projectId: a.id, conversationId: other.taskId }),
    /CONVERSATION_NOT_FOUND/,
  );
  assert.throws(
    () =>
      store.conversationSummary({
        projectId: a.id,
        conversationId: store.runForHost(hidden.token.runId).taskId,
      }),
    /CONVERSATION_NOT_FOUND/,
  );
  // The run list no longer carries internal Runs; one Run is still found by ID.
  assert.ok(!store.runs(a.id).some((run) => run.runId === hidden.token.runId));
  assert.equal(store.runs(a.id, { runId: hidden.token.runId })[0]?.runId, hidden.token.runId);

  // Title filter.
  assert.deepEqual(ids(store.conversations({ projectId: a.id, query: 'QUESTION 07' }).items), [
    made[7]!.taskId,
  ]);
  for (const bad of [
    { projectId: a.id, cursor: 'not-a-cursor' },
    { projectId: a.id, archived: 'yes' },
    { projectId: a.id, extra: 1 },
  ])
    assert.throws(() => store.conversations(bad), /INVALID_CONVERSATION/);
});

test('pinned conversations lead the first page; read state follows the last finished turn', (t) => {
  const { store, a } = fixture(t);
  const made = Array.from({ length: 3 }, (_, i) => conversation(store, a.id, `topic ${i}`));
  const oldest = made[0]!.taskId;
  // A finished turn the user has not opened yet.
  assert.equal(store.conversationSummary({ projectId: a.id, conversationId: oldest }).unread, true);
  const pinned = store.updateConversation({
    projectId: a.id,
    conversationId: oldest,
    pinned: true,
    read: true,
  });
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.unread, false);
  const page = store.conversations({ projectId: a.id });
  assert.deepEqual(ids(page.pinned), [oldest]);
  assert.ok(!ids(page.items).includes(oldest));
  assert.equal(page.items.length, 2);
  // Pinning or reading does not move the conversation in the activity order.
  const unpinned = store.updateConversation({
    projectId: a.id,
    conversationId: oldest,
    pinned: false,
  });
  assert.equal(unpinned.pinned, false);
  assert.equal(unpinned.updatedAt, pinned.updatedAt);
  assert.deepEqual(ids(store.conversations({ projectId: a.id }).items).at(-1), oldest);
  assert.throws(
    () => store.updateConversation({ projectId: a.id, conversationId: oldest }),
    /INVALID_CONVERSATION_UPDATE/,
  );
  assert.throws(
    () => store.updateConversation({ projectId: a.id, conversationId: oldest, read: false }),
    /INVALID_CONVERSATION_UPDATE/,
  );
});

test('sixty turns of one conversation page ten at a time, newest first', (t) => {
  const { store, a } = fixture(t);
  const start = conversation(store, a.id, 'long talk');
  let source = start.runId;
  const runIds = [start.runId];
  for (let i = 1; i < 60; i++) {
    const next = store.beginContinuation(a.id, source, `follow-up ${i}`, `follow-${i}`);
    complete(store, next.token, start.threadId, true);
    source = next.token.runId;
    runIds.push(source);
  }
  const summary = store.conversationSummary({ projectId: a.id, conversationId: start.taskId });
  assert.equal(summary.turns, 60);
  assert.equal(summary.latestRunId, source);
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = store.conversationTurns({
      projectId: a.id,
      conversationId: start.taskId,
      ...(cursor ? { cursor } : {}),
    });
    pages++;
    assert.ok(page.items.length <= 10);
    assert.ok(page.items.every((run) => run.taskId === start.taskId));
    seen.push(...page.items.map((run) => run.runId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(pages, 6);
  assert.deepEqual(seen, [...runIds].reverse());
  // The list keeps one row for the whole conversation.
  assert.deepEqual(ids(store.conversations({ projectId: a.id }).items), [start.taskId]);
  assert.throws(
    () => store.conversationTurns({ projectId: a.id, conversationId: start.taskId, cursor: 'x.1' }),
    /INVALID_CONVERSATION_CURSOR/,
  );
});

test('revision 7 migrates to 8 with a verified backup; old tasks become read conversations', (t) => {
  const { root, file, store, a } = fixture(t);
  const readOnly = conversation(store, a.id, 'old question');
  const internal = store.beginRun(a.id, 'old route', 'key-old-route', 'readOnly');
  store.finish(internal.token, 'failed');
  store.close();
  // Rebuild a revision 7 ledger: no conversation columns or indexes; the internal task unmarked
  // (as when its profile failed before marking) and recorded only by a route.
  const db = new DatabaseSync(file);
  const conversationId = db.prepare('SELECT conversation_id FROM conversations').get()
    ?.conversation_id as string | undefined;
  db.exec('PRAGMA foreign_keys=OFF;' + DOWNGRADE_TO_REVISION_7);
  db.exec(
    `UPDATE tasks SET constraints_json=json_set(constraints_json,'$.mode','workspaceWrite') WHERE task_id='${readOnly.taskId}';`,
  );
  const conversationRow = conversationId ?? 'route-conversation';
  if (!conversationId)
    db.exec(`INSERT INTO conversations VALUES ('${conversationRow}','local-dot');`);
  db.exec(`INSERT INTO messages(message_id,conversation_id,dot_id,role,content,content_hash,created_at_ms)
      VALUES ('route-message','${conversationRow}','local-dot','user','old route','h',1);
    INSERT INTO router_decisions VALUES ('route-decision','route-message','main-chat-proposal-v2','{}',
      '${JSON.stringify({ projectId: a.id, route: { routingRunId: internal.token.runId, steps: [] } })}',1);`);
  db.close();
  const migrated = new ExecutionLedger(file, schema);
  try {
    migrated.startOwner('conversation-owner-2', true);
    assert.equal(LEDGER_SCHEMA_REVISION, 8);
    const page = migrated.conversations({ projectId: a.id });
    assert.deepEqual(ids(page.items), [readOnly.taskId], 'the route task stays hidden');
    const row = page.items[0]!;
    assert.equal(row.permissionMode, 'auto', 'a code task maps to the auto permission mode');
    assert.equal(row.unread, false, 'existing conversations count as read');
    assert.equal(row.pinned, false);
    assert.equal(row.archived, false);
    assert.equal(row.turns, 1);
    // Old turns stay readable.
    assert.equal(
      migrated.conversationTurns({ projectId: a.id, conversationId: readOnly.taskId }).items[0]
        ?.runId,
      readOnly.runId,
    );
  } finally {
    migrated.close();
  }
  const check = new DatabaseSync(file);
  try {
    assert.equal(
      check.prepare('SELECT schema_revision AS n FROM schema_metadata').get()!.n,
      LEDGER_SCHEMA_REVISION,
    );
    assert.throws(() => check.exec("UPDATE tasks SET permission_mode='everything'"), /CHECK/);
  } finally {
    check.close();
  }
  const backups = readdirSync(root).filter((name) => /\.revision7-.*\.backup$/.test(name));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(root, backups[0]!), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    assert.equal(backup.prepare('SELECT schema_revision AS n FROM schema_metadata').get()!.n, 7);
  } finally {
    backup.close();
  }
});

test('an archived conversation leaves the list, cannot continue, and comes back when restored', (t) => {
  const { store, a } = fixture(t);
  const kept = conversation(store, a.id, 'keep me'),
    old = conversation(store, a.id, 'put me away');
  store.updateConversation({ projectId: a.id, conversationId: old.taskId, pinned: true });
  const check = store.conversationArchiveCheck({
    projectId: a.id,
    conversationId: old.taskId,
    archived: true,
  });
  assert.equal(check.threadId, old.threadId);
  const archived = store.setConversationArchived(a.id, old.taskId, true);
  assert.equal(archived.archived, true);
  assert.equal(archived.pinned, false, 'archiving unpins');
  const page = store.conversations({ projectId: a.id });
  assert.deepEqual(ids([...page.pinned, ...page.items]), [kept.taskId]);
  assert.deepEqual(ids(store.conversations({ projectId: a.id, archived: true }).items), [
    old.taskId,
  ]);
  assert.throws(
    () => store.beginContinuation(a.id, old.runId, 'one more', 'archived-continue'),
    /CONVERSATION_ARCHIVED/,
  );
  assert.throws(
    () => store.updateConversation({ projectId: a.id, conversationId: old.taskId, pinned: true }),
    /CONVERSATION_ARCHIVED/,
  );
  const restored = store.setConversationArchived(a.id, old.taskId, false);
  assert.equal(restored.archived, false);
  assert.equal(store.beginContinuation(a.id, old.runId, 'one more', 'restored').created, true);
  // A conversation with a turn running cannot be archived.
  assert.throws(
    () =>
      store.conversationArchiveCheck({
        projectId: a.id,
        conversationId: old.taskId,
        archived: true,
      }),
    /CONVERSATION_RUNNING/,
  );
  assert.throws(
    () => store.conversationArchiveCheck({ projectId: a.id, conversationId: old.taskId }),
    /INVALID_CONVERSATION_UPDATE/,
  );
});
