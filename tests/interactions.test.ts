import assert from 'node:assert/strict';
import { legacySchema } from './fixtures/schema-history.ts';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ExecutionLedger, LEDGER_SCHEMA_REVISION } from '../packages/store/src/ledger.ts';
import { InteractionBroker } from '../packages/runtime/src/interactions.ts';
import { SINGLE_RUN_POLICY } from './fixtures/policies.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
function fixture(t: { after(fn: () => void): void }, timeout = 1000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-interactions-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const file = join(root, 'state/store.db'),
    store = new ExecutionLedger(file, schema, { budgetPolicy: SINGLE_RUN_POLICY });
  store.startOwner('interaction-owner', true);
  const project = store.registerWorkspace(workspace);
  const { token } = store.beginRun(project.id, 'interaction fixture', 'key', 'workspaceWrite');
  const start = store.prepare(token, 'thread', 'thread_start', {});
  store.sending(token, start.intentId, 1);
  store.accepted(token, start.intentId, { threadId: 'thread' });
  const turn = store.prepare(token, 'turn', 'turn_start', {}, 'thread');
  store.sending(token, turn.intentId, 1);
  store.accepted(token, turn.intentId, { turnId: 'turn' });
  const broker = new InteractionBroker(store, timeout),
    context = {
      token,
      connectionEpoch: 1,
      projectId: project.id,
      threadId: 'thread',
      turnId: 'turn',
      cwd: workspace,
      canWrite: true,
    };
  const message = {
    id: 7,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'command',
      kind: 'command',
      command: 'node --test',
      cwd: workspace,
      proposedExecpolicyAmendment: ['node'],
    },
  };
  t.after(() => {
    broker.declineAll();
    try {
      store.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    store,
    project,
    token,
    broker,
    context,
    message,
    rows: () => store.requests(project.id, token.runId),
  };
}
test('single approval is persisted before reply and only its exact connection may respond', async (t) => {
  const f = fixture(t),
    pending = f.broker.handle(f.message, f.context),
    request = f.rows()[0]!;
  assert.equal(request.state, 'pending');
  assert.equal(f.store.runs(f.project.id)[0]!.status, 'waiting_approval');
  f.broker.reply(request.requestId, { decision: 'accept' });
  assert.equal(f.rows()[0]!.state, 'responding');
  assert.deepEqual(await pending, { decision: 'accept' });
  f.broker.written(f.message, true, f.context);
  assert.equal(f.rows()[0]!.state, 'responded');
  assert.equal(f.store.runs(f.project.id)[0]!.status, 'running');
  assert.throws(
    () => f.broker.reply(request.requestId, { decision: 'accept' }),
    /STALE_SERVER_REQUEST/,
  );
});
test('read-only grants and session/policy decisions cannot expand approval authority', async (t) => {
  const f = fixture(t),
    pending = f.broker.handle(f.message, { ...f.context, canWrite: false }),
    r = f.rows()[0]!;
  assert.equal(r.canAccept, false);
  assert.throws(
    () => f.broker.reply(r.requestId, { decision: 'accept' }),
    /APPROVAL_SCOPE_BLOCKED/,
  );
  assert.throws(
    () => f.broker.reply(r.requestId, { decision: 'acceptForSession' }),
    /INVALID_APPROVAL_DECISION/,
  );
  f.broker.reply(r.requestId, { decision: 'decline' });
  assert.deepEqual(await pending, { decision: 'decline' });
  f.broker.written(f.message, true, f.context);
});
test('foreign thread/turn, stale connection and unsupported requests do not enter pending state', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.broker.handle(
      { ...f.message, params: { ...f.message.params, turnId: 'foreign' } },
      f.context,
    ),
    /SERVER_REQUEST_SCOPE_MISMATCH/,
  );
  await assert.rejects(
    f.broker.handle(f.message, { ...f.context, connectionEpoch: 2 }),
    /TURN_NOT_BOUND/,
  );
  await assert.rejects(
    f.broker.handle({ ...f.message, method: 'arbitrary/execute' }, f.context),
    /UNSUPPORTED_SERVER_REQUEST/,
  );
  assert.equal(f.rows().length, 0);
});
test('timeout returns a refusal, persists expiry and does not grant a late approval', async (t) => {
  const f = fixture(t, 20),
    pending = f.broker.handle(f.message, f.context),
    r = f.rows()[0]!;
  assert.deepEqual(await pending, { decision: 'decline' });
  assert.equal(f.rows()[0]!.state, 'expired');
  assert.throws(() => f.broker.reply(r.requestId, { decision: 'accept' }), /STALE_SERVER_REQUEST/);
  f.broker.written(f.message, true, f.context);
  assert.equal(f.store.runs(f.project.id)[0]!.status, 'running');
});
test('input answers use question IDs, reject extras and persist only the response hash', async (t) => {
  const f = fixture(t),
    m = {
      ...f.message,
      method: 'item/tool/requestUserInput',
      params: {
        ...f.message.params,
        questions: [
          {
            id: 'choice',
            header: 'Scope',
            question: 'Which fixture?',
            options: [{ label: 'one' }],
            isSecret: false,
          },
        ],
      },
    };
  const pending = f.broker.handle(m, f.context),
    r = f.rows()[0]!;
  assert.throws(
    () => f.broker.reply(r.requestId, { decision: 'accept', answers: { foreign: 'no' } }),
    /INVALID_INPUT_ANSWERS/,
  );
  f.broker.reply(r.requestId, {
    decision: 'accept',
    answers: { choice: 'unique-private-answer-fixture' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    answers: { choice: { answers: ['unique-private-answer-fixture'] } },
  });
  f.broker.written(m, true, f.context);
  const db = new DatabaseSync(f.file, { readOnly: true });
  assert.equal(
    JSON.stringify(db.prepare('SELECT * FROM runtime_requests').all()).includes(
      'unique-private-answer-fixture',
    ),
    false,
  );
  db.close();
});
test('secret questions and files without a trusted diff cannot be silently authorized', async (t) => {
  const f = fixture(t),
    m = {
      ...f.message,
      method: 'item/tool/requestUserInput',
      params: { ...f.message.params, questions: [{ id: 'q', question: 'secret', isSecret: true }] },
    };
  await assert.rejects(f.broker.handle(m, f.context), /INVALID_INPUT_QUESTIONS/);
  const file = {
    ...f.message,
    id: 9,
    method: 'item/fileChange/requestApproval',
    params: { ...f.message.params, grantRoot: '/outside' },
  };
  const pending = f.broker.handle(file, f.context),
    r = f.rows()[0]!;
  assert.equal(r.canAccept, false);
  f.broker.reply(r.requestId, { decision: 'decline' });
  assert.deepEqual(await pending, { decision: 'decline' });
  f.broker.written(file, true, f.context);
});
test('stop blocks acceptance while pending; cancellation still sends a refusal', async (t) => {
  const f = fixture(t),
    pending = f.broker.handle(f.message, f.context),
    r = f.rows()[0]!;
  f.store.block(f.token);
  assert.throws(() => f.broker.reply(r.requestId, { decision: 'accept' }), /RUN_DISPATCH_BLOCKED/);
  f.broker.declineAll();
  assert.deepEqual(await pending, { decision: 'decline' });
  assert.equal(f.rows()[0]!.state, 'cancelled');
});
test('lost response write preserves Unknown and prevents another foreground run', async (t) => {
  const f = fixture(t),
    pending = f.broker.handle(f.message, f.context),
    r = f.rows()[0]!;
  f.broker.reply(r.requestId, { decision: 'accept' });
  await pending;
  f.broker.written(f.message, false, f.context);
  assert.equal(f.rows()[0]!.state, 'outcome_unknown');
  assert.equal(f.store.runs(f.project.id)[0]!.status, 'outcome_unknown');
  assert.throws(() => f.store.beginRun(f.project.id, 'new', 'new', 'readOnly'), /RUNTIME_BUSY/);
});
test('new owner cancels pending requests and the old broker cannot grant them', async (t) => {
  const f = fixture(t),
    pending = f.broker.handle(f.message, f.context),
    r = f.rows()[0]!;
  const next = new ExecutionLedger(f.file, schema);
  next.startOwner('new-owner', true);
  try {
    assert.equal(next.requests(f.project.id, f.token.runId)[0]!.state, 'cancelled');
    assert.throws(
      () => f.broker.reply(r.requestId, { decision: 'accept' }),
      /STALE_RUNTIME_OWNER|RUN_DISPATCH_BLOCKED/,
    );
    f.broker.declineAll();
    assert.deepEqual(await pending, { decision: 'decline' });
  } finally {
    next.close();
  }
});
test('revision 2 migration creates a verified private snapshot including WAL data and preserves old records', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-migration-'))),
    file = join(root, 'store.db');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldSql = legacySchema(schema, 2);
  const old = new DatabaseSync(file);
  old.exec(oldSql);
  old.prepare('INSERT INTO profiles VALUES (?,?,0)').run('legacy', 'retained-wal-record');
  const migrated = new ExecutionLedger(file, schema);
  migrated.close();
  old.close();
  const backups = readdirSync(root).filter((name) => name.endsWith('.backup'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(root, backups[0]!), { readOnly: true });
  assert.equal(
    backup.prepare('SELECT schema_revision FROM schema_metadata').get()!.schema_revision,
    2,
  );
  assert.equal(
    backup.prepare('SELECT display_name FROM profiles').get()!.display_name,
    'retained-wal-record',
  );
  backup.close();
  assert.equal(statSync(join(root, backups[0]!)).mode & 0o777, 0o600);
  const current = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    current.prepare('SELECT schema_revision FROM schema_metadata').get()!.schema_revision,
    LEDGER_SCHEMA_REVISION,
  );
  assert.equal(
    current.prepare('SELECT display_name FROM profiles').get()!.display_name,
    'retained-wal-record',
  );
  assert.ok(current.prepare("SELECT name FROM sqlite_master WHERE name='runtime_requests'").get());
  current.close();
});
