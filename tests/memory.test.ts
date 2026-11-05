import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { DomainContextSources } from '../packages/store/src/context-sources.ts';
import { buildTaskContext } from '../packages/runtime/src/context.ts';
import { MemoryLedger, applyMemoryTombstones } from '../packages/store/src/memory.ts';
import type { MemoryClaimInput, MemoryEntrySnapshot } from '../packages/store/src/memory.ts';

const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8'),
  hash = (s: string) => createHash('sha256').update(s).digest('hex');
// Public metadata fixtures in actual SQLite files. Synthetic Owner/Run/grant
// rows are not a real model, process, connector identity verification or lease.
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'personal-agent-memory-')),
    file = join(root, 'ledger.db'),
    db = new DatabaseSync(file);
  db.exec(schema);
  db.prepare('INSERT INTO profiles VALUES (?,?,?)').run('profile', 'Public profile', Date.now());
  db.prepare("INSERT INTO runtime_owners VALUES ('profile',1,'owner','main','ready',?)").run(
    Date.now(),
  );
  db.prepare("INSERT INTO dots VALUES ('dot','profile','Public dot',1,1)").run();
  db.prepare("INSERT INTO conversations VALUES ('conversation','dot')").run();
  db.prepare(
    "INSERT INTO sources VALUES ('connector','dot','connector','public-connection-v1','{}',1)",
  ).run();
  const fail = (code: string): never => {
    throw Error(code);
  };
  let calls = 0;
  const host = {
    owner() {
      calls++;
      if (
        db.prepare("SELECT state,instance_id FROM runtime_owners WHERE profile_id='profile'").get()
          ?.state !== 'ready'
      )
        fail('STALE_RUNTIME_OWNER');
    },
    transaction<T>(body: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = body();
        db.exec('COMMIT');
        return value;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const memory = new MemoryLedger(db, 'dot', fail, host);
  let sequence = 0;
  const message = (
    body: string,
    id = 'message-' + ++sequence,
    role = 'user',
    revision = 'main-chat-rules-v1',
  ) => {
    db.prepare("INSERT INTO messages VALUES (?,'conversation','dot',?,?,?,'decided',?,NULL)").run(
      id,
      role,
      body,
      hash(body),
      Date.now(),
    );
    db.prepare("INSERT INTO router_decisions VALUES (?,?,?,'[]','{}',?)").run(
      'decision-' + id,
      id,
      revision,
      Date.now(),
    );
    return id;
  };
  const capture = (body: string, id?: string) => memory.captureUser(message(body, id));
  const input = (
    entry: MemoryEntrySnapshot,
    extra: Partial<MemoryClaimInput> = {},
  ): MemoryClaimInput => ({
    entryId: entry.entryId,
    expectedPrivacyEpoch: entry.privacyEpoch,
    expectedPolicyEpoch: entry.policyEpoch,
    factKey: 'personal:language',
    factText: '中文',
    quote: '中文',
    trust: 'explicit_user',
    ...extra,
  });
  const external = (body = 'External says English', revision = '1') =>
    memory.captureExternal({
      sourceId: 'connector',
      sourceRef: 'public-event-' + revision,
      sourceRevision: revision,
      content: body,
      sensitivity: 'public',
    });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    file,
    root,
    memory,
    message,
    capture,
    input,
    external,
    fail,
    host,
    ownerCalls: () => calls,
  };
}

test('real same-database Entry, exact evidence, explicit Claim and derived graph commit idempotently', (t) => {
  const f = fixture(t),
    id = f.message('/remember personal:language = 中文'),
    entry = f.memory.captureUser(id),
    claim = f.memory.commitClaim(f.input(entry));
  assert.deepEqual(f.memory.captureUser(id), entry);
  assert.deepEqual(f.memory.commitClaim(f.input(entry)), claim);
  assert.equal(claim.trust, 'explicit_user');
  assert.equal(claim.status, 'active');
  assert.equal(claim.evidence[0]!.quoteHash, hash('中文'));
  assert.equal(claim.evidence[0]!.sourceRef, 'message:' + id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_entries').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_claims').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM claim_evidence').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM derivation_edges').get()!.n, 2);
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM outbox_events WHERE event_type='memory_claim_changed'")
      .get()!.n,
    1,
  );
  assert.equal(f.memory.search({ query: '中文' })[0]!.claimId, claim.claimId);
  for (const table of ['task_runs', 'execution_intents', 'approval_receipts'])
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n, 0);
});
test('forgetting notification derivations erases summaries while preserving stable hashes and delivered or Unknown transport facts', (t) => {
  const f = fixture(t),
    entry = f.capture('PUBLIC_NOTIFICATION_ORIGIN');
  const states = ['completed', 'outcome_unknown', 'executing', 'pending'] as const;
  for (const [index, state] of states.entries()) {
    const operationId = 'notice-' + index,
      messageId = f.message('PUBLIC_NOTICE_' + index, 'notice-message-' + index, 'system_event'),
      decision = String(
        f.db.prepare('SELECT decision_id FROM router_decisions WHERE message_id=?').get(messageId)!
          .decision_id,
      ),
      input = {
        goalId: 'public-goal',
        key: 'stable-' + index,
        kind: 'result',
        privacyEpoch: 1,
        summary: 'PUBLIC_NOTICE_' + index,
        sourceRefs: [{ ref: entry.sourceRef, revision: entry.sourceRevision }],
      },
      receipt = {
        state:
          state === 'completed' ? 'delivered' : state === 'outcome_unknown' ? 'unknown' : 'sending',
        providerRef: state === 'completed' ? 'public-provider-receipt' : null,
        claimId: 'public-claim',
        runtimeEpoch: 1,
        day: 1,
      };
    f.db
      .prepare("INSERT INTO operations VALUES (?,?,0,NULL,'GOAL_NOTIFICATION',?,NULL,?,?,?)")
      .run(
        operationId,
        decision,
        state,
        JSON.stringify(input),
        'original-stable-hash-' + index,
        JSON.stringify(receipt),
      );
    f.db
      .prepare('INSERT INTO derivation_edges VALUES (?,?,?,?,1)')
      .run('dot', entry.sourceRef, 'notification:' + operationId, entry.sourceRevision);
  }
  f.memory.forget({ sourceRefs: [entry.sourceRef], expectedPrivacyEpoch: 1 });
  for (const [index, state] of states.entries()) {
    const row = f.db
        .prepare('SELECT * FROM operations WHERE operation_id=?')
        .get('notice-' + index)!,
      input = JSON.parse(String(row.input_json)),
      receipt = JSON.parse(String(row.result_ref));
    assert.equal(input.goalId, 'public-goal');
    assert.equal(input.key, 'stable-' + index);
    assert.equal(input.kind, 'result');
    assert.equal(input.privacyEpoch, 1);
    assert.equal(input.summary, '');
    assert.deepEqual(input.sourceRefs, []);
    assert.equal(input.redacted, true);
    assert.equal(row.input_hash, 'original-stable-hash-' + index);
    assert.equal(
      row.state,
      state === 'executing' ? 'outcome_unknown' : state === 'pending' ? 'cancelled' : state,
    );
    assert.equal(receipt.providerRef, state === 'completed' ? 'public-provider-receipt' : null);
    assert.equal(receipt.claimId, 'public-claim');
    assert.equal(
      receipt.state,
      state === 'completed' ? 'delivered' : state === 'pending' ? 'cancelled' : 'unknown',
    );
  }
});
test('explicit-user trust requires real main-chat user provenance and an exact key/value memory command', (t) => {
  const f = fixture(t),
    ordinary = f.capture('/note I use 中文');
  assert.throws(() => f.memory.commitClaim(f.input(ordinary)), /MEMORY_EXPLICIT_USER_REQUIRED/);
  assert.throws(
    () => f.memory.commitClaim(f.input(f.capture('/remember personal:other = 中文'))),
    /MEMORY_EXPLICIT_USER_REQUIRED/,
  );
  assert.throws(
    () =>
      f.memory.commitClaim(f.input(f.capture('/remember personal:language = 中文 and English'))),
    /MEMORY_EXPLICIT_USER_REQUIRED/,
  );
  assert.throws(
    () => f.memory.commitClaim(f.input(ordinary, { quote: 'not in source' })),
    /MEMORY_EVIDENCE_MISMATCH/,
  );
  assert.equal(
    f.memory.commitClaim(f.input(ordinary, { trust: 'agent_inference' })).trust,
    'agent_inference',
  );
  for (const [role, revision] of [
    ['assistant', 'main-chat-rules-v1'],
    ['user', 'desktop-command-v1'],
    ['user', 'model-control-run'],
    ['system_event', 'main-chat-rules-v1'],
  ])
    assert.throws(
      () =>
        f.memory.captureUser(
          f.message('/remember personal:language = 中文', undefined, role, revision),
        ),
      /MEMORY_SOURCE_UNAVAILABLE/,
    );
});
test('external data never upgrades into user or verified trust and cannot grant tool authority', (t) => {
  const f = fixture(t),
    entry = f.external();
  for (const trust of ['explicit_user', 'verified_connector', 'agent_inference'] as const)
    assert.throws(
      () => f.memory.commitClaim(f.input(entry, { factText: 'English', quote: 'English', trust })),
      /MEMORY_TRUST_ESCALATION/,
    );
  const claim = f.memory.commitClaim(
    f.input(entry, { factText: 'English', quote: 'English', trust: 'untrusted_external' }),
  );
  assert.equal(claim.trust, 'untrusted_external');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM mandates').get()!.n, 0);
  assert.throws(
    () =>
      f.memory.captureExternal({
        sourceId: 'connector',
        sourceRef: 'public-event-1',
        sourceRevision: '1',
        content: 'External says English',
        sensitivity: 'private',
      }),
    /MEMORY_SOURCE_CHANGED/,
  );
  assert.equal(JSON.stringify(claim).includes('public-connection'), false);
});
test('explicit correction uses Claim CAS/version/supersedes and wins over old inference', (t) => {
  const f = fixture(t),
    old = f.memory.commitClaim(
      f.input(f.capture('I might use English'), {
        factText: 'English',
        quote: 'English',
        trust: 'agent_inference',
      }),
    ),
    entry = f.capture('/remember personal:language = 中文'),
    change = f.input(entry, { supersedesClaimId: old.claimId, expectedVersion: old.version });
  assert.throws(
    () => f.memory.commitClaim({ ...change, expectedVersion: 99 }),
    /MEMORY_CLAIM_VERSION_CONFLICT/,
  );
  const revised = f.memory.commitClaim(change);
  assert.equal(revised.version, 2);
  assert.equal(revised.status, 'active');
  assert.equal(
    f.db
      .prepare('SELECT supersedes_claim_id FROM memory_claims WHERE claim_id=?')
      .get(revised.claimId)!.supersedes_claim_id,
    old.claimId,
  );
  assert.equal(
    f.db.prepare('SELECT status FROM memory_claims WHERE claim_id=?').get(old.claimId)!.status,
    'superseded',
  );
  assert.deepEqual(f.memory.commitClaim(change), revised);
  assert.throws(
    () => f.memory.commitClaim({ ...change, expectedVersion: 99 }),
    /MEMORY_CLAIM_VERSION_CONFLICT/,
  );
  const lower = f.capture('English maybe');
  assert.throws(
    () =>
      f.memory.commitClaim(
        f.input(lower, {
          factText: 'English',
          quote: 'English',
          trust: 'agent_inference',
          supersedesClaimId: revised.claimId,
          expectedVersion: revised.version,
        }),
      ),
    /MEMORY_TRUST_ESCALATION/,
  );
  assert.deepEqual(
    f.memory.search({ query: '' }).map((c) => c.factText),
    ['中文'],
  );
});
test('conflicting external facts are disputed without overwriting explicit user preferences', (t) => {
  const f = fixture(t),
    user = f.memory.commitClaim(f.input(f.capture('/remember personal:language = 中文'))),
    external = f.memory.commitClaim(
      f.input(f.external(), { factText: 'English', quote: 'English', trust: 'untrusted_external' }),
    );
  assert.equal(external.status, 'disputed');
  assert.equal(
    f.db.prepare('SELECT status FROM memory_claims WHERE claim_id=?').get(user.claimId)!.status,
    'active',
  );
  assert.equal(f.memory.search({ query: '', includeDisputed: true }).length, 2);
  assert.equal(f.memory.search({ query: '' }).length, 1);
});
test('search applies validity, domain, literal keyword, dispute and private Coding Memory filters', (t) => {
  const f = fixture(t),
    now = Date.now();
  f.memory.commitClaim(f.input(f.capture('/remember personal:language = 中文')));
  for (const [key, from, until] of [
    ['personal:future', now + 100000, undefined],
    ['personal:expired', undefined, now - 1000],
  ] as const) {
    const value = 'Public ' + key;
    f.memory.commitClaim(
      f.input(f.capture('/remember ' + key + ' = ' + value), {
        factKey: key,
        factText: value,
        quote: value,
        validFromMs: from,
        validUntilMs: until,
      }),
    );
  }
  const literal = f.memory.commitClaim(
    f.input(f.capture('/remember personal:literal = 100%_ready'), {
      factKey: 'personal:literal',
      factText: '100%_ready',
      quote: '100%_ready',
    }),
  );
  assert.deepEqual(
    f.memory.search({ query: '%_' }).map((c) => c.claimId),
    [literal.claimId],
  );
  assert.equal(f.memory.search({ query: 'Public' }).length, 0);
  const external = f.external('public coding lesson', 'coding');
  assert.equal(
    f.memory.commitClaim(
      f.input(external, {
        factKey: 'coding:lesson',
        factText: 'coding lesson',
        quote: 'coding lesson',
        trust: 'untrusted_external',
      }),
    ).factKey,
    'coding:lesson',
  );
  assert.equal(f.memory.search({ query: '', domain: 'coding' }).length, 1);
  assert.throws(
    () =>
      f.memory.commitClaim(
        f.input(f.capture('/remember coding:private = secret'), {
          factKey: 'coding:private',
          factText: 'secret',
          quote: 'secret',
        }),
      ),
    /PRIVATE_CODING_MEMORY_REJECTED/,
  );
});
test('Source cursor, identity, disabled/revoked state, message revision and Epoch changes reject stale commits', (t) => {
  const f = fixture(t);
  for (const sql of [
    "UPDATE sources SET cursor_json='{\"revision\":2}' WHERE source_id='connector'",
    "UPDATE sources SET identity_binding_ref='new-binding' WHERE source_id='connector'",
    "UPDATE sources SET enabled=0 WHERE source_id='connector'",
  ]) {
    const entry = f.external('English', sql);
    f.db.exec(sql);
    assert.throws(
      () =>
        f.memory.commitClaim(
          f.input(entry, { factText: 'English', quote: 'English', trust: 'untrusted_external' }),
        ),
      /MEMORY_SOURCE_CHANGED|MEMORY_SOURCE_REVOKED/,
    );
    f.db.exec(
      "UPDATE sources SET enabled=1,cursor_json='{}',identity_binding_ref='public-connection-v1' WHERE source_id='connector'",
    );
  }
  const entry = f.capture('/remember personal:language = 中文');
  f.db.exec('UPDATE dots SET policy_epoch=2');
  assert.throws(() => f.memory.commitClaim(f.input(entry)), /MEMORY_SOURCE_CHANGED/);
  f.db.exec('UPDATE dots SET policy_epoch=1');
  f.db
    .prepare("UPDATE messages SET content='changed',content_hash=? WHERE message_id=?")
    .run(hash('changed'), entry.sourceRef.slice('message:'.length));
  assert.throws(() => f.memory.commitClaim(f.input(entry)), /MEMORY_SOURCE_CHANGED/);
});
test('a second connection deleting after extraction cannot be undone by old or refreshed-epoch submissions', (t) => {
  const f = fixture(t),
    entry = f.capture('/remember personal:language = 中文'),
    second = new DatabaseSync(f.file);
  second.exec('PRAGMA foreign_keys=ON');
  try {
    second.exec('BEGIN IMMEDIATE');
    second
      .prepare('INSERT INTO privacy_tombstones VALUES (?,?,2,?)')
      .run('dot', entry.sourceRef, Date.now());
    second.exec("UPDATE dots SET privacy_epoch=2,policy_epoch=2 WHERE dot_id='dot'");
    applyMemoryTombstones(second, 'dot', f.fail);
    second.exec('COMMIT');
  } finally {
    second.close();
  }
  assert.throws(() => f.memory.commitClaim(f.input(entry)), /MEMORY_SOURCE_CHANGED/);
  assert.throws(
    () => f.memory.commitClaim(f.input(entry, { expectedPrivacyEpoch: 2, expectedPolicyEpoch: 2 })),
    /MEMORY_SOURCE_REVOKED/,
  );
  assert.equal(f.memory.search({ query: '' }).length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_claims').get()!.n, 0);
});
test('failed Claim revision rolls back superseding, evidence, graph and change Outbox together', (t) => {
  const f = fixture(t),
    old = f.memory.commitClaim(
      f.input(f.capture('/remember personal:language = English'), {
        factText: 'English',
        quote: 'English',
      }),
    ),
    entry = f.capture('/remember personal:language = 中文'),
    before = f.db.prepare('SELECT count(*) AS n FROM outbox_events').get()!.n;
  f.db.exec(
    "CREATE TRIGGER reject_new_memory BEFORE INSERT ON memory_claims BEGIN SELECT RAISE(ABORT,'public controlled failure'); END",
  );
  assert.throws(
    () =>
      f.memory.commitClaim(
        f.input(entry, { supersedesClaimId: old.claimId, expectedVersion: old.version }),
      ),
    /public controlled failure/,
  );
  assert.equal(
    f.db.prepare('SELECT status FROM memory_claims WHERE claim_id=?').get(old.claimId)!.status,
    'active',
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_claims').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM claim_evidence').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM outbox_events').get()!.n, before);
});

function executionMetadata(f: ReturnType<typeof fixture>, marker: string) {
  const d = f.db;
  d.exec(
    "INSERT INTO projects VALUES ('project','dot','/public/repository','Public project'); INSERT INTO workspaces VALUES ('workspace','project','dot','/public/repository','main','busy',1)",
  );
  d.prepare(
    "INSERT INTO goals(goal_id,dot_id,title,objective,status,constraints_json,criteria_json) VALUES ('goal','dot',?,?,'active',?,?)",
  ).run(marker, marker, JSON.stringify({ private: marker }), JSON.stringify([marker]));
  d.prepare(
    "INSERT INTO tasks(task_id,dot_id,goal_id,workspace_id,title,summary,constraints_json,status,created_at_ms,updated_at_ms) VALUES ('task','dot','goal','workspace',?,?,?,'running',?,?)",
  ).run(
    marker,
    marker,
    JSON.stringify({ mode: 'readOnly', text: marker, promptModuleContent: marker }),
    Date.now(),
    Date.now(),
  );
  d.prepare(
    "INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,goal_plan_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES ('run','task','dot','run-key','codex','running',1,1,1,1,1,1,'synthetic-worker',?,?)",
  ).run(Date.now() + 10000, Date.now());
  d.exec(
    "INSERT INTO workspace_write_leases VALUES ('workspace','run',1,9999999999999); INSERT INTO thread_bindings VALUES ('binding','task','codex','execution-thread',1,1,'active',NULL)",
  );
  d.prepare(
    "INSERT INTO prompt_manifests VALUES ('manifest','run','coding','read-only',?,'public-tool-hash',1,1,?,NULL)",
  ).run(
    JSON.stringify({ publicModule: marker }),
    JSON.stringify([{ ref: 'private-source', content: marker }]),
  );
  d.prepare("INSERT INTO task_checkpoints VALUES ('checkpoint','task','run',1,1,?,?)").run(
    JSON.stringify({ summary: marker }),
    hash(marker),
  );
  d.prepare(
    "INSERT INTO artifacts VALUES ('artifact','dot','task',?,'public/receipt.json','published','private',1,10,NULL)",
  ).run(hash(marker));
  d.exec(
    "INSERT INTO mandates VALUES ('mandate','task',NULL,1,'[\"public-tool\"]','user','active',NULL); INSERT INTO subscriptions VALUES ('subscription','task','connector','dot','public-thread','wake','[]','active')",
  );
  d.exec(
    "INSERT INTO schedules VALUES ('schedule','task',1,'once','{}','UTC','active','skip','skip',1,9999999999999,NULL)",
  );
  d.prepare(
    "INSERT INTO actions VALUES ('action','task','run',NULL,'action-key','public-capability',?,?,1,1,1,NULL,'approved',NULL,NULL,NULL,NULL)",
  ).run(JSON.stringify({ body: marker }), hash(marker));
  d.exec(
    "INSERT INTO approval_receipts VALUES ('approval','action','public-hash','user',9999999999999,1,'granted'); UPDATE actions SET approval_receipt_id='approval'",
  );
  d.exec(
    "INSERT INTO execution_intents(intent_id,run_id,intent_key,kind,state,input_hash,created_at_ms) VALUES ('intent','run','intent-key','thread_start','prepared','public-hash',1)",
  );
  d.exec(
    "INSERT INTO budget_buckets VALUES ('bucket','dot','goal','tokens',1,9999999999999,1000,100,20); INSERT INTO budget_reservations VALUES ('reservation','bucket','run',100,'held_unknown',NULL,NULL)",
  );
  d.prepare("INSERT INTO episodes VALUES ('episode','conversation',?,?,1,1,0,?)").run(
    marker,
    marker,
    hash(marker),
  );
  const pendingMessage = f.message('/query', 'pending-question');
  d.prepare(
    "INSERT INTO pending_interactions VALUES ('pending-choice','dot',?,NULL,'clarification','pending',NULL,?,9999999999999)",
  ).run(
    pendingMessage,
    JSON.stringify({
      source: 'main-chat-rules-v1',
      choices: [{ taskId: 'task', title: marker, version: 1 }],
    }),
  );
  d.prepare(
    "INSERT INTO outbox_events(outbox_id,dedupe_key,event_type,aggregate_ref,payload_json,state) VALUES ('delivered','delivered','task_result','task',?,'delivered')",
  ).run(JSON.stringify({ summary: marker }));
}
test('forget traverses injected manifests and all associated local text while revoking dispatch without inventing process exit', (t) => {
  const f = fixture(t),
    marker = 'PUBLIC_ERASURE_MARKER_甲',
    entry = f.capture('/remember personal:language = ' + marker),
    claim = f.memory.commitClaim(f.input(entry, { factText: marker, quote: marker }));
  executionMetadata(f, marker);
  // The real Host currently identifies manifests by Run ID and threads by its
  // binding ID. Both canonical manifest ID and Run-ID alias are covered.
  f.memory.addDerivation({
    sourceRef: 'claim:' + claim.claimId,
    derivedRef: 'manifest:run',
    sourceRevision: String(claim.version),
    expectedPrivacyEpoch: 1,
    expectedPolicyEpoch: 1,
  });
  f.memory.addDerivation({
    sourceRef: entry.sourceRef,
    derivedRef: 'episode:episode',
    sourceRevision: hash('/remember personal:language = ' + marker),
    expectedPrivacyEpoch: 1,
    expectedPolicyEpoch: 1,
  });
  const beforeLease = { ...f.db.prepare('SELECT * FROM workspace_write_leases').get() },
    beforeReservation = { ...f.db.prepare('SELECT * FROM budget_reservations').get() },
    result = f.memory.forget({ sourceRefs: [entry.sourceRef], expectedPrivacyEpoch: 1 });
  assert.equal(result.privacyEpoch, 2);
  assert.equal(result.policyEpoch, 2);
  assert.deepEqual(result.blockedRunIds, ['run']);
  assert.deepEqual(result.artifactKeys, ['public/receipt.json']);
  assert.ok(result.affectedRefs.includes('manifest:manifest'));
  assert.ok(result.affectedRefs.includes('thread:binding'));
  assert.equal(
    f.db.prepare("SELECT status FROM task_runs WHERE run_id='run'").get()!.status,
    'running',
  );
  assert.deepEqual({ ...f.db.prepare('SELECT * FROM workspace_write_leases').get() }, beforeLease);
  assert.deepEqual(
    { ...f.db.prepare('SELECT * FROM budget_reservations').get() },
    beforeReservation,
  );
  assert.equal(
    f.db.prepare("SELECT dispatch_blocked FROM tasks WHERE task_id='task'").get()!.dispatch_blocked,
    1,
  );
  assert.equal(
    f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
    'invalidated',
  );
  assert.equal(f.db.prepare('SELECT state FROM approval_receipts').get()!.state, 'revoked');
  assert.equal(f.db.prepare('SELECT state FROM mandates').get()!.state, 'revoked');
  assert.equal(f.db.prepare('SELECT state FROM subscriptions').get()!.state, 'cancelled');
  assert.equal(f.db.prepare('SELECT state FROM schedules').get()!.state, 'paused');
  assert.equal(f.db.prepare('SELECT state FROM execution_intents').get()!.state, 'rejected');
  assert.equal(f.db.prepare('SELECT state FROM artifacts').get()!.state, 'deleting');
  for (const table of [
    'messages',
    'memory_entries',
    'memory_claims',
    'episodes',
    'task_checkpoints',
    'prompt_manifests',
    'tasks',
    'goals',
    'actions',
    'pending_interactions',
    'outbox_events',
  ])
    assert.equal(
      JSON.stringify(f.db.prepare('SELECT * FROM ' + table).all()).includes(marker),
      false,
      table,
    );
  assert.equal(
    f.db.prepare("SELECT state FROM outbox_events WHERE outbox_id='delivered'").get()!.state,
    'delivered',
  );
  assert.equal(f.memory.search({ query: '' }).length, 0);
  assert.throws(
    () => f.memory.captureUser(entry.sourceRef.slice('message:'.length)),
    /MEMORY_SOURCE_UNAVAILABLE/,
  );
  const replay = f.host.transaction(() => applyMemoryTombstones(f.db, 'dot', f.fail));
  assert.equal(replay.privacyEpoch, 2);
  assert.equal(f.memory.search({ query: marker }).length, 0);
  assert.deepEqual(f.memory.compact(), {
    databaseCompacted: true,
    sqliteWalTruncated: true,
    externalCopies: 'not_controlled',
  });
  for (const suffix of ['', '-wal'])
    if (existsSync(f.file + suffix))
      assert.equal(
        readFileSync(f.file + suffix).includes(Buffer.from(marker)),
        false,
        'physical SQLite ' + suffix,
      );
});
test('restored old memory is scrubbed after current tombstones are merged, without starting any Owner', (t) => {
  const f = fixture(t),
    entry = f.capture('/remember personal:language = 中文');
  f.memory.commitClaim(f.input(entry));
  f.host.transaction(() => {
    f.db
      .prepare('INSERT INTO privacy_tombstones VALUES (?,?,5,?)')
      .run('dot', entry.sourceRef, Date.now());
    f.db.exec('UPDATE dots SET privacy_epoch=5,policy_epoch=7');
    const out = applyMemoryTombstones(f.db, 'dot', f.fail);
    assert.equal(out.privacyEpoch, 5);
    assert.equal(out.policyEpoch, 7);
  });
  assert.equal(f.db.prepare('SELECT fact_text FROM memory_claims').get()!.fact_text, '');
  assert.equal(f.db.prepare('SELECT content FROM messages').get()!.content, '');
  assert.equal(f.db.prepare('SELECT runtime_epoch FROM runtime_owners').get()!.runtime_epoch, 1);
});
test('legacy raw Task tombstones reach the same deletion closure on old backup metadata', (t) => {
  const f = fixture(t);
  executionMetadata(f, 'PUBLIC_OLD_BACKUP');
  f.host.transaction(() => {
    f.db.prepare('INSERT INTO privacy_tombstones VALUES (?,?,4,?)').run('dot', 'task', Date.now());
    f.db.exec('UPDATE dots SET privacy_epoch=4,policy_epoch=4');
    const result = applyMemoryTombstones(f.db, 'dot', f.fail);
    assert.ok(result.affectedRefs.includes('task:task'));
    assert.deepEqual(result.blockedRunIds, ['run']);
  });
  assert.equal(
    f.db.prepare("SELECT constraints_json FROM tasks WHERE task_id='task'").get()!.constraints_json,
    '{"mode":"readOnly","privacyRevoked":true}',
  );
});
test('Task-domain claims retain Task provenance and disappear when that Task is deleted', (t) => {
  const f = fixture(t);
  f.db
    .prepare(
      "INSERT INTO tasks(task_id,dot_id,title,status,created_at_ms,updated_at_ms) VALUES ('task','dot','Public task','created',1,1)",
    )
    .run();
  const entry = f.capture('/remember task:task:constraint = Public temporary limit'),
    claim = f.memory.commitClaim(
      f.input(entry, {
        factKey: 'task:task:constraint',
        factText: 'Public temporary limit',
        quote: 'Public temporary limit',
      }),
    );
  assert.equal(f.memory.search({ query: '', domain: 'task' })[0]!.claimId, claim.claimId);
  f.memory.forget({ sourceRefs: ['task:task'], expectedPrivacyEpoch: 1 });
  assert.equal(f.memory.search({ query: '', domain: 'task' }).length, 0);
  assert.equal(
    f.db.prepare('SELECT status FROM memory_claims WHERE claim_id=?').get(claim.claimId)!.status,
    'deleted',
  );
});
test('forget rollback is atomic and cross-Dot source/derivation access is rejected', (t) => {
  const f = fixture(t),
    entry = f.capture('/remember personal:language = 中文');
  f.memory.commitClaim(f.input(entry));
  f.db.exec(
    "CREATE TRIGGER reject_memory_delete BEFORE UPDATE ON memory_entries BEGIN SELECT RAISE(ABORT,'public delete failure'); END",
  );
  assert.throws(
    () => f.memory.forget({ sourceRefs: [entry.sourceRef], expectedPrivacyEpoch: 1 }),
    /public delete failure/,
  );
  assert.equal(f.db.prepare('SELECT privacy_epoch FROM dots').get()!.privacy_epoch, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM privacy_tombstones').get()!.n, 0);
  assert.equal(f.memory.search({ query: '中文' }).length, 1);
  f.db.exec(
    "INSERT INTO dots VALUES ('foreign','profile','Other dot',1,1); INSERT INTO conversations VALUES ('foreign-conversation','foreign'); INSERT INTO messages VALUES ('foreign-message','foreign-conversation','foreign','user','PUBLIC_OTHER_DOT','public-hash','decided',1,NULL)",
  );
  assert.throws(() => f.memory.captureUser('foreign-message'), /MEMORY_SCOPE_MISMATCH/);
  assert.throws(
    () => f.memory.forget({ sourceRefs: ['message:foreign-message'], expectedPrivacyEpoch: 1 }),
    /MEMORY_SCOPE_MISMATCH/,
  );
  assert.equal(
    f.db.prepare("SELECT content FROM messages WHERE message_id='foreign-message'").get()!.content,
    'PUBLIC_OTHER_DOT',
  );
});
test('Owner rejection and bounded invalid input leave memory unchanged', (t) => {
  const f = fixture(t);
  for (const input of [
    { query: 'x', limit: 101 },
    { query: 'x', path: '/private' },
    { query: 'x\0secret' },
  ])
    assert.throws(() => f.memory.search(input as { query: string }), /INVALID_MEMORY_QUERY/);
  assert.throws(
    () => f.memory.forget({ sourceRefs: [], expectedPrivacyEpoch: 1 }),
    /INVALID_MEMORY_FORGET/,
  );
  assert.throws(
    () => f.memory.forget({ sourceRefs: ['message:unknown'], expectedPrivacyEpoch: 0 }),
    /MEMORY_SOURCE_CHANGED/,
  );
  const id = f.message('/remember personal:language = 中文');
  f.db.exec("UPDATE runtime_owners SET state='stopped'");
  for (const operation of [
    () => f.memory.captureUser(id),
    () => f.memory.search({ query: '' }),
    () => f.memory.forget({ sourceRefs: ['message:' + id], expectedPrivacyEpoch: 1 }),
    () => f.memory.compact(),
  ])
    assert.throws(operation, /STALE_RUNTIME_OWNER/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_entries').get()!.n, 0);
  assert.ok(f.ownerCalls() > 0);
});
test('physical cleanup reports busy readers rather than claiming SQLite erasure completed', (t) => {
  const f = fixture(t),
    entry = f.capture('/remember personal:language = PUBLIC_BUSY_MARKER');
  f.memory.commitClaim(
    f.input(entry, { factText: 'PUBLIC_BUSY_MARKER', quote: 'PUBLIC_BUSY_MARKER' }),
  );
  const reader = new DatabaseSync(f.file);
  f.db.exec('PRAGMA busy_timeout=20');
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM memory_entries').all();
    f.memory.forget({ sourceRefs: [entry.sourceRef], expectedPrivacyEpoch: 1 });
    assert.throws(() => f.memory.compact(), /MEMORY_CLEANUP_BUSY/);
    reader.exec('COMMIT');
    assert.equal(f.memory.compact().databaseCompacted, true);
  } finally {
    reader.close();
  }
});
test('notification and operation aliases erase local payload copies but preserve sent and unknown transport facts and hashes', (t) => {
  const f = fixture(t),
    marker = 'PUBLIC_NOTIFICATION_ERASURE_MARKER',
    entry = f.capture('/remember personal:language = ' + marker),
    claim = f.memory.commitClaim(f.input(entry, { factText: marker, quote: marker }));
  for (const [id, state] of [
    ['notice-sent', 'completed'],
    ['notice-unknown', 'outcome_unknown'],
    ['notice-sending', 'executing'],
  ] as const) {
    const body = JSON.stringify({ summary: marker, sourceRefs: [entry.sourceRef] }),
      messageId = f.message(body, 'notification-message-' + id, 'system_event', 'goal-domain-v1'),
      decisionId = 'decision-' + messageId;
    f.db
      .prepare(
        'UPDATE router_decisions SET candidate_snapshot_json=?,decision_json=? WHERE decision_id=?',
      )
      .run(JSON.stringify({ summary: marker }), JSON.stringify({ summary: marker }), decisionId);
    f.db
      .prepare("INSERT INTO operations VALUES (?,?,0,NULL,'GOAL_NOTIFICATION',?,NULL,?,?,?)")
      .run(
        id,
        decisionId,
        state,
        body,
        hash(body),
        JSON.stringify({ providerRef: 'public-provider-' + id, summary: marker }),
      );
    f.memory.addDerivation({
      sourceRef: 'claim:' + claim.claimId,
      derivedRef: (id === 'notice-unknown' ? 'operation:' : 'notification:') + id,
      sourceRevision: String(claim.version),
      expectedPrivacyEpoch: 1,
      expectedPolicyEpoch: 1,
    });
  }
  const before = f.db
    .prepare(
      "SELECT o.operation_id,o.state,o.input_hash,m.content_hash FROM operations o JOIN router_decisions d USING(decision_id) JOIN messages m USING(message_id) WHERE o.kind='GOAL_NOTIFICATION' ORDER BY o.operation_id",
    )
    .all();
  const result = f.memory.forget({ sourceRefs: [entry.sourceRef], expectedPrivacyEpoch: 1 });
  for (const id of ['notice-sent', 'notice-unknown', 'notice-sending']) {
    assert.ok(result.affectedRefs.includes('notification:' + id));
    assert.ok(result.affectedRefs.includes('operation:' + id));
    const operation = f.db.prepare('SELECT * FROM operations WHERE operation_id=?').get(id)!;
    const input = JSON.parse(String(operation.input_json)),
      receipt = JSON.parse(String(operation.result_ref));
    assert.equal(input.summary, '');
    assert.deepEqual(input.sourceRefs, []);
    assert.equal(input.redacted, true);
    assert.equal(receipt.providerRef, 'public-provider-' + id);
    assert.equal(receipt.state, id === 'notice-sent' ? 'delivered' : 'unknown');
  }
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT o.operation_id,o.state,o.input_hash,m.content_hash FROM operations o JOIN router_decisions d USING(decision_id) JOIN messages m USING(message_id) WHERE o.kind='GOAL_NOTIFICATION' ORDER BY o.operation_id",
      )
      .all()
      .map((row) => ({ ...row })),
    before.map((row) => ({
      ...row,
      state: row.state === 'executing' ? 'outcome_unknown' : row.state,
    })),
  );
  for (const table of ['messages', 'router_decisions', 'operations'])
    assert.equal(
      JSON.stringify(f.db.prepare('SELECT * FROM ' + table).all()).includes(marker),
      false,
      table,
    );
  f.memory.compact();
  for (const suffix of ['', '-wal'])
    if (existsSync(f.file + suffix))
      assert.equal(readFileSync(f.file + suffix).includes(Buffer.from(marker)), false);
});
test('real ExecutionLedger Task forget erases CREATE_TASK/update/start audit copies and their Decisions while preserving unrelated Tasks and Unknown execution facts', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-forget-task-audit-'))),
    file = join(root, 'execution/ledger.db'),
    cwd = join(root, 'project');
  mkdirSync(cwd);
  const store = new ExecutionLedger(file, schema);
  store.startOwner('public-audit-owner', true);
  const project = store.registerWorkspace(cwd),
    db = new DatabaseSync(file);
  t.after(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const marker = 'PUBLIC_TASK_OPERATION_AUDIT_SECRET',
    task = store.taskCommand({
      kind: 'create',
      projectId: project.id,
      commandKey: 'sensitive-create',
      text: 'Request ' + marker,
    }),
    other = store.taskCommand({
      kind: 'create',
      projectId: project.id,
      commandKey: 'unrelated-create',
      text: 'PUBLIC_UNRELATED_REQUEST',
    }),
    renamed = store.taskCommand({
      kind: 'rename',
      projectId: project.id,
      taskId: task.taskId,
      expectedVersion: task.taskVersion,
      commandKey: 'sensitive-rename',
      title: 'Title ' + marker,
    }),
    run = store.claimTask(project.id, task.taskId, renamed.taskVersion, 'sensitive-start');
  // Real Store admission and intent state transitions; no actual provider/process is launched.
  const intent = store.prepare(run.token, 'public-sending-intent', 'thread_start', {});
  store.sending(run.token, intent.intentId, 1);
  store.uncertain(run.token, intent.intentId);
  const facts = [
      'task_runs',
      'execution_intents',
      'workspace_write_leases',
      'run_usage',
      'thread_usage',
      'budget_reservations',
    ].map((table) => ({ table, rows: db.prepare('SELECT * FROM ' + table).all() })),
    otherBefore = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(other.taskId),
    operations = db
      .prepare(
        'SELECT o.operation_id,o.input_hash,o.state,o.decision_id,m.message_id,m.content_hash FROM operations o JOIN router_decisions d USING(decision_id) JOIN messages m USING(message_id) WHERE o.task_id=?',
      )
      .all(task.taskId);
  assert.ok(operations.length >= 3);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM message_task_links WHERE task_id=?').get(task.taskId)!.n,
    0,
  );
  assert.ok(JSON.stringify(db.prepare('SELECT content FROM messages').all()).includes(marker));
  const result = store.forgetMemory({
    sourceRefs: ['task:' + task.taskId],
    expectedPrivacyEpoch: 1,
  });
  assert.deepEqual(result.blockedRunIds, [run.token.runId]);
  for (const operation of operations) {
    assert.ok(result.affectedRefs.includes('operation:' + operation.operation_id));
    assert.ok(result.affectedRefs.includes('decision:' + operation.decision_id));
    assert.ok(result.affectedRefs.includes('message:' + operation.message_id));
    const after = db
      .prepare(
        'SELECT o.input_hash,o.state,m.content_hash,m.content,m.deleted_at_ms FROM operations o JOIN router_decisions d USING(decision_id) JOIN messages m USING(message_id) WHERE o.operation_id=?',
      )
      .get(String(operation.operation_id))!;
    assert.equal(after.input_hash, operation.input_hash);
    assert.equal(after.content_hash, operation.content_hash);
    assert.equal(after.content, '');
    assert.notEqual(after.deleted_at_ms, null);
    assert.equal(
      after.state,
      operation.state === 'executing' ? 'outcome_unknown' : operation.state,
    );
  }
  for (const table of [
    'messages',
    'router_decisions',
    'operations',
    'tasks',
    'task_events',
    'outbox_events',
  ])
    assert.equal(
      JSON.stringify(db.prepare('SELECT * FROM ' + table).all()).includes(marker),
      false,
      table,
    );
  for (const fact of facts)
    assert.deepEqual(db.prepare('SELECT * FROM ' + fact.table).all(), fact.rows, fact.table);
  assert.deepEqual(
    db.prepare('SELECT * FROM tasks WHERE task_id=?').get(other.taskId),
    otherBefore,
  );
  assert.ok(store.tasks(project.id).some((row) => row.taskId === other.taskId));
  assert.equal(
    store.tasks(project.id).some((row) => row.taskId === task.taskId),
    false,
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  store.compactMemory();
  for (const suffix of ['', '-wal'])
    if (existsSync(file + suffix))
      assert.equal(readFileSync(file + suffix).includes(Buffer.from(marker)), false);
});
test('Task-owned Goal forget traverses Goal command receipts and shared plan audits without reaching a separate Goal', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-forget-goal-audit-'))),
    file = join(root, 'execution/ledger.db'),
    cwd = join(root, 'project');
  mkdirSync(cwd);
  const store = new ExecutionLedger(file, schema);
  store.startOwner('public-goal-audit-owner', true);
  const project = store.registerWorkspace(cwd),
    db = new DatabaseSync(file);
  t.after(() => {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const marker = 'PUBLIC_GOAL_OPERATION_AUDIT_SECRET',
    goal = store.applyGoal({
      kind: 'create',
      commandKey: 'sensitive-goal-create',
      projectId: project.id,
      title: marker,
      objective: 'Goal ' + marker,
      criteria: ['Criteria ' + marker],
    }).goal,
    plan = store.applyGoal({
      kind: 'plan',
      commandKey: 'sensitive-goal-plan',
      goalId: goal.goalId,
      expectedVersion: goal.version,
      expectedPlanVersion: goal.planVersion,
      tasks: [
        { key: 'first', text: 'Task ' + marker, dependsOn: [] },
        { key: 'second', text: 'Next ' + marker, dependsOn: ['first'] },
      ],
    }),
    other = store.applyGoal({
      kind: 'create',
      commandKey: 'unrelated-goal-create',
      projectId: project.id,
      title: 'PUBLIC_OTHER_GOAL',
      objective: 'PUBLIC_OTHER_OBJECTIVE',
      criteria: ['Public evidence'],
    }).goal;
  const otherBefore = db.prepare('SELECT * FROM goals WHERE goal_id=?').get(other.goalId),
    result = store.forgetMemory({
      sourceRefs: ['task:' + plan.taskIds[0]!],
      expectedPrivacyEpoch: 1,
    });
  assert.ok(result.affectedRefs.includes('goal:' + goal.goalId));
  assert.ok(result.affectedRefs.includes('task:' + plan.taskIds[1]!));
  assert.equal(result.affectedRefs.includes('goal:' + other.goalId), false);
  for (const table of [
    'messages',
    'router_decisions',
    'operations',
    'tasks',
    'goals',
    'task_events',
    'outbox_events',
  ])
    assert.equal(
      JSON.stringify(db.prepare('SELECT * FROM ' + table).all()).includes(marker),
      false,
      table,
    );
  assert.deepEqual(
    db.prepare('SELECT * FROM goals WHERE goal_id=?').get(other.goalId),
    otherBefore,
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
test('Task-associated notifications keep the same transport whitelist regardless of closure traversal order', (t) => {
  const f = fixture(t);
  f.db.exec(
    "INSERT INTO tasks(task_id,dot_id,title,status,created_at_ms,updated_at_ms) VALUES ('task','dot','Public','created',1,1)",
  );
  const messageId = f.message(
      'PUBLIC_TASK_NOTIFICATION_COPY',
      'task-notice-message',
      'system_event',
    ),
    input = {
      goalId: 'public-goal',
      key: 'public-notice-key',
      kind: 'result',
      privacyEpoch: 1,
      summary: 'PUBLIC_TASK_NOTIFICATION_COPY',
      sourceRefs: [],
    },
    receipt = {
      state: 'delivered',
      providerRef: 'public-provider-receipt',
      claimId: 'public-claim',
      runtimeEpoch: 1,
      day: 1,
      summary: 'PUBLIC_TASK_NOTIFICATION_COPY',
    };
  f.db
    .prepare(
      "INSERT INTO operations VALUES ('notice','decision-task-notice-message',0,'task','GOAL_NOTIFICATION','completed',NULL,?,'stable-input-hash',?)",
    )
    .run(JSON.stringify(input), JSON.stringify(receipt));
  f.memory.forget({ sourceRefs: ['task:task'], expectedPrivacyEpoch: 1 });
  const row = f.db.prepare("SELECT * FROM operations WHERE operation_id='notice'").get()!,
    after = JSON.parse(String(row.input_json)),
    transport = JSON.parse(String(row.result_ref));
  assert.equal(after.summary, '');
  assert.equal(after.goalId, 'public-goal');
  assert.equal(row.input_hash, 'stable-input-hash');
  assert.equal(row.state, 'completed');
  assert.equal(transport.state, 'delivered');
  assert.equal(transport.providerRef, 'public-provider-receipt');
  assert.equal(transport.claimId, 'public-claim');
  assert.equal(
    f.db.prepare('SELECT content FROM messages WHERE message_id=?').get(messageId)!.content,
    '',
  );
});
test('Host Context claims derive their actual domain and strictest sensitivity from every live Evidence Entry', (t) => {
  const f = fixture(t),
    factKey = 'personal:multiEvidence',
    factText = 'PUBLIC_MULTI_EVIDENCE',
    make = (level: 'public' | 'private' | 'sensitive') =>
      f.memory.captureUser(f.message('/remember ' + factKey + ' = ' + factText), level),
    entry = make('public'),
    claim = f.memory.commitClaim(f.input(entry, { factKey, factText, quote: factText }));
  let view = f.memory.readContextClaim(claim.claimId, 'task')!;
  assert.equal(view.domain, 'personal');
  assert.equal(view.sensitivity, 'public');
  assert.equal(view.taskId, undefined);
  assert.equal(view.trust, 'explicit_user');
  for (const level of ['private', 'sensitive'] as const) {
    const evidence = make(level);
    f.db
      .prepare('INSERT INTO claim_evidence VALUES (?,?,?,NULL,?,?)')
      .run('public-extra-' + level, claim.claimId, evidence.entryId, hash(factText), 'exact_quote');
    f.db
      .prepare('INSERT INTO derivation_edges VALUES (?,?,?,?,1)')
      .run('dot', 'entry:' + evidence.entryId, 'claim:' + claim.claimId, evidence.sourceRevision);
    view = f.memory.readContextClaim(claim.claimId, 'task')!;
    assert.equal(view.sensitivity, level);
  }
  assert.equal(view.evidence.length, 3);
  f.db
    .prepare("INSERT INTO privacy_tombstones VALUES ('dot',?,2,0)")
    .run(view.evidence[2]!.sourceRef);
  assert.equal(f.memory.readContextClaim(claim.claimId, 'task'), null);
});
test('Host Context keeps Task claims in the original Task and allows only explicitly confirmed public user Coding memory', (t) => {
  const f = fixture(t);
  f.db.exec(
    "INSERT INTO tasks(task_id,dot_id,title,status,created_at_ms,updated_at_ms) VALUES ('task','dot','Public own task','created',1,1),('other','dot','Public other task','created',1,1)",
  );
  const taskEntry = f.capture('/remember task:task:limit = PUBLIC_TASK_LIMIT'),
    taskClaim = f.memory.commitClaim(
      f.input(taskEntry, {
        factKey: 'task:task:limit',
        factText: 'PUBLIC_TASK_LIMIT',
        quote: 'PUBLIC_TASK_LIMIT',
      }),
    ),
    own = f.memory.readContextClaim(taskClaim.claimId, 'task')!;
  assert.equal(own.domain, 'task');
  assert.equal(own.taskId, 'task');
  assert.equal(own.sensitivity, 'private');
  assert.equal(f.memory.readContextClaim(taskClaim.claimId, 'other'), null);
  const key = 'coding:publicLesson',
    text = 'PUBLIC_CODING_LESSON',
    publicEntry = f.memory.captureUser(f.message('/remember ' + key + ' = ' + text), 'public'),
    publicClaim = f.memory.commitClaim(
      f.input(publicEntry, { factKey: key, factText: text, quote: text }),
    ),
    coding = f.memory.readContextClaim(publicClaim.claimId, 'task')!;
  assert.equal(coding.domain, 'coding');
  assert.equal(coding.sensitivity, 'public');
  assert.equal(coding.taskId, undefined);
  assert.equal(coding.trust, 'explicit_user');
  const privateEntry = f.capture('/remember coding:privateLesson = PRIVATE_UNSHARED');
  assert.throws(
    () =>
      f.memory.commitClaim(
        f.input(privateEntry, {
          factKey: 'coding:privateLesson',
          factText: 'PRIVATE_UNSHARED',
          quote: 'PRIVATE_UNSHARED',
        }),
      ),
    /PRIVATE_CODING_MEMORY_REJECTED/,
  );
  const inference = f.memory.captureUser(f.message('PUBLIC inferred code lesson'), 'public');
  assert.throws(
    () =>
      f.memory.commitClaim(
        f.input(inference, {
          factKey: 'coding:inferred',
          factText: 'inferred code lesson',
          quote: 'inferred code lesson',
          trust: 'agent_inference',
        }),
      ),
    /PRIVATE_CODING_MEMORY_REJECTED/,
  );
  const mismatch = f.memory.captureUser(
    f.message('/remember coding:otherKey = PUBLIC_WRONG_VALUE'),
    'public',
  );
  assert.throws(
    () =>
      f.memory.commitClaim(
        f.input(mismatch, {
          factKey: 'coding:requestedKey',
          factText: 'PUBLIC_WRONG_VALUE',
          quote: 'PUBLIC_WRONG_VALUE',
        }),
      ),
    /MEMORY_EXPLICIT_USER_REQUIRED/,
  );
  f.db
    .prepare("UPDATE memory_entries SET sensitivity='private' WHERE entry_id=?")
    .run(publicEntry.entryId);
  assert.equal(f.memory.readContextClaim(publicClaim.claimId, 'task'), null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM mandates').get()!.n, 0);
});
test('Host Context never returns future, expired, empty or partially unsupported Evidence, or a Claim with a revoked ancestor', (t) => {
  const f = fixture(t),
    now = Date.now();
  for (const [key, validity] of [
    ['future', { validFromMs: now + 600000 }],
    ['expired', { validUntilMs: now - 1 }],
  ] as const) {
    const entry = f.capture('/remember personal:' + key + ' = PUBLIC_TIME'),
      claim = f.memory.commitClaim(
        f.input(entry, {
          factKey: 'personal:' + key,
          factText: 'PUBLIC_TIME',
          quote: 'PUBLIC_TIME',
          ...validity,
        }),
      );
    assert.equal(f.memory.readContextClaim(claim.claimId, 'task'), null);
  }
  const entry = f.capture('/remember personal:guarded = PUBLIC_GUARDED'),
    claim = f.memory.commitClaim(
      f.input(entry, {
        factKey: 'personal:guarded',
        factText: 'PUBLIC_GUARDED',
        quote: 'PUBLIC_GUARDED',
      }),
    );
  assert.ok(f.memory.readContextClaim(claim.claimId, 'task'));
  const unsupported = f.message('PUBLIC_UNSUPPORTED_DIRECT_EVIDENCE');
  f.db
    .prepare('INSERT INTO claim_evidence VALUES (?,?,NULL,?,?,?)')
    .run(
      'unsupported-direct-evidence',
      claim.claimId,
      unsupported,
      hash('PUBLIC_UNSUPPORTED_DIRECT_EVIDENCE'),
      'direct_message',
    );
  assert.equal(f.memory.readContextClaim(claim.claimId, 'task'), null);
  f.db.prepare('DELETE FROM claim_evidence WHERE evidence_id=?').run('unsupported-direct-evidence');
  f.db.exec(
    "INSERT INTO tasks(task_id,dot_id,title,status,created_at_ms,updated_at_ms) VALUES ('task','dot','Public ancestor','created',1,1)",
  );
  f.memory.addDerivation({
    sourceRef: 'task:task',
    derivedRef: 'claim:' + claim.claimId,
    sourceRevision: '1',
    expectedPrivacyEpoch: 1,
    expectedPolicyEpoch: 1,
  });
  f.db.exec("INSERT INTO privacy_tombstones VALUES ('dot','task:task',2,0)");
  assert.equal(f.memory.readContextClaim(claim.claimId, 'task'), null);
  f.db.exec('DELETE FROM privacy_tombstones');
  f.db.prepare('DELETE FROM claim_evidence WHERE claim_id=?').run(claim.claimId);
  assert.equal(f.memory.readContextClaim(claim.claimId, 'task'), null);
});
test('real Memory Evidence flows through DomainContextSources into Coding Context without personal or cross-Task promotion', (t) => {
  const f = fixture(t);
  f.db.exec(
    "INSERT INTO tasks(task_id,dot_id,title,constraints_json,status,created_at_ms,updated_at_ms) VALUES ('task','dot','Public task','{\"text\":\"PUBLIC_CODING_REQUEST\"}','created',1,1),('other','dot','Other task','{\"text\":\"PUBLIC_OTHER_REQUEST\"}','created',1,1)",
  );
  const remember = (key: string, text: string, sensitivity: 'public' | 'private' | 'sensitive') => {
    const entry = f.memory.captureUser(f.message('/remember ' + key + ' = ' + text), sensitivity);
    return f.memory.commitClaim(f.input(entry, { factKey: key, factText: text, quote: text }));
  };
  const personal = remember('personal:preference', 'PERSONAL_ONLY_MARKER', 'private'),
    sensitive = remember('personal:sensitive', 'SENSITIVE_ONLY_MARKER', 'sensitive'),
    task = remember('task:task:limit', 'PUBLIC_OWN_TASK_LIMIT', 'private'),
    other = remember('task:other:limit', 'OTHER_TASK_PRIVATE_MARKER', 'private'),
    coding = remember('coding:lesson', 'PUBLIC_EXPLICIT_CODING_LESSON', 'public');
  const sources = new DomainContextSources(f.db, 'dot', f.fail, {
      messageVisible: () => true,
      artifactText: () => null,
      memoryClaim: (claimId, taskId) => f.memory.readContextClaim(claimId, taskId),
    }),
    request = sources.resolve('task:task', 'task')!,
    actual = [personal, sensitive, task, coding].map((claim) =>
      sources.resolve('claim:' + claim.claimId, 'task')!,
    );
  assert.equal(actual[0]!.domain, 'personal');
  assert.equal(actual[1]!.sensitivity, 'secret');
  assert.equal(actual[2]!.domain, 'task');
  assert.equal(actual[3]!.domain, 'coding');
  assert.equal(actual[3]!.trust, 'explicit_user');
  assert.equal(sources.resolve('claim:' + other.claimId, 'task'), null);
  const version = {
      dotId: 'dot',
      taskId: 'task',
      taskVersion: 1,
      goalPlanVersion: null,
      policyEpoch: 1,
      privacyEpoch: 1,
      workspaceRevision: 'public-memory-fixture',
    },
    inputs = [request, ...actual],
    bundle = buildTaskContext(
      {
        ...version,
        role: 'coding',
        mode: 'read-only',
        sources: inputs,
        maximumInputUnits: 16000,
        framingReserveUnits: 256,
        nowMs: Date.now(),
        capabilities: { model_inference: true, workspace_read: true, workspace_write: false },
      },
      {
        ...version,
        sourceRevisions: Object.fromEntries(
          inputs.map((source) => [source.ref, { revision: source.revision, visible: true }]),
        ),
      },
    );
  assert.ok(bundle.userContext.includes('PUBLIC_OWN_TASK_LIMIT'));
  assert.ok(bundle.userContext.includes('PUBLIC_EXPLICIT_CODING_LESSON'));
  for (const marker of [
    'PERSONAL_ONLY_MARKER',
    'SENSITIVE_ONLY_MARKER',
    'OTHER_TASK_PRIVATE_MARKER',
  ])
    assert.equal(bundle.userContext.includes(marker), false);
  assert.equal(
    bundle.selectedSources.find((source) => source.ref === 'claim:' + coding.claimId)!.trust,
    'explicit_user',
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM actions').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 0);
});
