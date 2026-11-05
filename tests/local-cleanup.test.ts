import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPrivacyCleanup } from '../packages/runtime/src/local-cleanup.ts';

const hashA = 'a'.repeat(64),
  hashB = 'b'.repeat(64),
  related = '11111111-1111-4111-8111-111111111111.json',
  other = '22222222-2222-4222-8222-222222222222.json';
function fixture(t: { after(fn: () => void): void }, runtime = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-local-cleanup-'))),
    root = join(parent, 'app'),
    generation = join(root, 'runtimes', hashA),
    database = runtime ? join(generation, 'ledger.db') : join(root, 'execution/ledger.db'),
    verification = runtime ? generation : join(root, 'verification');
  mkdirSync(join(database, '..'), { recursive: true });
  mkdirSync(join(verification, 'artifacts'), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE public_active(value TEXT); INSERT INTO public_active VALUES ('PUBLIC_ACTIVE_LEDGER_UNCHANGED')",
  );
  const source = join(parent, 'source/index.txt'),
    credential = join(parent, 'credentials/auth.json'),
    appCredential = join(root, 'credentials/public-login.json');
  for (const file of [source, credential, appCredential]) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, 'PUBLIC_PROTECTED_' + file.split('/').at(-1));
  }
  const cleanup = new LocalPrivacyCleanup({ storageRoot: root, database, verification });
  const snapshot = (relative: string) => {
    const path = join(root, relative);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'ledger.db'), 'PUBLIC_OLD_COPY');
    return path;
  };
  t.after(() => {
    db.close();
    rmSync(parent, { recursive: true, force: true });
  });
  return {
    root,
    parent,
    database,
    verification,
    db,
    source,
    credential,
    appCredential,
    cleanup,
    snapshot,
  };
}
test('controlled artifacts are physically removed by exact key while other receipts, active SQLite, sources and credentials stay intact', (t) => {
  const f = fixture(t),
    artifacts = join(f.verification, 'artifacts');
  writeFileSync(join(artifacts, related), 'PUBLIC_RELATED_RECEIPT');
  writeFileSync(join(artifacts, other), 'PUBLIC_UNRELATED_RECEIPT');
  const result = f.cleanup.purgeArtifacts([related, related]);
  assert.deepEqual(result, { purgedKeys: [related] });
  assert.equal(existsSync(join(artifacts, related)), false);
  assert.equal(readFileSync(join(artifacts, other), 'utf8'), 'PUBLIC_UNRELATED_RECEIPT');
  assert.equal(
    f.db.prepare('SELECT value FROM public_active').get()!.value,
    'PUBLIC_ACTIVE_LEDGER_UNCHANGED',
  );
  for (const path of [f.source, f.credential, f.appCredential])
    assert.ok(readFileSync(path, 'utf8').startsWith('PUBLIC_PROTECTED_'));
});
test('app-owned backup/rehearsal/runtime and Codex-state copies are removed without deleting the active legacy ledger', (t) => {
  const f = fixture(t),
    copies = [
      f.snapshot('backups/' + hashA),
      f.snapshot('backups/' + hashB + '.pending'),
      f.snapshot('rehearsals/' + hashA),
      f.snapshot('runtimes/' + hashB),
      f.snapshot('codex-state'),
    ];
  writeFileSync(join(f.root, 'runtimes/active.json'), 'PUBLIC_POINTER_UNCHANGED');
  f.cleanup.purgeSnapshots();
  for (const path of copies) assert.equal(existsSync(path), false, path);
  assert.equal(
    readFileSync(join(f.root, 'runtimes/active.json'), 'utf8'),
    'PUBLIC_POINTER_UNCHANGED',
  );
  assert.equal(
    f.db.prepare('SELECT value FROM public_active').get()!.value,
    'PUBLIC_ACTIVE_LEDGER_UNCHANGED',
  );
  for (const path of [f.source, f.credential, f.appCredential]) assert.ok(existsSync(path));
});
test('an active runtime generation remains usable while current export and old legacy/runtime copies are purged', (t) => {
  const f = fixture(t, true),
    active = join(f.root, 'runtimes', hashA),
    old = f.snapshot('runtimes/' + hashB),
    legacy = join(f.root, 'execution/ledger.db');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(legacy, 'PUBLIC_OLD_LEGACY');
  for (const suffix of ['', '-wal', '-shm'])
    writeFileSync(join(active, 'current.db' + suffix), 'PUBLIC_CURRENT_EXPORT');
  writeFileSync(join(f.verification, 'artifacts', other), 'PUBLIC_ACTIVE_RECEIPT');
  f.cleanup.purgeSnapshots();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(legacy), false);
  for (const suffix of ['', '-wal', '-shm'])
    assert.equal(existsSync(join(active, 'current.db' + suffix)), false);
  assert.equal(
    readFileSync(join(f.verification, 'artifacts', other), 'utf8'),
    'PUBLIC_ACTIVE_RECEIPT',
  );
  assert.equal(
    f.db.prepare('SELECT value FROM public_active').get()!.value,
    'PUBLIC_ACTIVE_LEDGER_UNCHANGED',
  );
});
test('invalid keys, unexpected snapshot names and symlinks are rejected without following user paths', (t) => {
  const f = fixture(t),
    artifacts = join(f.verification, 'artifacts');
  writeFileSync(join(artifacts, related), 'PUBLIC_RECEIPT');
  for (const key of ['../source/index.txt', '/private/file.json', 'not-a-uuid.json'])
    assert.throws(() => f.cleanup.purgeArtifacts([related, key]), /PRIVACY_CLEANUP_SCOPE_CHANGED/);
  assert.ok(existsSync(join(artifacts, related)));
  rmSync(join(artifacts, related));
  symlinkSync(f.source, join(artifacts, related));
  assert.throws(() => f.cleanup.purgeArtifacts([related]), /PRIVACY_CLEANUP_SCOPE_CHANGED/);
  assert.ok(readFileSync(f.source, 'utf8').startsWith('PUBLIC_PROTECTED_'));
  const copy = f.snapshot('backups/' + hashA);
  symlinkSync(f.credential, join(copy, 'public-link'));
  assert.throws(() => f.cleanup.purgeSnapshots(), /PRIVACY_CLEANUP_SCOPE_CHANGED/);
  assert.ok(existsSync(f.credential));
  rmSync(copy, { recursive: true });
  f.snapshot('backups/user-folder');
  assert.throws(() => f.cleanup.purgeSnapshots(), /PRIVACY_CLEANUP_SCOPE_CHANGED/);
});
test('a replaced storage-root inode is rejected even if the canonical path string stays identical', (t) => {
  const f = fixture(t);
  renameSync(f.root, f.root + '-original');
  mkdirSync(join(f.root, 'backups', hashA), { recursive: true });
  const replacement = join(f.root, 'backups', hashA, 'public-new-owner.txt');
  writeFileSync(replacement, 'PUBLIC_REPLACEMENT_UNCHANGED');
  assert.throws(() => f.cleanup.purgeSnapshots(), /PRIVACY_CLEANUP_SCOPE_CHANGED/);
  assert.equal(readFileSync(replacement, 'utf8'), 'PUBLIC_REPLACEMENT_UNCHANGED');
});
test('an external verification root cannot authorize deleting an outside receipt', (t) => {
  const f = fixture(t),
    outside = join(f.parent, 'outside-verification');
  mkdirSync(join(outside, 'artifacts'), { recursive: true });
  const file = join(outside, 'artifacts', related);
  writeFileSync(file, 'PUBLIC_OUTSIDE_RECEIPT_UNCHANGED');
  assert.throws(() => {
    const cleanup = new LocalPrivacyCleanup({
      storageRoot: f.root,
      database: f.database,
      verification: outside,
    });
    cleanup.purgeArtifacts([related]);
  }, /PRIVACY_CLEANUP_SCOPE_CHANGED/);
  assert.equal(readFileSync(file, 'utf8'), 'PUBLIC_OUTSIDE_RECEIPT_UNCHANGED');
});
