import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ContextLedger } from '../packages/store/src/context.ts';
import { DomainContextSources } from '../packages/store/src/context-sources.ts';
import type { BuildBundleOptions } from '../packages/store/src/context.ts';
import { contextDigest } from '../packages/runtime/src/context.ts';
import type { ContextCounter, ContextSource } from '../packages/runtime/src/context.ts';
import { verifiedO200kTokenizer } from '../packages/runtime/src/tokenizer.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8'),
  counter = verifiedO200kTokenizer().counter;
function fixture(t: { after(fn: () => void): void }, customCounter?: ContextCounter) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-context-store-'))),
    file = join(root, 'ledger.db');
  let db = new DatabaseSync(file);
  db.exec(schema);
  db.exec(
    "PRAGMA foreign_keys=ON;INSERT INTO profiles VALUES ('profile','Public',0);INSERT INTO dots VALUES ('dot','profile','Public',1,1);INSERT INTO runtime_owners VALUES ('profile',1,'context-test','main','ready',0);INSERT INTO projects VALUES ('project','dot','/public/project','Public');INSERT INTO workspaces VALUES ('workspace','project','dot','/public/project','main','ready',0);INSERT INTO tasks(task_id,dot_id,workspace_id,title,constraints_json,status,version,created_at_ms,updated_at_ms) VALUES ('task','dot','workspace','Public task','{\"text\":\"PUBLIC_REQUEST\"}','running',3,0,0);INSERT INTO conversations VALUES ('conversation','dot');",
  );
  const insertMessage = (id: string, content: string) =>
    db
      .prepare("INSERT INTO messages VALUES (?,'conversation','dot','user',?,?,'decided',0,NULL)")
      .run(id, content, contextDigest(content));
  insertMessage('m1', 'PUBLIC_FIRST_MESSAGE');
  insertMessage('m2', 'PUBLIC_SECOND_MESSAGE');
  const artifacts = new Map<string, string>();
  let workspaceRevision = 'workspace-rev-1',
    lookupHook: ((ref: string) => void) | undefined;
  const source = (ref: string, taskId: string): ContextSource | null => {
    lookupHook?.(ref);
    const [kind, id] = ref.split(':');
    let content: string,
      revision: string,
      sourceKind: ContextSource['kind'] = 'state',
      trust: ContextSource['trust'] = 'host_verified';
    if (kind === 'task') {
      const task = db
        .prepare("SELECT constraints_json,version FROM tasks WHERE task_id=? AND dot_id='dot'")
        .get(id!);
      if (!task || id !== taskId) return null;
      content = String(task.constraints_json);
      revision = String(task.version);
      sourceKind = 'request';
      trust = 'explicit_user';
    } else if (kind === 'message') {
      const row = db
        .prepare(
          "SELECT * FROM messages WHERE message_id=? AND dot_id='dot' AND deleted_at_ms IS NULL",
        )
        .get(id!);
      if (!row) return null;
      content = String(row.content);
      revision = String(row.content_hash);
      sourceKind = 'request';
      trust = 'explicit_user';
    } else if (kind === 'artifact') {
      const row = db
        .prepare(
          "SELECT * FROM artifacts WHERE artifact_id=? AND dot_id='dot' AND task_id=? AND state='published'",
        )
        .get(id!, taskId);
      if (!row || !artifacts.has(id!)) return null;
      content = artifacts.get(id!)!;
      if (contextDigest(content) !== row.content_sha256) return null;
      revision = String(row.content_sha256);
      sourceKind = 'receipt';
    } else return null;
    return {
      ref,
      revision,
      dotId: 'dot',
      taskId,
      kind: sourceKind,
      trust,
      domain: 'task',
      sensitivity: 'private',
      content,
      contentHash: contextDigest(content),
      privacyEpoch: 1,
      required: true,
      priority: 100,
    };
  };
  const owner = () => {
      if (
        db
          .prepare(
            "SELECT count(*) AS n FROM runtime_owners WHERE instance_id='context-test' AND runtime_epoch=1 AND state='ready'",
          )
          .get()!.n !== 1
      )
        throw Error('STALE_CONTEXT_OWNER');
    },
    tx = <T>(work: () => T): T => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    };
  const make = () =>
    new ContextLedger(
      db,
      'dot',
      (code) => {
        throw Error(code);
      },
      {
        owner,
        tx,
        source,
        workspaceRevision: () => workspaceRevision,
        counter: customCounter ?? counter,
      },
    );
  let context = make();
  const seedRun = (id = 'run', status = 'preparing') => {
    db.prepare(
      "INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES (?,'task','dot',?,'codex',?,3,1,1,1,1,'context-test',9999999999999,0)",
    ).run(id, 'run-key-' + id, status);
    db.exec("UPDATE tasks SET write_fence=1 WHERE task_id='task'");
  };
  const seedReceipt = () => {
    seedRun('verified-run', 'completed');
    db.exec(
      "INSERT INTO verification_specs VALUES ('spec','task',1,NULL,'[]','[]','{}','host-hash')",
    );
    const content = JSON.stringify({
        verificationId: 'verification',
        runId: 'verified-run',
        specId: 'spec',
        status: 'passed',
        code: 'VERIFIED',
        discovered: 4,
        executed: 4,
        skipped: 0,
        exitCode: 0,
      }),
      sha = contextDigest(content);
    artifacts.set('artifact', content);
    db.prepare(
      "INSERT INTO artifacts VALUES ('artifact','dot','task',?,'public-receipt.json','published','private',1,?,NULL)",
    ).run(sha, Buffer.byteLength(content));
    db.prepare(
      "INSERT INTO verification_results VALUES ('verification','verified-run','spec','passed',4,4,0,'artifact',0)",
    ).run();
  };
  const bundleOptions: BuildBundleOptions = {
    role: 'dot-orchestrator',
    mode: 'read-only',
    sourceRefs: ['task:task', 'message:m1'],
    maximumInputUnits: 4000,
    framingReserveUnits: 256,
    capabilities: { model_inference: true, workspace_write: false },
  };
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    get db() {
      return db;
    },
    get context() {
      return context;
    },
    source,
    artifacts,
    insertMessage,
    seedRun,
    seedReceipt,
    bundleOptions,
    hook(fn: typeof lookupHook) {
      lookupHook = fn;
    },
    workspace(value: string) {
      workspaceRevision = value;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(file);
      db.exec('PRAGMA foreign_keys=ON');
      context = make();
    },
  };
}
test('real SQLite bundle build rechecks source revisions and actual BPE without creating another Task/Run/Intent', (t) => {
  const f = fixture(t),
    before = f.db.prepare('SELECT total_changes() AS n').get()!.n,
    bundle = f.context.buildBundle('task', f.bundleOptions);
  assert.equal(bundle.tokenAccounting.basis, 'tokens');
  assert.match(bundle.tokenAccounting.counterFingerprint, /js-tiktoken@1.0.21:o200k_base:/);
  assert.equal(bundle.selectedSources.length, 2);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  for (const table of ['task_runs', 'execution_intents', 'prompt_manifests'])
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n, 0);
});
test('source or Task version changed during assembly rolls back and cannot bind a stale manifest', (t) => {
  let changed = false,
    write: () => void = () => {};
  const f = fixture(t, {
    basis: 'tokens',
    fingerprint: 'controlled-counter-mutation',
    count: (text) => {
      if (!changed) {
        changed = true;
        write();
      }
      return text.length;
    },
  });
  write = () =>
    f.db
      .prepare(
        "UPDATE messages SET content='CHANGED',content_hash='changed-revision' WHERE message_id='m1'",
      )
      .run();
  assert.throws(
    () => f.context.buildBundle('task', { ...f.bundleOptions, maximumInputUnits: 16000 }),
    /CONTEXT_SOURCE_CHANGED/,
  );
  assert.equal(
    f.db.prepare("SELECT content FROM messages WHERE message_id='m1'").get()!.content,
    'PUBLIC_FIRST_MESSAGE',
  );
});
test('manifest binding preserves source attribution and existing input hashes, requires current Run, and freezes before RPC', (t) => {
  const f = fixture(t);
  f.seedRun();
  f.db.exec(
    "INSERT INTO prompt_manifests VALUES ('manifest','run','coding','read-only','{\"user\":\"original-user-hash\",\"submission\":\"original-submit-hash\"}','old-tools',1,1,'[]',NULL)",
  );
  const bundle = f.context.buildBundle('task', f.bundleOptions),
    id = f.context.bindManifest('run', bundle);
  assert.equal(id, 'manifest');
  const saved = f.context.loadManifest('run');
  assert.equal(saved.contentHash, bundle.manifest.contentHash);
  const modules = JSON.parse(
    String(
      f.db.prepare("SELECT module_hashes_json FROM prompt_manifests WHERE run_id='run'").get()!
        .module_hashes_json,
    ),
  );
  assert.equal(modules.user, 'original-user-hash');
  assert.equal(modules.submission, 'original-submit-hash');
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM derivation_edges WHERE derived_ref='manifest:manifest'")
      .get()!.n,
    2,
  );
  assert.equal(f.context.bindManifest('run', bundle), id);
  assert.throws(
    () => f.context.bindManifest('run', structuredClone(bundle)),
    /CONTEXT_BUNDLE_NOT_BUILT/,
  );
  f.db.exec(
    "INSERT INTO execution_intents VALUES ('intent','run','intent-key','thread_start',NULL,NULL,'prepared','public-hash',NULL,NULL,NULL,0)",
  );
  assert.throws(() => f.context.bindManifest('run', bundle), /CONTEXT_RPC_ALREADY_PREPARED/);
});
test('manifest revalidation rejects deleted sources, changed current versions and stale owners', (t) => {
  const f = fixture(t);
  f.seedRun();
  const bundle = f.context.buildBundle('task', f.bundleOptions);
  f.context.bindManifest('run', bundle);
  f.db.exec("INSERT INTO privacy_tombstones VALUES ('dot','message:m1',2,0)");
  assert.throws(() => f.context.loadManifest('run'), /CONTEXT_SOURCE_DELETED/);
  f.db.exec("DELETE FROM privacy_tombstones;UPDATE tasks SET version=4 WHERE task_id='task'");
  assert.throws(() => f.context.bindManifest('run', bundle), /CONTEXT_VERSION_CHANGED/);
  f.db.exec('UPDATE runtime_owners SET runtime_epoch=2');
  assert.throws(() => f.context.buildBundle('task', f.bundleOptions), /STALE_CONTEXT_OWNER/);
});
test('extractive Episode persists original source links/derivation and survives a real DB reopen', (t) => {
  const f = fixture(t),
    saved = f.context.saveEpisode('task', {
      conversationId: 'conversation',
      title: 'Public topic',
      segments: [
        { messageId: 'm1', start: 0, end: 6 },
        { messageId: 'm2', start: 7, end: 13 },
      ],
    });
  assert.equal(saved.version, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM episode_message_links').get()!.n, 2);
  assert.equal(
    f.db
      .prepare('SELECT count(*) AS n FROM derivation_edges WHERE derived_ref=?')
      .get('episode:' + saved.episodeId)!.n,
    3,
  );
  f.reopen();
  assert.deepEqual(f.context.loadEpisode('task', saved.episodeId), saved);
  assert.throws(
    () =>
      f.context.saveEpisode('task', {
        conversationId: 'foreign',
        title: 'bad',
        segments: [{ messageId: 'm1', start: 0, end: 1 }],
      }),
    /EPISODE_CONVERSATION_SCOPE/,
  );
});
test('Episode edits require CAS and loads reject stale or forgotten sources', (t) => {
  const f = fixture(t),
    input = {
      conversationId: 'conversation',
      title: 'Public topic',
      segments: [{ messageId: 'm1', start: 0, end: 6 }],
    },
    saved = f.context.saveEpisode('task', input);
  assert.throws(
    () =>
      f.context.saveEpisode('task', { ...input, episodeId: saved.episodeId, expectedVersion: 2 }),
    /EPISODE_VERSION_CONFLICT/,
  );
  const changed = f.context.saveEpisode('task', {
    ...input,
    episodeId: saved.episodeId,
    expectedVersion: 1,
    title: 'Changed topic',
  });
  assert.equal(changed.version, 2);
  f.db.exec("UPDATE messages SET content_hash='new-revision' WHERE message_id='m1'");
  assert.throws(() => f.context.loadEpisode('task', saved.episodeId), /CONTEXT_SOURCE_CHANGED/);
  f.db.exec("INSERT INTO privacy_tombstones VALUES ('dot','episode:" + saved.episodeId + "',2,0)");
  assert.throws(() => f.context.loadEpisode('task', saved.episodeId), /CONTEXT_SOURCE_DELETED/);
});
const checkpointInput = {
  goal: 'Public goal',
  constraints: ['Only authorized work'],
  completionCriteria: ['Host verification'],
  pendingSteps: ['Await next request'],
  sourceRefs: ['task:task', 'artifact:artifact'],
  verificationIds: ['verification'],
};
test('Checkpoint derives evidence from published Host verification rows and verified source bytes, never caller status', (t) => {
  const f = fixture(t);
  f.seedReceipt();
  const saved = f.context.saveCheckpoint('verified-run', checkpointInput);
  assert.equal(saved.bundle.confirmedReceipts[0]!.executed, 4);
  assert.equal(saved.bundle.businessCompletionClaimed, false);
  assert.equal(
    f.context.saveCheckpoint('verified-run', checkpointInput).checkpointId,
    saved.checkpointId,
  );
  f.reopen();
  assert.deepEqual(f.context.loadCheckpoint('task', saved.checkpointId), saved.bundle);
  f.artifacts.set('artifact', 'MODEL SAYS PASSED');
  assert.throws(
    () => f.context.loadCheckpoint('task', saved.checkpointId),
    /CONTEXT_SOURCE_UNAVAILABLE/,
  );
});
test('missing/unpublished/zero-test receipt and changed checkpoint/source metadata are refused without partial saves', (t) => {
  const f = fixture(t);
  f.seedReceipt();
  f.db.exec("UPDATE artifacts SET state='staging'");
  assert.throws(
    () => f.context.saveCheckpoint('verified-run', checkpointInput),
    /CONTEXT_SOURCE_UNAVAILABLE/,
  );
  f.db.exec(
    "UPDATE artifacts SET state='published';UPDATE verification_results SET executed_count=0",
  );
  assert.throws(
    () => f.context.saveCheckpoint('verified-run', checkpointInput),
    /CHECKPOINT_RECEIPT_UNVERIFIED/,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_checkpoints').get()!.n, 0);
  f.db.exec('UPDATE verification_results SET executed_count=4');
  const saved = f.context.saveCheckpoint('verified-run', checkpointInput);
  f.workspace('changed-workspace');
  assert.throws(
    () => f.context.loadCheckpoint('task', saved.checkpointId),
    /CHECKPOINT_VERSION_CHANGED/,
  );
});
test('Rollover invalidates only an idle actual binding and leaves next provider thread creation to the Gateway', (t) => {
  const f = fixture(t);
  f.seedReceipt();
  f.db.exec(
    "INSERT INTO thread_bindings VALUES ('binding','task','codex','actual-old-thread',2,1,'active',NULL)",
  );
  const cp = f.context.saveCheckpoint('verified-run', checkpointInput),
    plan = f.context.rollover('task', {
      role: 'dot-orchestrator',
      mode: 'read-only',
      sourceRefs: checkpointInput.sourceRefs,
      checkpointId: cp.checkpointId,
    });
  assert.equal(plan.action, 'new_thread');
  assert.equal(plan.generation, 3);
  assert.equal(plan.invalidatedBindingId, 'binding');
  assert.equal(
    f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
    'invalidated',
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM thread_bindings').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 0);
});
test('Rollover keeps unknown Run and Intent evidence blocked and never retires the old binding', (t) => {
  const f = fixture(t);
  f.seedReceipt();
  f.db.exec(
    "INSERT INTO thread_bindings VALUES ('binding','task','codex','actual-old-thread',1,1,'active',NULL)",
  );
  const cp = f.context.saveCheckpoint('verified-run', checkpointInput);
  f.db.exec("UPDATE task_runs SET status='outcome_unknown' WHERE run_id='verified-run'");
  assert.throws(
    () =>
      f.context.rollover('task', {
        role: 'coding',
        mode: 'read-only',
        sourceRefs: checkpointInput.sourceRefs,
        checkpointId: cp.checkpointId,
      }),
    /ROLLOVER_UNRESOLVED_EFFECT/,
  );
  assert.equal(
    f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
    'active',
  );
  f.db.exec(
    "UPDATE task_runs SET status='completed';INSERT INTO execution_intents VALUES ('unknown','verified-run','unknown-intent','thread_start',NULL,NULL,'outcome_unknown','public-hash',1,'rpc',NULL,0)",
  );
  assert.throws(
    () =>
      f.context.rollover('task', {
        role: 'coding',
        mode: 'read-only',
        sourceRefs: checkpointInput.sourceRefs,
        checkpointId: cp.checkpointId,
      }),
    /ROLLOVER_UNRESOLVED_EFFECT/,
  );
});

test('a published receipt row with unknown skip count or a self-asserted JSON result is not trusted proof', (t) => {
  const f = fixture(t);
  f.seedReceipt();
  f.db.exec('UPDATE verification_results SET skipped_count=NULL');
  assert.throws(
    () => f.context.saveCheckpoint('verified-run', checkpointInput),
    /CHECKPOINT_RECEIPT_UNVERIFIED/,
  );
  f.db.exec('UPDATE verification_results SET skipped_count=0');
  const content = JSON.stringify({
    verificationId: 'verification',
    runId: 'verified-run',
    specId: 'spec',
    status: 'passed',
    code: 'MODEL_SAYS_PASSED',
    discovered: 4,
    executed: 4,
    skipped: 0,
    exitCode: 0,
  });
  f.artifacts.set('artifact', content);
  f.db
    .prepare("UPDATE artifacts SET content_sha256=? WHERE artifact_id='artifact'")
    .run(contextDigest(content));
  assert.throws(
    () => f.context.saveCheckpoint('verified-run', checkpointInput),
    /CHECKPOINT_RECEIPT_UNVERIFIED/,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_checkpoints').get()!.n, 0);
});
test('Host RPC freshness guard rechecks current manifest refs, Task/workspace and Run fence', (t) => {
  const f = fixture(t);
  f.seedRun();
  f.context.bindManifest('run', f.context.buildBundle('task', f.bundleOptions));
  f.context.assertRunFresh('run');
  f.db.exec("UPDATE messages SET content_hash='new-revision' WHERE message_id='m1'");
  assert.throws(() => f.context.assertRunFresh('run'), /CONTEXT_SOURCE_CHANGED/);
  f.db
    .prepare("UPDATE messages SET content_hash=? WHERE message_id='m1'")
    .run(contextDigest('PUBLIC_FIRST_MESSAGE'));
  f.workspace('changed');
  assert.throws(() => f.context.assertRunFresh('run'), /CONTEXT_MANIFEST_STALE/);
  f.workspace('workspace-rev-1');
  f.db.exec("UPDATE tasks SET write_fence=2 WHERE task_id='task'");
  assert.throws(() => f.context.assertRunFresh('run'), /CONTEXT_RUN_CHANGED/);
});
function admissionFixture(
  t: { after(fn: () => void): void },
  options: { writable?: boolean; goal?: boolean } = {},
) {
  const f = fixture(t);
  f.seedReceipt();
  f.db.exec(
    "UPDATE tasks SET status='needs_review' WHERE task_id='task';INSERT INTO message_task_links VALUES ('m1','task','dot','primary');INSERT INTO thread_bindings VALUES ('binding','task','codex','old-real-thread-fixture',2,1,'active',NULL)",
  );
  if (options.writable)
    f.db.prepare("UPDATE tasks SET constraints_json=? WHERE task_id='task'").run(
      JSON.stringify({
        text: 'PUBLIC_REQUEST',
        mode: 'workspaceWrite',
        code: {
          profile: 'node-test',
          target: 'public.test.mjs',
          allowedPaths: ['public.test.mjs'],
        },
      }),
    );
  if (options.goal)
    f.db.exec(
      "INSERT INTO goals(goal_id,dot_id,title,objective,status) VALUES ('goal','dot','Public goal','Public objective','active');UPDATE tasks SET goal_id='goal' WHERE task_id='task';UPDATE task_runs SET goal_plan_version=1 WHERE run_id='verified-run'",
    );
  const resolver = new DomainContextSources(
      f.db,
      'dot',
      (code) => {
        throw Error(code);
      },
      {
        messageVisible: () => true,
        workspace: () => 'workspace-rev-1',
        artifactText: (key) => {
          const row = f.db
            .prepare('SELECT artifact_id FROM artifacts WHERE relative_storage_key=?')
            .get(key);
          return row ? (f.artifacts.get(String(row.artifact_id)) ?? null) : null;
        },
      },
    ),
    tx = <T>(work: () => T): T => {
      f.db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        f.db.exec('COMMIT');
        return result;
      } catch (error) {
        f.db.exec('ROLLBACK');
        throw error;
      }
    };
  const context = new ContextLedger(
      f.db,
      'dot',
      (code) => {
        throw Error(code);
      },
      {
        owner: () => {
          if (
            f.db.prepare("SELECT state FROM runtime_owners WHERE instance_id='context-test'").get()!
              .state !== 'ready'
          )
            throw Error('STALE_CONTEXT_OWNER');
        },
        tx,
        source: (ref, taskId) => resolver.resolve(ref, taskId),
        workspaceRevision: () => 'workspace-rev-1',
        counter,
      },
    ),
    sourceRefs = ['task:task', 'message:m1', 'artifact:artifact'],
    saved = context.saveCheckpoint('verified-run', { ...checkpointInput, sourceRefs }),
    input = {
      role: 'coding' as const,
      mode: options.writable ? ('execution' as const) : ('read-only' as const),
      sourceRefs: [...sourceRefs, 'checkpoint:' + saved.checkpointId],
      checkpointId: saved.checkpointId,
    };
  const claim = (change?: () => void) => {
    f.db.exec(
      "UPDATE tasks SET status='queued' WHERE task_id='task';UPDATE tasks SET status='running',version=version+1,write_fence=write_fence+1,updated_at_ms=1 WHERE task_id='task';INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES ('new-run','task','dot','new-key','codex','preparing',4,2,1,1,1,'context-test',9999999999999,1)",
    );
    if (options.goal) f.db.exec("UPDATE task_runs SET goal_plan_version=1 WHERE run_id='new-run'");
    if (options.writable)
      f.db.exec(
        "UPDATE workspaces SET state='busy',write_fence=write_fence+1 WHERE workspace_id='workspace';INSERT INTO workspace_write_leases VALUES ('workspace','new-run',1,9999999999999)",
      );
    change?.();
    return { runId: 'new-run' };
  };
  return { ...f, context, resolver, saved, input, claim };
}
test('Host rollover admission rebases the exact checkpoint across its own Task claim and builds fresh Context with old hash provenance', (t) => {
  const f = admissionFixture(t),
    oldCheckpoint = f.db
      .prepare('SELECT * FROM task_checkpoints WHERE checkpoint_id=?')
      .get(f.saved.checkpointId),
    admitted = f.context.admitRollover('task', f.input, () => f.claim());
  assert.equal(admitted.runId, 'new-run');
  assert.equal(admitted.generation, 3);
  assert.equal(admitted.invalidatedBindingId, 'binding');
  assert.equal(admitted.bundle.taskVersion, 4);
  assert.equal(admitted.bundle.rolloverAdmission.fromCheckpointHash, f.saved.bundle.contentHash);
  assert.equal(admitted.bundle.rolloverAdmission.fromCheckpointId, f.saved.checkpointId);
  assert.equal(admitted.bundle.rolloverAdmission.fromTaskVersion, 3);
  assert.equal(admitted.bundle.rolloverAdmission.toTaskVersion, 4);
  assert.equal(admitted.bundle.rolloverAdmission.runId, 'new-run');
  assert.equal(admitted.bundle.businessCompletionClaimed, false);
  assert.equal(
    f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
    'invalidated',
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM thread_bindings').get()!.n, 1);
  assert.deepEqual(
    f.db.prepare('SELECT * FROM task_checkpoints WHERE checkpoint_id=?').get(f.saved.checkpointId),
    oldCheckpoint,
  );
  assert.throws(
    () => f.context.loadCheckpoint('task', f.saved.checkpointId),
    /CHECKPOINT_VERSION_CHANGED/,
  );
  assert.deepEqual(f.context.loadCheckpoint('task', admitted.checkpointId), admitted.bundle);
  assert.ok(admitted.sourceRefs.includes('checkpoint:' + admitted.checkpointId));
  assert.equal(admitted.sourceRefs.includes('checkpoint:' + f.saved.checkpointId), false);
  assert.ok(
    f.db
      .prepare(
        'SELECT * FROM derivation_edges WHERE source_ref=? AND derived_ref=? AND source_revision=?',
      )
      .get(
        'checkpoint:' + f.saved.checkpointId,
        'checkpoint:' + admitted.checkpointId,
        f.saved.bundle.contentHash,
      ),
  );
  const bundle = f.context.buildBundle('task', {
    ...f.bundleOptions,
    role: 'coding',
    capabilities: { model_inference: true, workspace_read: true, workspace_write: false },
    sourceRefs: admitted.sourceRefs,
    checkpointId: admitted.checkpointId,
    maximumInputUnits: 16000,
  });
  assert.equal(bundle.manifest.checkpointHash, admitted.bundle.contentHash);
  assert.ok(bundle.userContext.includes('host_rollover_admission'));
  assert.ok(bundle.userContext.includes(f.saved.bundle.contentHash));
  f.context.bindManifest('new-run', bundle);
  f.context.assertRunFresh('new-run');
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM execution_intents WHERE run_id='new-run'").get()!.n,
    0,
  );
});
test('ordinary stale or externally changed checkpoint cannot authorize admission or invoke the Host claim', (t) => {
  const f = admissionFixture(t);
  let calls = 0;
  f.db.exec("UPDATE tasks SET version=4 WHERE task_id='task'");
  assert.throws(
    () =>
      f.context.admitRollover('task', f.input, () => {
        calls++;
        return f.claim();
      }),
    /CHECKPOINT_VERSION_CHANGED/,
  );
  assert.equal(calls, 0);
  assert.equal(
    f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
    'active',
  );
  f.db.exec(
    'UPDATE tasks SET version=3,constraints_json=\'{"text":"CHANGED_REQUEST"}\' WHERE task_id=\'task\'',
  );
  assert.throws(
    () =>
      f.context.admitRollover('task', f.input, () => {
        calls++;
        return f.claim();
      }),
    /CONTEXT_SOURCE_CHANGED/,
  );
  assert.equal(calls, 0);
});
test('unresolved Intent/Action refuses admission without retiring the old binding or deleting evidence', (t) => {
  const f = admissionFixture(t);
  f.db.exec(
    "INSERT INTO execution_intents VALUES ('unknown','verified-run','unknown-key','thread_start',NULL,NULL,'outcome_unknown','public-hash',1,'rpc',NULL,0)",
  );
  let calls = 0;
  assert.throws(
    () =>
      f.context.admitRollover('task', f.input, () => {
        calls++;
        return f.claim();
      }),
    /ROLLOVER_UNRESOLVED_EFFECT/,
  );
  assert.equal(calls, 0);
  assert.equal(
    f.db.prepare("SELECT state FROM execution_intents WHERE intent_id='unknown'").get()!.state,
    'outcome_unknown',
  );
  assert.equal(
    f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
    'active',
  );
});
test('Task constraints/criteria/title and unexpected version changes during Host admission roll back Run and binding retirement', (t) => {
  for (const mutation of [
    'UPDATE tasks SET constraints_json=\'{"text":"CHANGED"}\' WHERE task_id=\'task\'',
    "UPDATE tasks SET criteria_json='[\"CHANGED\"]' WHERE task_id='task'",
    "UPDATE tasks SET title='CHANGED' WHERE task_id='task'",
    "UPDATE tasks SET version=5 WHERE task_id='task'",
    'UPDATE dots SET policy_epoch=2',
    'UPDATE dots SET privacy_epoch=2',
  ]) {
    const f = admissionFixture(t);
    assert.throws(
      () => f.context.admitRollover('task', f.input, () => f.claim(() => f.db.exec(mutation))),
      /ROLLOVER_ADMISSION_TASK_CHANGED/,
    );
    assert.equal(f.db.prepare("SELECT version FROM tasks WHERE task_id='task'").get()!.version, 3);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM task_runs WHERE run_id='new-run'").get()!.n,
      0,
    );
    assert.equal(
      f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
      'active',
    );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_checkpoints').get()!.n, 1);
  }
});
test('non-Task source mutation, old checkpoint mutation, workspace change or premature Thread publication cannot be rebased', (t) => {
  for (const [mutation, code] of [
    [
      "UPDATE messages SET content='CHANGED',content_hash='changed' WHERE message_id='m1'",
      'ROLLOVER_ADMISSION_SOURCE_CHANGED',
    ],
    ["UPDATE task_checkpoints SET summary_json='{}'", 'ROLLOVER_ADMISSION_PROVENANCE_CHANGED'],
    ["UPDATE workspaces SET canonical_cwd='/changed'", 'ROLLOVER_ADMISSION_WORKSPACE_CHANGED'],
    [
      "INSERT INTO thread_bindings VALUES ('premature','task','codex','forged-new-thread',3,1,'active',NULL)",
      'ROLLOVER_ADMISSION_PROVENANCE_CHANGED',
    ],
  ] as const) {
    const f = admissionFixture(t);
    assert.throws(
      () => f.context.admitRollover('task', f.input, () => f.claim(() => f.db.exec(mutation))),
      new RegExp(code),
    );
    assert.equal(
      f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
      'active',
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM task_runs WHERE run_id='new-run'").get()!.n,
      0,
    );
  }
});
test('admission rejects an old Run, wrong fence, stale owner and any Intent before fresh Context binding', (t) => {
  const old = admissionFixture(t);
  assert.throws(
    () => old.context.admitRollover('task', old.input, () => ({ runId: 'verified-run' })),
    /ROLLOVER_ADMISSION_RUN_INVALID/,
  );
  for (const mutation of [
    "UPDATE task_runs SET task_fence=3 WHERE run_id='new-run'",
    "UPDATE task_runs SET runtime_epoch=2 WHERE run_id='new-run'",
    "UPDATE task_runs SET worker_id='other-owner' WHERE run_id='new-run'",
    "INSERT INTO execution_intents VALUES ('premature-intent','new-run','premature-key','thread_start',NULL,NULL,'prepared','hash',NULL,NULL,NULL,0)",
  ]) {
    const f = admissionFixture(t);
    assert.throws(
      () => f.context.admitRollover('task', f.input, () => f.claim(() => f.db.exec(mutation))),
      /ROLLOVER_ADMISSION_RUN_INVALID/,
    );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_checkpoints').get()!.n, 1);
    assert.equal(
      f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
      'active',
    );
  }
});
test('only a synchronous Host callback can admit rollover, and thrown claims roll back before a checkpoint is saved', (t) => {
  const f = admissionFixture(t);
  let calls = 0;
  const asynchronous = (async () => {
    calls++;
    return { runId: 'not-allowed' };
  }) as unknown as () => { runId: string };
  assert.throws(
    () => f.context.admitRollover('task', f.input, asynchronous),
    /INVALID_ROLLOVER_ADMISSION/,
  );
  assert.equal(calls, 0);
  assert.throws(
    () =>
      f.context.admitRollover('task', f.input, () => {
        f.claim();
        throw Error('PUBLIC_CLAIM_FAILED');
      }),
    /PUBLIC_CLAIM_FAILED/,
  );
  assert.equal(
    f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
    'active',
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM task_runs WHERE run_id='new-run'").get()!.n,
    0,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_checkpoints').get()!.n, 1);
});
test('writable admission retains frozen code constraints and permits only its newly fenced workspace lease', (t) => {
  const f = admissionFixture(t, { writable: true }),
    constraints = f.db.prepare("SELECT constraints_json FROM tasks WHERE task_id='task'").get()!
      .constraints_json,
    admitted = f.context.admitRollover('task', f.input, () => f.claim());
  assert.equal(
    f.db.prepare("SELECT constraints_json FROM tasks WHERE task_id='task'").get()!.constraints_json,
    constraints,
  );
  assert.equal(
    f.db.prepare("SELECT run_id FROM workspace_write_leases WHERE workspace_id='workspace'").get()!
      .run_id,
    'new-run',
  );
  assert.equal(admitted.bundle.rolloverAdmission.mode, 'execution');
  const bundle = f.context.buildBundle('task', {
    role: 'coding',
    mode: 'execution',
    sourceRefs: admitted.sourceRefs,
    maximumInputUnits: 16000,
    capabilities: { model_inference: true, workspace_read: true, workspace_write: true },
    checkpointId: admitted.checkpointId,
  });
  f.context.bindManifest('new-run', bundle);
  f.context.assertRunFresh('new-run');
  const bad = admissionFixture(t, { writable: true });
  assert.throws(
    () =>
      bad.context.admitRollover('task', bad.input, () =>
        bad.claim(() => bad.db.exec('UPDATE workspace_write_leases SET workspace_fence=2')),
      ),
    /ROLLOVER_ADMISSION_WORKSPACE_CHANGED/,
  );
  assert.equal(
    bad.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
    'active',
  );
});
test('Goal objective or Plan changes during admission cannot be hidden by keeping Task constraints unchanged', (t) => {
  for (const sql of [
    "UPDATE goals SET objective='CHANGED' WHERE goal_id='goal'",
    "UPDATE goals SET plan_version=2 WHERE goal_id='goal'",
  ]) {
    const f = admissionFixture(t, { goal: true });
    assert.throws(
      () => f.context.admitRollover('task', f.input, () => f.claim(() => f.db.exec(sql))),
      /ROLLOVER_ADMISSION_TASK_CHANGED/,
    );
    assert.equal(
      f.db.prepare("SELECT objective FROM goals WHERE goal_id='goal'").get()!.objective,
      'Public objective',
    );
    assert.equal(
      f.db.prepare("SELECT state FROM thread_bindings WHERE binding_id='binding'").get()!.state,
      'active',
    );
  }
});
