import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { BackupService } from '../packages/backup/src/service.ts';
import { RestoreService, activeRuntimePaths } from '../packages/backup/src/restore.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-restore-')));
  mkdirSync(join(root, 'source'));
  writeFileSync(join(root, 'source/file.txt'), 'PUBLIC_SOURCE_UNCHANGED');
  let store: ExecutionLedger | undefined = new ExecutionLedger(
    join(root, 'execution/ledger.db'),
    schema,
  );
  store.startOwner('original-owner', true);
  const project = store.registerWorkspace(join(root, 'source')),
    receipts = join(root, 'verification/artifacts');
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const backups = new BackupService(store, {
      directory: join(root, 'backups'),
      verificationDirectory: receipts,
    }),
    service = new RestoreService(store, backups, root),
    task = store.taskCommand({
      kind: 'create',
      projectId: project.id,
      commandKey: 'task',
      text: 'PUBLIC_BACKUP_TITLE',
    }),
    backup = backups.command({ kind: 'create', commandKey: 'old-backup' });
  t.after(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    project,
    backups,
    service,
    task,
    backup,
    close() {
      store?.close();
      store = undefined;
    },
  };
}
test('idle restore physically activates a new generation, preserving newer source DB and source files', (t) => {
  const f = fixture(t);
  f.store.taskCommand({
    kind: 'rename',
    projectId: f.project.id,
    taskId: f.task.taskId,
    expectedVersion: 2,
    commandKey: 'new-title',
    title: 'PUBLIC_CURRENT_TITLE',
  });
  const restore = f.service.prepare({
    kind: 'prepareRestore',
    backupId: f.backup.backup.id,
    commandKey: 'restore',
  });
  assert.equal(restore.state, 'prepared');
  assert.ok(restore.safetyBackupId);
  assert.throws(
    () => new ExecutionLedger(join(f.root, 'runtimes', restore.id, 'ledger.db'), schema),
    /RECOVERY_REHEARSAL_NOT_ACTIVE/,
  );
  assert.equal(activeRuntimePaths(f.root).generation, null);
  assert.equal(
    f.service.checkActivation({ kind: 'activateRestore', restoreId: restore.id }).id,
    restore.id,
  );
  assert.throws(() => f.service.activateAfterOwnerStopped(restore.id), /RESTORE_OWNER_NOT_STOPPED/);
  f.close();
  f.service.activateAfterOwnerStopped(restore.id);
  const paths = activeRuntimePaths(f.root);
  assert.equal(paths.generation, restore.id);
  const next = new ExecutionLedger(paths.database, schema);
  try {
    assert.ok(next.startOwner('restored-owner', true) > 1);
    assert.equal(next.tasks(f.project.id)[0]!.title, 'PUBLIC_BACKUP_TITLE');
    assert.equal(next.tasks(f.project.id)[0]!.status, 'paused');
    assert.equal(next.runs(f.project.id).length, 0);
    const fresh = next.beginRun(
      f.project.id,
      'PUBLIC_NEW_EXPLICIT_TASK',
      'new-after-restore',
      'readOnly',
    );
    assert.equal(
      next.prepare(fresh.token, 'metadata-only-prepared-not-sent', 'thread_start', {
        cwd: join(f.root, 'source'),
      }).state,
      'prepared',
    );
  } finally {
    next.close();
  }
  const old = new DatabaseSync(join(f.root, 'execution/ledger.db'), { readOnly: true });
  try {
    assert.equal(old.prepare('SELECT title FROM tasks').get()!.title, 'PUBLIC_CURRENT_TITLE');
    assert.equal(old.prepare('SELECT state FROM runtime_owners').get()!.state, 'stopped');
  } finally {
    old.close();
  }
  assert.equal(readFileSync(join(f.root, 'source/file.txt'), 'utf8'), 'PUBLIC_SOURCE_UNCHANGED');
  assert.equal(
    f.backups.command({ kind: 'verify', backupId: restore.safetyBackupId! }).verification
      .activeRuns,
    0,
  );
});
test('same preparation key returns original copy, and changes before activation require an explicit new preparation', (t) => {
  const f = fixture(t),
    input = { kind: 'prepareRestore', backupId: f.backup.backup.id, commandKey: 'restore' };
  const a = f.service.prepare(input),
    b = f.service.prepare(input);
  assert.equal(a.id, b.id);
  assert.equal(a.createdAt, b.createdAt);
  f.store.taskCommand({
    kind: 'rename',
    projectId: f.project.id,
    taskId: f.task.taskId,
    expectedVersion: 2,
    commandKey: 'changed',
    title: 'CHANGED',
  });
  assert.throws(
    () => f.service.checkActivation({ kind: 'activateRestore', restoreId: a.id }),
    /RESTORE_CURRENT_STATE_CHANGED/,
  );
  assert.equal(f.service.list()[0]!.state, 'expired');
  assert.equal(f.service.prepare(input).state, 'expired');
  const c = f.service.prepare({ ...input, commandKey: 'new-restore' });
  assert.notEqual(c.id, a.id);
});
test('extra fields, foreign IDs, malformed pointers and changed physical copies are rejected', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.service.prepare({
        kind: 'prepareRestore',
        backupId: f.backup.backup.id,
        commandKey: 'bad',
        path: '/tmp',
      }),
    /INVALID_RESTORE_COMMAND/,
  );
  assert.throws(() =>
    f.service.checkActivation({ kind: 'activateRestore', restoreId: 'f'.repeat(64) }),
  );
  const r = f.service.prepare({
    kind: 'prepareRestore',
    backupId: f.backup.backup.id,
    commandKey: 'restore',
  });
  writeFileSync(join(f.root, 'runtimes', r.id, 'ledger.db'), 'PUBLIC_CORRUPTION');
  assert.throws(
    () => f.service.checkActivation({ kind: 'activateRestore', restoreId: r.id }),
    /RESTORE_COPY_CHANGED/,
  );
  writeFileSync(
    join(f.root, 'runtimes/active.json'),
    JSON.stringify({ format: 1, id: '../escape' }),
  );
  assert.throws(() => activeRuntimePaths(f.root), /RESTORE_ACTIVE_POINTER_INVALID/);
});
for (const stage of ['before_pointer', 'commit_intent', 'activated'] as const)
  test(`actual cold restore Host SIGKILL at ${stage} retains a complete old or new active generation`, async (t) => {
    const f = fixture(t);
    f.close();
    const child = spawn(
      process.execPath,
      [resolve('tests/fixtures/restore-crash-worker.ts'), f.root, f.backup.backup.id, stage],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      await new Promise<void>((done, reject) => {
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.includes('\n')) done();
        });
        child.once('exit', () => reject(Error('RESTORE_CHILD_EARLY_EXIT')));
      });
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      const [code, signal] = await exit;
      assert.equal(code, null);
      assert.equal(signal, 'SIGKILL');
      if (stage === 'commit_intent') {
        assert.throws(() => activeRuntimePaths(f.root), /RESTORE_ACTIVE_POINTER_MISSING/);
        assert.ok(existsSync(join(f.root, 'execution/ledger.db')));
        return;
      }
      const paths = activeRuntimePaths(f.root);
      assert.equal(paths.generation !== null, stage === 'activated');
      const next = new ExecutionLedger(paths.database, schema);
      try {
        next.startOwner('after-real-kill', true);
        assert.equal(next.runs(f.project.id).length, 0);
        assert.equal(
          next.tasks(f.project.id)[0]!.status,
          stage === 'activated' ? 'paused' : 'queued',
        );
      } finally {
        next.close();
      }
      assert.equal(
        readFileSync(join(f.root, 'source/file.txt'), 'utf8'),
        'PUBLIC_SOURCE_UNCHANGED',
      );
      assert.equal(
        readdirSync(join(f.root, 'runtimes')).filter((n) => /^[a-f0-9]{64}$/.test(n)).length,
        1,
      );
      assert.ok(existsSync(join(f.root, 'execution/ledger.db')));
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

test('a lost committed active pointer fails closed and never rolls back to the previous runtime', (t) => {
  const f = fixture(t),
    r = f.service.prepare({
      kind: 'prepareRestore',
      backupId: f.backup.backup.id,
      commandKey: 'restore',
    });
  f.service.checkActivation({ kind: 'activateRestore', restoreId: r.id });
  f.close();
  f.service.activateAfterOwnerStopped(r.id);
  assert.equal(activeRuntimePaths(f.root).generation, r.id);
  rmSync(join(f.root, 'runtimes/active.json'));
  assert.throws(() => activeRuntimePaths(f.root), /RESTORE_ACTIVE_POINTER_MISSING/);
  assert.ok(existsSync(join(f.root, 'execution/ledger.db')));
});
