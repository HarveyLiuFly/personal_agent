import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../packages/runtime/src/memory-service.ts';
import type { MemoryServiceHost } from '../packages/runtime/src/memory-service.ts';
import { MemoryLedger } from '../packages/store/src/memory.ts';
import { contextDigest } from '../packages/runtime/src/context.ts';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'personal-agent-memory-service-')),
    file = join(root, 'ledger.db'),
    db = new DatabaseSync(file);
  db.exec(readFileSync('docs/design/contracts/schema.sql', 'utf8'));
  db.exec(
    `PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;
 INSERT INTO profiles VALUES ('p','Public',0);INSERT INTO dots VALUES ('dot','p','Public',1,1);INSERT INTO conversations VALUES ('conversation','dot');
 INSERT INTO tasks(task_id,dot_id,title,constraints_json,status,version,created_at_ms,updated_at_ms) VALUES ('task','dot','Public','{"text":"PUBLIC_REQUEST"}','running',1,0,0);
 INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES ('run','task','dot','key','codex','outcome_unknown',1,1,1,1,1,'test',1,0);
 INSERT INTO message_task_links VALUES ('message','task','dot','primary');`.replace(
      "INSERT INTO message_task_links VALUES ('message','task','dot','primary');",
      '',
    ),
  );
  const secret = 'SYNTHETIC_MEMORY_SECRET_7efbb81f';
  db.prepare(
    "INSERT INTO messages VALUES ('message','conversation','dot','user',?,?,'decided',0,NULL)",
  ).run(secret, contextDigest(secret));
  db.exec("INSERT INTO message_task_links VALUES ('message','task','dot','primary')");
  const artifactKey = 'public-artifact.txt',
    sourceKey = 'public-source.txt';
  writeFileSync(join(root, artifactKey), secret);
  writeFileSync(join(root, sourceKey), secret);
  db.prepare(
    "INSERT INTO artifacts VALUES ('artifact','dot','task',?,?,'published','private',1,?,NULL)",
  ).run(contextDigest(secret), artifactKey, secret.length);
  const transaction = <T>(body: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const ledger = new MemoryLedger(
      db,
      'dot',
      (code) => {
        throw Error(code);
      },
      { owner: () => {}, transaction },
    ),
    events: string[] = [];
  let stopped = true,
    artifactOk = true,
    sourceOk = true,
    compactOk = true,
    forgetCount = 0;
  const host: MemoryServiceHost = {
    forget: (input) => {
      forgetCount++;
      events.push('logical');
      return ledger.forget(input);
    },
    revokeRuns: async (ids) => {
      events.push('stop');
      assert.equal(
        db.prepare("SELECT content FROM messages WHERE message_id='message'").get()!.content,
        '',
      );
      assert.equal(
        db.prepare("SELECT status FROM task_runs WHERE run_id='run'").get()!.status,
        'outcome_unknown',
      );
      return stopped
        ? { stoppedRunIds: ids, unknownRunIds: [] }
        : { stoppedRunIds: [], unknownRunIds: ids };
    },
    purgeArtifacts: async (keys) => {
      events.push('artifacts');
      if (!artifactOk) throw Error(secret);
      for (const key of keys) {
        assert.equal(key, artifactKey);
        if (existsSync(join(root, key))) unlinkSync(join(root, key));
      }
      return { purgedKeys: keys };
    },
    purgeSourcePayloads: async (refs) => {
      events.push('sources');
      if (!sourceOk) return { purgedRefs: [] };
      if (existsSync(join(root, sourceKey))) unlinkSync(join(root, sourceKey));
      return { purgedRefs: refs };
    },
    compact: () => {
      events.push('compact');
      if (!compactOk) throw Error(secret);
      return ledger.compact();
    },
  };
  const service = new MemoryService(host);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    root,
    file,
    secret,
    artifactKey,
    sourceKey,
    events,
    host,
    service,
    get forgetCount() {
      return forgetCount;
    },
    stop(value: boolean) {
      stopped = value;
    },
    artifact(value: boolean) {
      artifactOk = value;
    },
    source(value: boolean) {
      sourceOk = value;
    },
    compact(value: boolean) {
      compactOk = value;
    },
  };
}
const input = { sourceRefs: ['message:message'], expectedPrivacyEpoch: 1 };
test('MemoryService performs real logical SQLite revocation before Host stop/file purge and actual VACUUM/WAL truncation', async (t) => {
  const f = fixture(t),
    result = await f.service.forget(input);
  assert.deepEqual(f.events, ['logical', 'stop', 'artifacts', 'sources', 'compact']);
  assert.equal(result.cleanup.localPhysicalCleanupComplete, true);
  assert.equal(result.cleanup.externalCopies, 'not_controlled');
  assert.equal(result.logical.privacyEpoch, 2);
  assert.equal(existsSync(join(f.root, f.artifactKey)), false);
  assert.equal(existsSync(join(f.root, f.sourceKey)), false);
  assert.equal(readFileSync(f.file).includes(Buffer.from(f.secret)), false);
  for (const suffix of ['-wal', '-shm'])
    if (existsSync(f.file + suffix))
      assert.equal(readFileSync(f.file + suffix).includes(Buffer.from(f.secret)), false);
  assert.equal(
    f.db.prepare("SELECT status FROM task_runs WHERE run_id='run'").get()!.status,
    'outcome_unknown',
  );
});
test('Unknown or failed execution shutdown preserves logical deletion and refuses physical completion until retry confirms actual stop', async (t) => {
  const f = fixture(t);
  f.stop(false);
  const result = await f.service.forget(input);
  assert.equal(result.cleanup.code, 'EXECUTION_STOP_UNCONFIRMED');
  assert.equal(result.cleanup.localPhysicalCleanupComplete, false);
  assert.deepEqual(f.events, ['logical', 'stop']);
  assert.equal(existsSync(join(f.root, f.artifactKey)), true);
  f.stop(true);
  const retried = await f.service.retryCleanup(result.cleanupId);
  assert.equal(retried.cleanup.code, 'COMPLETE');
  assert.equal(f.forgetCount, 1);
  assert.equal(retried.logical.privacyEpoch, 2);
  assert.equal(result.cleanup.executionStopped, false);
});
test('Artifact and source purge failures are bounded, sanitized and resumable without compaction or repeated forget', async (t) => {
  const f = fixture(t);
  f.artifact(false);
  let result = await f.service.forget(input);
  assert.equal(result.cleanup.code, 'ARTIFACT_PURGE_INCOMPLETE');
  assert.equal(JSON.stringify(result).includes(f.secret), false);
  assert.equal(f.events.includes('compact'), false);
  f.artifact(true);
  f.source(false);
  result = await f.service.retryCleanup(result.cleanupId);
  assert.equal(result.cleanup.code, 'SOURCE_PURGE_INCOMPLETE');
  assert.equal(f.events.includes('compact'), false);
  f.source(true);
  result = await f.service.retryCleanup(result.cleanupId);
  assert.equal(result.cleanup.code, 'COMPLETE');
  assert.equal(f.forgetCount, 1);
  assert.equal(f.events.filter((e) => e === 'stop').length, 1);
  assert.equal(f.events.filter((e) => e === 'artifacts').length, 2);
});
test('Failed actual compaction cannot claim local physical erasure and can be retried after readers release', async (t) => {
  const f = fixture(t);
  f.compact(false);
  let result = await f.service.forget(input);
  assert.equal(result.cleanup.code, 'DATABASE_COMPACTION_INCOMPLETE');
  assert.equal(result.cleanup.databaseCompacted, false);
  assert.equal(result.cleanup.localPhysicalCleanupComplete, false);
  f.compact(true);
  result = await f.service.retryCleanup(result.cleanupId);
  assert.equal(result.cleanup.localPhysicalCleanupComplete, true);
  assert.equal(f.forgetCount, 1);
});
test('Malformed purge acknowledgements, fabricated cleanup tickets and failed Ledger validation cannot produce completion', async (t) => {
  const f = fixture(t);
  f.host.revokeRuns = async () => ({ stoppedRunIds: ['different-run'], unknownRunIds: [] });
  const result = await f.service.forget(input);
  assert.equal(result.cleanup.code, 'EXECUTION_STOP_UNCONFIRMED');
  assert.equal(f.events.includes('artifacts'), false);
  await assert.rejects(f.service.retryCleanup('fabricated'), /MEMORY_CLEANUP_NOT_FOUND/);
  await assert.rejects(f.service.forget(input), /MEMORY_SOURCE_CHANGED/);
});
test('Concurrent retries share one cleanup operation and returned receipt mutation cannot forge internal completion', async (t) => {
  const f = fixture(t);
  f.stop(false);
  const result = await f.service.forget(input);
  result.cleanup.localPhysicalCleanupComplete = true;
  result.logical.artifactKeys = [];
  let release: () => void = () => {};
  f.host.revokeRuns = async (ids) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { stoppedRunIds: ids, unknownRunIds: [] };
  };
  const a = f.service.retryCleanup(result.cleanupId),
    b = f.service.retryCleanup(result.cleanupId);
  release();
  assert.equal((await a).cleanup.code, 'COMPLETE');
  assert.equal((await b).cleanup.code, 'COMPLETE');
  assert.equal(f.events.filter((e) => e === 'artifacts').length, 1);
  assert.equal(existsSync(join(f.root, f.artifactKey)), false);
});
test('A real SQLite WAL reader keeps physical cleanup incomplete until its snapshot is closed', async (t) => {
  const f = fixture(t),
    reader = new DatabaseSync(f.file);
  reader.exec('BEGIN');
  reader.prepare('SELECT content FROM messages').all();
  t.after(() => reader.close());
  const result = await f.service.forget(input);
  assert.equal(result.cleanup.code, 'DATABASE_COMPACTION_INCOMPLETE');
  assert.equal(result.cleanup.databaseCompacted, false);
  assert.equal(result.cleanup.localPhysicalCleanupComplete, false);
  reader.exec('ROLLBACK');
  const retry = await f.service.retryCleanup(result.cleanupId);
  assert.equal(retry.cleanup.code, 'COMPLETE');
  assert.equal(readFileSync(f.file).includes(Buffer.from(f.secret)), false);
});
