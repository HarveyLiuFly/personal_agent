import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
  readdirSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { BackupService } from '../packages/backup/src/service.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-backup-'))),
    file = join(root, 'live.db'),
    store = new ExecutionLedger(file, schema);
  store.startOwner('backup-owner', true);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const project = store.registerWorkspace(workspace),
    db = new DatabaseSync(file),
    directory = join(root, 'backups'),
    receipts = join(root, 'receipts');
  t.after(() => {
    store.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(receipts, { mode: 0o700 });
  const service = new BackupService(store, { directory, verificationDirectory: receipts });
  return { root, file, store, project, db, directory, receipts, service };
}
function seedReceipt(f: ReturnType<typeof fixture>) {
  // Explicit synthetic unknown verification metadata; no verifier/model/tool execution is claimed.
  const { token } = f.store.beginRun(
      f.project.id,
      'public backup fixture',
      'synthetic-run',
      'readOnly',
    ),
    task = f.store.runForHost(token.runId).taskId,
    id = randomUUID(),
    spec = randomUUID(),
    content = '{"status":"unknown","publicFixture":true}\n',
    key = id + '.json';
  writeFileSync(join(f.receipts, key), content, { mode: 0o600 });
  f.db
    .prepare("INSERT INTO verification_specs VALUES (?,?,1,NULL,'[]','[]','{}',?)")
    .run(spec, task, '0'.repeat(64));
  f.db
    .prepare(
      "INSERT INTO artifacts(artifact_id,dot_id,task_id,content_sha256,relative_storage_key,state,sensitivity,privacy_epoch,size_bytes) VALUES (?,?,?, ?,?,'published','private',1,?)",
    )
    .run(id, f.store.dotId, task, sha(content), key, Buffer.byteLength(content));
  f.db
    .prepare("INSERT INTO verification_results VALUES (?,?,?,'unknown',NULL,NULL,NULL,?,?)")
    .run(id, token.runId, spec, id, Date.now());
  return { key, id, content };
}
test('consistent backup includes real committed WAL and dedupes without replaying or changing live tasks', (t) => {
  const f = fixture(t);
  f.db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  const task = f.store.taskCommand({
    kind: 'create',
    projectId: f.project.id,
    commandKey: 'task',
    text: 'Public WAL-only task',
  });
  assert.ok(statSync(f.file + '-wal').size > 0);
  const result = f.service.command({ kind: 'create', commandKey: 'backup' });
  assert.equal(result.backup.id, sha('backup'));
  assert.equal(result.verification.files, 1);
  const snapshot = new DatabaseSync(join(f.directory, result.backup.id, 'ledger.db'), {
    readOnly: true,
  });
  try {
    assert.equal(
      snapshot.prepare('SELECT title FROM tasks WHERE task_id=?').get(task.taskId)!.title,
      'Public WAL-only task',
    );
    assert.equal(
      snapshot.prepare('SELECT runtime_epoch FROM runtime_owners').get()!.runtime_epoch,
      1,
    );
    assert.equal(snapshot.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  } finally {
    snapshot.close();
  }
  f.store.taskCommand({
    kind: 'rename',
    projectId: f.project.id,
    commandKey: 'rename',
    taskId: task.taskId,
    expectedVersion: task.taskVersion,
    title: 'New live title',
  });
  const again = f.service.command({ kind: 'create', commandKey: 'backup' });
  assert.equal(again.backup.createdAt, result.backup.createdAt);
  assert.equal(f.service.list().items.length, 1);
  assert.equal(f.store.tasks(f.project.id)[0]!.title, 'New live title');
  assert.equal(f.store.runs(f.project.id).length, 0);
  assert.equal(statSync(join(f.directory, result.backup.id)).mode & 0o777, 0o700);
  for (const name of ['ledger.db', 'manifest.json'])
    assert.equal(statSync(join(f.directory, result.backup.id, name)).mode & 0o777, 0o600);
});
test('real receipt files and snapshot watermarks are verified; validation never starts an old Owner', (t) => {
  const f = fixture(t),
    r = seedReceipt(f);
  f.db
    .prepare('INSERT INTO privacy_tombstones VALUES (?,?,2,?)')
    .run(f.store.dotId, 'public-deleted-source', 12345);
  f.db.exec('UPDATE dots SET policy_epoch=4,privacy_epoch=2');
  const result = f.service.command({ kind: 'create', commandKey: 'with-receipt' });
  assert.equal(result.verification.files, 2);
  assert.equal(result.verification.activeRuns, 1);
  assert.equal(result.verification.tombstones, 1);
  assert.equal(result.verification.policyEpoch, 4);
  assert.equal(result.verification.privacyEpoch, 2);
  assert.equal(
    readFileSync(join(f.directory, result.backup.id, 'receipts', r.key), 'utf8'),
    r.content,
  );
  f.db.exec('UPDATE dots SET policy_epoch=5,privacy_epoch=3');
  const verified = f.service.command({ kind: 'verify', backupId: result.backup.id });
  assert.equal(verified.verification.privacyEpoch, 2);
  assert.equal(f.db.prepare('SELECT privacy_epoch FROM dots').get()!.privacy_epoch, 3);
  assert.equal(f.db.prepare('SELECT runtime_epoch FROM runtime_owners').get()!.runtime_epoch, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n, 0);
});
test('missing or changed receipt refuses publication, preserves incomplete state and refuses same-key retry', (t) => {
  for (const missing of [true, false]) {
    const f = fixture(t),
      r = seedReceipt(f);
    if (missing) rmSync(join(f.receipts, r.key));
    else writeFileSync(join(f.receipts, r.key), 'changed');
    assert.throws(() => f.service.command({ kind: 'create', commandKey: 'incomplete' }));
    const rows = f.service.list();
    assert.equal(rows.items[0]!.state, 'incomplete');
    assert.equal(existsSync(join(f.directory, sha('incomplete'))), false);
    assert.throws(
      () => f.service.command({ kind: 'create', commandKey: 'incomplete' }),
      /BACKUP_INCOMPLETE_OR_INVALID/,
    );
    assert.equal(
      readFileSync(join(f.directory, sha('incomplete') + '.pending', 'ledger.db')).length > 0,
      true,
    );
  }
});
test('copied file corruption, receipt symlink and reference mismatch fail explicit verification', (t) => {
  for (const kind of ['database', 'receipt', 'symlink', 'manifest']) {
    const f = fixture(t),
      r = seedReceipt(f),
      result = f.service.command({ kind: 'create', commandKey: kind }),
      path = join(f.directory, result.backup.id);
    if (kind === 'database') writeFileSync(join(path, 'ledger.db'), 'broken');
    if (kind === 'receipt') writeFileSync(join(path, 'receipts', r.key), 'changed');
    if (kind === 'symlink') {
      rmSync(join(path, 'receipts', r.key));
      symlinkSync(join(f.receipts, r.key), join(path, 'receipts', r.key));
    }
    if (kind === 'manifest') {
      const m = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
      m.metadata.privacyEpoch = 999;
      writeFileSync(join(path, 'manifest.json'), JSON.stringify(m));
    }
    assert.throws(() => f.service.command({ kind: 'verify', backupId: result.backup.id }));
    assert.equal(f.db.prepare('SELECT runtime_epoch FROM runtime_owners').get()!.runtime_epoch, 1);
  }
});
test('arbitrary fields, paths and unknown published artifact kinds are refused before any external file read', (t) => {
  const f = fixture(t);
  for (const command of [
    { kind: 'create', commandKey: 'x', path: '/etc' },
    { kind: 'verify', backupId: '../x' },
    { kind: 'restore', backupId: '0'.repeat(64) },
  ])
    assert.throws(() => f.service.command(command as never), /INVALID_BACKUP_COMMAND/);
  assert.equal(f.service.list().items.length, 0);
  const r = seedReceipt(f);
  f.db
    .prepare('UPDATE artifacts SET relative_storage_key=? WHERE artifact_id=?')
    .run('../credentials.json', r.id);
  assert.throws(
    () => f.service.command({ kind: 'create', commandKey: 'bad-ref' }),
    /BACKUP_ARTIFACT_UNSUPPORTED/,
  );
});
test('private root identity, source receipt symlink, stale Owner and bounded inventory are enforced', (t) => {
  const f = fixture(t),
    r = seedReceipt(f);
  rmSync(join(f.receipts, r.key));
  writeFileSync(join(f.root, 'public.json'), r.content);
  symlinkSync(join(f.root, 'public.json'), join(f.receipts, r.key));
  assert.throws(() => f.service.command({ kind: 'create', commandKey: 'source-link' }));
  const next = new ExecutionLedger(f.file, schema);
  try {
    next.startOwner('new-owner', true);
    assert.throws(() => f.store.snapshotForBackup(join(f.root, 'stale.db')), /STALE_RUNTIME_OWNER/);
    assert.equal(existsSync(join(f.root, 'stale.db')), false);
  } finally {
    next.close();
  }
  const other = join(f.root, 'capacity');
  mkdirSync(other, { mode: 0o700 });
  for (let i = 0; i < 20; i++)
    mkdirSync(join(other, sha('entry' + i) + '.pending'), { mode: 0o700 });
  const service = new BackupService(f.store, {
    directory: other,
    verificationDirectory: f.receipts,
  });
  assert.equal(service.list().items.length, 20);
  assert.throws(
    () => service.command({ kind: 'create', commandKey: 'overflow' }),
    /BACKUP_COUNT_LIMIT/,
  );
  assert.equal(readdirSync(other).length, 20);
  const linked = join(f.root, 'link');
  symlinkSync(other, linked);
  assert.throws(
    () => new BackupService(f.store, { directory: linked, verificationDirectory: f.receipts }),
    /BACKUP_DIRECTORY_CHANGED/,
  );
});
test('publication refuses a newly occupied target and filesystem write failure keeps only an incomplete copy', (t) => {
  for (const kind of ['occupied', 'denied']) {
    const f = fixture(t),
      service = new BackupService(f.store, {
        directory: f.directory,
        verificationDirectory: f.receipts,
        afterStage: () => {
          if (kind === 'occupied') mkdirSync(join(f.directory, sha(kind)), { mode: 0o700 });
          else {
            const error = new Error('injected filesystem write failure');
            Object.assign(error, { code: 'ENOSPC' });
            throw error;
          }
        },
      });
    assert.throws(
      () => service.command({ kind: 'create', commandKey: kind }),
      kind === 'occupied' ? /BACKUP_TARGET_EXISTS/ : /BACKUP_OPERATION_FAILED/,
    );
    assert.equal(existsSync(join(f.directory, sha(kind) + '.pending', 'ledger.db')), true);
    assert.equal(existsSync(join(f.directory, sha(kind), 'manifest.json')), false);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 0);
  }
});
test('unsupported receipt sizes and extra copied files cannot pass integrity checks', (t) => {
  const f = fixture(t),
    r = seedReceipt(f);
  f.db.prepare('UPDATE artifacts SET size_bytes=1048577 WHERE artifact_id=?').run(r.id);
  assert.throws(
    () => f.service.command({ kind: 'create', commandKey: 'oversized' }),
    /BACKUP_ARTIFACT_UNSUPPORTED/,
  );
  f.db
    .prepare('UPDATE artifacts SET size_bytes=? WHERE artifact_id=?')
    .run(Buffer.byteLength(r.content), r.id);
  const result = f.service.command({ kind: 'create', commandKey: 'valid' });
  writeFileSync(join(f.directory, result.backup.id, 'unexpected.txt'), 'public');
  assert.throws(
    () => f.service.command({ kind: 'verify', backupId: result.backup.id }),
    /BACKUP_FILES_MISMATCH/,
  );
});
test('real FIFO manifest, copied receipt and source receipt are refused without blocking the Host', (t) => {
  for (const kind of ['manifest', 'copied', 'source']) {
    const f = fixture(t),
      r = seedReceipt(f),
      result = f.service.command({ kind: 'create', commandKey: 'before-fifo' }),
      path =
        kind === 'manifest'
          ? join(f.directory, result.backup.id, 'manifest.json')
          : kind === 'copied'
            ? join(f.directory, result.backup.id, 'receipts', r.key)
            : join(f.receipts, r.key);
    rmSync(path);
    execFileSync('mkfifo', [path]);
    const output = execFileSync(
      process.execPath,
      [
        resolve('tests/fixtures/backup-fifo-worker.ts'),
        f.file,
        f.directory,
        f.receipts,
        result.backup.id,
        kind,
      ],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.equal(output.trim(), 'FIFO_REJECTED');
  }
});
for (const stage of ['snapshot', 'published'] as const)
  test(`real Host SIGKILL at backup ${stage} never publishes partial state or retries the old copy`, async (t) => {
    const f = fixture(t),
      child = spawn(
        process.execPath,
        [resolve('tests/fixtures/backup-crash-worker.ts'), f.file, f.directory, f.receipts, stage],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      await new Promise<void>((done, reject) => {
        child.stdout.on('data', (data) => {
          output += data;
          if (output.includes('\n')) done();
        });
        child.once('exit', () => reject(Error('BACKUP_CHILD_EXITED_EARLY')));
      });
      const pending = stage === 'snapshot';
      assert.equal(existsSync(join(f.directory, sha('crash') + (pending ? '.pending' : ''))), true);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      const [code, signal] = await exited;
      assert.equal(code, null);
      assert.equal(signal, 'SIGKILL');
      const item = f.service.list().items[0]!;
      assert.equal(item.state, pending ? 'incomplete' : 'available');
      if (pending) {
        assert.throws(
          () => f.service.command({ kind: 'create', commandKey: 'crash' }),
          /BACKUP_INCOMPLETE_OR_INVALID/,
        );
        assert.equal(existsSync(join(f.directory, item.id)), false);
      } else {
        assert.equal(f.service.command({ kind: 'create', commandKey: 'crash' }).backup.id, item.id);
        assert.equal(f.service.list().items.length, 1);
      }
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n, 0);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
