import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { BackupService } from '../packages/backup/src/service.ts';
import { RestoreService, activeRuntimePaths } from '../packages/backup/src/restore.ts';
import { GoalService } from '../packages/runtime/src/goal-service.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8'),
  marker = 'PUBLIC_M3_FORGET_RESTORE_MARKER',
  digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** All ledgers, context extraction, backup copies and activation are real. The
 * thread/start acknowledgement below is synthetic metadata, without transport,
 * model execution, private credentials or a claimed business verification. */
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-m3-forget-'))),
    cwd = join(root, 'project'),
    file = join(root, 'execution/ledger.db'),
    receipts = join(root, 'verification/artifacts');
  mkdirSync(cwd);
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  let store: ExecutionLedger | undefined = new ExecutionLedger(file, schema);
  store.startOwner('m3-forget-owner', true);
  const project = store.registerWorkspace(cwd),
    db = new DatabaseSync(file),
    messageId = 'public-memory-message',
    text = '/remember personal:publicPreference = ' + marker;
  store.prepareMainRoute({ projectId: project.id, messageId, text, focusRevision: 0 });
  const chat = store.mainChat({ projectId: project.id }),
    entry = store.captureMemoryMessage(messageId),
    claim = store.commitMemory({
      entryId: entry.entryId,
      expectedPrivacyEpoch: entry.privacyEpoch,
      expectedPolicyEpoch: entry.policyEpoch,
      factKey: 'personal:publicPreference',
      factText: marker,
      quote: marker,
      trust: 'explicit_user',
    }),
    task = store.taskCommand({
      kind: 'create',
      projectId: project.id,
      commandKey: 'context-task',
      text: 'PUBLIC_TASK ' + marker,
    });
  const run = store.claimTask(project.id, task.taskId, task.taskVersion, 'public-metadata-run');
  store.linkContextMessage(run.token.runId, messageId);
  const sourceRefs = ['task:' + task.taskId, 'message:' + messageId, 'claim:' + claim.claimId],
    bundle = store.contextForRun(run.token.runId, {
      role: 'coding',
      mode: 'read-only',
      sourceRefs,
      maximumInputUnits: 16000,
      framingReserveUnits: 1024,
      capabilities: { model_inference: true, workspace_read: true },
    });
  assert.ok(bundle.userContext.includes(marker));
  assert.equal(bundle.tokenAccounting.basis, 'tokens');
  const intent = store.prepare(run.token, 'public-fixture-thread-start', 'thread_start', {});
  store.sending(run.token, intent.intentId, 1);
  store.accepted(run.token, intent.intentId, { threadId: 'public-synthetic-thread' });
  store.finish(run.token, 'failed');
  assert.equal(store.runForHost(run.token.runId).threadId, 'public-synthetic-thread');
  assert.equal(store.runForHost(run.token.runId).blocked, false);
  const episode = store.saveEpisode(task.taskId, {
      conversationId: chat.conversationId!,
      title: 'PUBLIC_EPISODE',
      segments: [{ messageId, start: 0, end: text.length }],
    }),
    checkpoint = store.saveCheckpoint(run.token.runId, {
      goal: 'PUBLIC_GOAL ' + marker,
      constraints: [marker],
      completionCriteria: ['Public independent case'],
      pendingSteps: ['Public next step'],
      sourceRefs,
      verificationIds: [],
    });
  assert.equal(
    store.loadCheckpoint(task.taskId, checkpoint.checkpointId).businessCompletionClaimed,
    false,
  );
  assert.ok(JSON.stringify(store.loadEpisode(task.taskId, episode.episodeId)).includes(marker));
  const goal = store.applyGoal({
    kind: 'create',
    commandKey: 'notification-goal',
    projectId: project.id,
    title: 'PUBLIC_NOTIFICATION_GOAL',
    objective: 'PUBLIC_PROGRESS',
    criteria: ['Public evidence'],
    notificationPolicy: { enabled: true, dailyLimit: 10, quietStartMinute: 0, quietEndMinute: 0 },
  }).goal;
  const refs = [{ ref: 'claim:' + claim.claimId, revision: String(claim.version) }],
    notice = store.queueGoalNotification(goal.goalId, 'known-delivery', 'result', marker, refs)!,
    notificationClaim = store.claimGoalNotification()!;
  store.finishGoalNotification(notificationClaim, {
    state: 'delivered',
    providerRef: 'public-fixture-provider-receipt',
  });
  store.queueGoalNotification(goal.goalId, 'pending-delivery', 'result', marker, refs);
  const backups = new BackupService(store, {
      directory: join(root, 'backups'),
      verificationDirectory: receipts,
    }),
    restore = new RestoreService(store, backups, root),
    backup = backups.command({ kind: 'create', commandKey: 'public-before-forget' }),
    backupFile = join(root, 'backups', backup.backup.id, 'ledger.db'),
    oldHash = digest(backupFile);
  t.after(() => {
    db.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    db,
    project,
    entry,
    claim,
    task,
    run,
    episode,
    checkpoint,
    goal,
    notice,
    backups,
    restore,
    backup,
    backupFile,
    oldHash,
    get store() {
      return store!;
    },
    forget() {
      return store!.forgetMemory({
        sourceRefs: [entry.sourceRef],
        expectedPrivacyEpoch: entry.privacyEpoch,
      });
    },
    close() {
      store?.close();
      store = undefined;
    },
  };
}
function assertNoActiveMarker(db: DatabaseSync) {
  for (const table of [
    'messages',
    'router_decisions',
    'operations',
    'memory_entries',
    'memory_claims',
    'episodes',
    'task_checkpoints',
    'prompt_manifests',
    'tasks',
    'task_events',
    'outbox_events',
  ])
    assert.equal(
      JSON.stringify(db.prepare('SELECT * FROM ' + table).all()).includes(marker),
      false,
      table +
        ' retains forgotten content in ' +
        JSON.stringify(
          db
            .prepare('SELECT * FROM ' + table)
            .all()
            .filter((row) => JSON.stringify(row).includes(marker)),
        ),
    );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
}

test('real Store forget traverses Claim, Episode, Checkpoint, manifest, Thread and Goal notification; transport facts survive', (t) => {
  const f = fixture(t),
    before = f.db
      .prepare('SELECT input_hash FROM operations WHERE operation_id=?')
      .get(f.notice.operationId)!.input_hash,
    result = f.forget();
  assert.ok(result.affectedRefs.includes('claim:' + f.claim.claimId));
  assert.ok(result.affectedRefs.includes('notification:' + f.notice.operationId));
  assert.equal(result.databaseCompactionRequired, true);
  assert.deepEqual(f.store.searchMemory({ query: marker }), []);
  assert.throws(
    () =>
      f.store.commitMemory({
        entryId: f.entry.entryId,
        expectedPrivacyEpoch: result.privacyEpoch,
        expectedPolicyEpoch: result.policyEpoch,
        factKey: 'personal:publicPreference',
        factText: marker,
        quote: marker,
        trust: 'explicit_user',
      }),
    /MEMORY_SOURCE_REVOKED|MEMORY_ENTRY_DELETED/,
  );
  assert.throws(
    () => f.store.loadEpisode(f.task.taskId, f.episode.episodeId),
    /CONTEXT_SOURCE_DELETED|EPISODE_UNAVAILABLE/,
  );
  assert.throws(
    () => f.store.loadCheckpoint(f.task.taskId, f.checkpoint.checkpointId),
    /CONTEXT_SOURCE_DELETED|CHECKPOINT_VERSION_CHANGED/,
  );
  const notices = f.store.goalNotifications(f.goal.goalId),
    known = notices.find((n) => n.operationId === f.notice.operationId)!;
  assert.equal(known.summary, '');
  assert.equal(known.state, 'delivered');
  assert.equal(known.providerRef, 'public-fixture-provider-receipt');
  assert.ok(notices.every((n) => n.redacted));
  assert.ok(notices.some((n) => n.state === 'cancelled'));
  assert.equal(f.store.claimGoalNotification(), null);
  assert.equal(
    f.db
      .prepare('SELECT input_hash FROM operations WHERE operation_id=?')
      .get(f.notice.operationId)!.input_hash,
    before,
  );
  assert.equal(
    f.db
      .prepare('SELECT state FROM thread_bindings WHERE execution_thread_id=?')
      .get('public-synthetic-thread')!.state,
    'invalidated',
  );
  assertNoActiveMarker(f.db);
  assert.equal(f.store.compactMemory().databaseCompacted, true);
  assert.equal(readFileSync(f.file).includes(Buffer.from(marker)), false);
  // An external old backup remains a separately controlled copy. Erasure is
  // enforced on its prepared restore, never by mutating the archived artifact.
  assert.equal(digest(f.backupFile), f.oldHash);
  assert.equal(readFileSync(f.backupFile).includes(Buffer.from(marker)), true);
});

test('real Backup rehearsal and Restore activation merge newer tombstones so old Memory, Thread and notifications cannot revive', async (t) => {
  const f = fixture(t),
    forgotten = f.forget(),
    rehearsal = f.backups.command({
      kind: 'rehearse',
      backupId: f.backup.backup.id,
      commandKey: 'public-erasure-rehearsal',
    }).rehearsal!;
  assert.equal(rehearsal.state, 'saved');
  assert.equal(rehearsal.activationBlocked, true);
  assert.ok(rehearsal.summary!.tombstones > 0);
  const rehearsalPath = join(f.root, 'rehearsals', rehearsal.id, 'ledger.db'),
    quarantined = new DatabaseSync(rehearsalPath, { readOnly: true });
  try {
    assertNoActiveMarker(quarantined);
    assert.equal(
      quarantined
        .prepare('SELECT state FROM thread_bindings WHERE execution_thread_id=?')
        .get('public-synthetic-thread')!.state,
      'invalidated',
    );
  } finally {
    quarantined.close();
  }
  assert.throws(() => new ExecutionLedger(rehearsalPath, schema), /RECOVERY_REHEARSAL_NOT_ACTIVE/);
  const prepared = f.restore.prepare({
    kind: 'prepareRestore',
    backupId: f.backup.backup.id,
    commandKey: 'public-erasure-restore',
  });
  assert.equal(prepared.state, 'prepared');
  assert.ok(prepared.summary!.privacyEpoch > forgotten.privacyEpoch);
  assert.equal(digest(f.backupFile), f.oldHash);
  f.restore.checkActivation({ kind: 'activateRestore', restoreId: prepared.id });
  f.close();
  f.restore.activateAfterOwnerStopped(prepared.id);
  const paths = activeRuntimePaths(f.root);
  assert.equal(paths.generation, prepared.id);
  const next = new ExecutionLedger(paths.database, schema);
  try {
    next.startOwner('m3-erasure-restored-owner', true);
    assert.deepEqual(next.searchMemory({ query: marker }), []);
    assert.equal(
      next.tasks(f.project.id).some((task) => task.taskId === f.task.taskId),
      false,
    );
    assert.throws(
      () => next.loadEpisode(f.task.taskId, f.episode.episodeId),
      /CONTEXT_SOURCE_DELETED|EPISODE_UNAVAILABLE/,
    );
    assert.throws(
      () => next.loadCheckpoint(f.task.taskId, f.checkpoint.checkpointId),
      /CONTEXT_SOURCE_DELETED|CHECKPOINT_VERSION_CHANGED/,
    );
    assert.throws(
      () =>
        next.beginContinuation(
          f.project.id,
          f.run.token.runId,
          'Never reuse forgotten thread',
          'cannot-reuse',
        ),
      /RUN_NOT_CONTINUABLE/,
    );
    let sends = 0;
    await new GoalService(
      next,
      {
        interrupt: async () => {
          throw Error('NO_EXECUTION_IN_THIS_TEST');
        },
      },
      {
        send: async () => {
          sends++;
          return { state: 'delivered', providerRef: 'must-not-send' };
        },
      },
    ).tick();
    assert.equal(sends, 0);
    assert.equal(next.claimGoalNotification(), null);
    assert.equal(
      next.goalNotifications(f.goal.goalId).find((n) => n.operationId === f.notice.operationId)!
        .providerRef,
      'public-fixture-provider-receipt',
    );
    const db = new DatabaseSync(paths.database, { readOnly: true });
    try {
      assertNoActiveMarker(db);
      assert.equal(
        db
          .prepare('SELECT state FROM thread_bindings WHERE execution_thread_id=?')
          .get('public-synthetic-thread')!.state,
        'invalidated',
      );
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM subscriptions WHERE state='active'").get()!.n,
        0,
      );
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM mandates WHERE state='active'").get()!.n,
        0,
      );
      assert.equal(db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 1);
    } finally {
      db.close();
    }
  } finally {
    next.close();
  }
  assert.equal(digest(f.backupFile), f.oldHash);
  assert.equal(readFileSync(paths.database).includes(Buffer.from(marker)), false);
});
