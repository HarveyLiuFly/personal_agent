import { resolveVerifierNode } from '../packages/codex-adapter/src/launch.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  readdirSync,
  existsSync,
  statSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { WorktreeService } from '../packages/workspace/src/worktrees.ts';
import { WorkspaceService, resolveWorkspaceGit } from '../packages/workspace/src/service.ts';
import { legacySchema } from './fixtures/schema-history.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8'),
  git = resolveWorkspaceGit(),
  worker = resolve('packages/workspace/src/worktree-worker.mjs'),
  node = resolveVerifierNode(resolve('.'));
function fixture(
  t: { after(fn: () => void): void },
  options: Partial<ConstructorParameters<typeof WorktreeService>[1]> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-worktrees-'))),
    cwd = join(root, 'source');
  mkdirSync(cwd);
  const g = (...args: string[]) =>
    execFileSync(git, ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
  g('init', '-b', 'main');
  g('config', 'user.email', 'fixture@example.invalid');
  g('config', 'user.name', 'Fixture');
  writeFileSync(join(cwd, 'file.txt'), 'base\n');
  writeFileSync(join(cwd, '.gitignore'), 'ignored\n');
  g('add', '.');
  g('commit', '-m', 'baseline');
  const file = join(root, 'ledger.db'),
    store = new ExecutionLedger(file, schema);
  store.startOwner('worktree-owner', true);
  const project = store.registerWorkspace(cwd, cwd),
    db = new DatabaseSync(file),
    service = new WorktreeService(store, {
      git,
      node,
      worker,
      stateDirectory: join(root, 'state'),
      ...options,
    });
  t.after(() => {
    store.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const create = (key = 'create') =>
    service.command({ kind: 'create', projectId: project.id, commandKey: key, name: '功能工作树' });
  return { root, cwd, g, file, store, project, db, service, create };
}
test('real Git creates an isolated managed branch from committed HEAD, dedupes, and removes without deleting branch', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, 'file.txt'), 'original dirty\n');
  const page = await f.create(),
    w = page.worktrees[0]!;
  assert.equal(page.operations[0]!.state, 'completed');
  assert.equal(readFileSync(join(w.directory, 'file.txt'), 'utf8'), 'base\n');
  assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'original dirty\n');
  assert.equal(f.store.registerWorkspace(w.directory).id, w.id);
  assert.equal((await f.create()).worktrees.length, 1);
  await assert.rejects(
    () =>
      f.service.command({
        kind: 'create',
        projectId: f.project.id,
        commandKey: 'create',
        name: 'changed',
      }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const check = f.service.inspect(f.project.id, w.id);
  assert.equal(check.canRemove, true);
  const input = {
    kind: 'remove' as const,
    projectId: f.project.id,
    commandKey: 'remove',
    workspaceId: w.id,
    expectedVersion: w.version,
    inspectionId: check.inspectionId,
  };
  const removed = await f.service.command(input);
  assert.equal(removed.worktrees.length, 0);
  assert.equal(removed.operations[0]!.state, 'completed');
  assert.equal(existsSync(w.directory), false);
  assert.equal(f.g('rev-parse', w.branch), w.baseCommit);
  assert.throws(() => f.store.workspace(w.id), /PROJECT_ARCHIVED/);
  await f.service.command(input);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM execution_intents').get()!.n, 0);
});
test('tracked, untracked, ignored files and unmerged commits prevent removal and remain intact', async (t) => {
  const f = fixture(t);
  let w = (await f.create()).worktrees[0]!;
  const dirty = [
    ['file.txt', 'TRACKED_CHANGES'],
    ['new.txt', 'UNTRACKED_FILES'],
    ['ignored', 'IGNORED_FILES'],
  ] as const;
  for (const [path, reason] of dirty) {
    writeFileSync(join(w.directory, path), 'keep\n');
    const i = f.service.inspect(f.project.id, w.id);
    assert.ok(i.reasons.includes(reason));
    await assert.rejects(
      () =>
        f.service.command({
          kind: 'remove',
          projectId: f.project.id,
          commandKey: 'remove-' + path,
          workspaceId: w.id,
          expectedVersion: 1,
          inspectionId: i.inspectionId,
        }),
      /WORKTREE_REMOVE_UNSAFE/,
    );
    assert.equal(readFileSync(join(w.directory, path), 'utf8'), 'keep\n');
    if (path === 'file.txt') writeFileSync(join(w.directory, path), 'base\n');
    else rmSync(join(w.directory, path));
  }
  execFileSync(
    git,
    [
      '-C',
      w.directory,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'keep-branch',
    ],
    { stdio: 'ignore' },
  );
  assert.equal(f.service.inspect(f.project.id, w.id).unmergedCommits, true);
  assert.ok(existsSync(w.directory));
});
test('fresh inspection, task state and project exclusion are enforced without creating model Runs', async (t) => {
  const f = fixture(t),
    w = (await f.create()).worktrees[0]!,
    i = f.service.inspect(f.project.id, w.id);
  writeFileSync(join(w.directory, 'new'), 'changed');
  await assert.rejects(
    () =>
      f.service.command({
        kind: 'remove',
        projectId: f.project.id,
        commandKey: 'stale',
        workspaceId: w.id,
        expectedVersion: 1,
        inspectionId: i.inspectionId,
      }),
    /WORKTREE_REMOVE_UNSAFE/,
  );
  rmSync(join(w.directory, 'new'));
  const task = f.store.taskCommand({
    kind: 'create',
    projectId: w.id,
    commandKey: 'queued',
    text: 'pending',
  });
  assert.equal(f.service.inspect(f.project.id, w.id).pendingTasks, 1);
  f.store.taskCommand({
    kind: 'cancel',
    projectId: w.id,
    commandKey: 'cancel',
    taskId: task.taskId,
    expectedVersion: task.taskVersion,
  });
  assert.equal(f.service.inspect(f.project.id, w.id).pendingTasks, 0);
  const source = f.service.snapshot(f.cwd),
    op = f.store.prepareWorktree(
      f.project.id,
      'lease',
      { name: 'lease' },
      'create',
      source,
      join(f.root, 'state', 'trees'),
    );
  assert.throws(
    () => f.store.beginRun(f.project.id, 'read also waits', 'read', 'readOnly'),
    /WORKSPACE_BUSY/,
  );
  assert.throws(
    () =>
      f.store.taskCommand({
        kind: 'create',
        projectId: w.id,
        commandKey: 'blocked',
        text: 'blocked',
      }),
    /WORKSPACE_BUSY/,
  );
  f.store.finishWorktree(f.project.id, op.operationId, 'failed');
  assert.ok(f.store.beginRun(f.project.id, 'released', 'read', 'readOnly'));
  await assert.rejects(() => f.create('active'), /WORKSPACE_BUSY/);
});
test('unsupported helpers and unmanaged linked roots fail before a Git write', async (t) => {
  const f = fixture(t);
  f.g('config', 'filter.bad.clean', 'touch ' + join(f.root, 'helper-ran'));
  await assert.rejects(() => f.create(), /WORKTREE_FILTERS_UNSUPPORTED/);
  assert.equal(existsSync(join(f.root, 'helper-ran')), false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM worktree_operations').get()!.n, 0);
  f.g('config', '--remove-section', 'filter.bad');
  const linked = join(f.root, 'external');
  f.g('worktree', 'add', '-b', 'external', linked);
  assert.throws(() => f.service.snapshot(linked), /WORKTREE_UNMANAGED_LINK/);
});
test('lost Git result is Unknown, never resent, and explicit reconciliation adopts the one actual worktree', async (t) => {
  const f = fixture(t, {
      afterGit: () => {
        throw Error('controlled result gap');
      },
    }),
    page = await f.create(),
    op = page.operations[0]!;
  assert.equal(op.state, 'outcome_unknown');
  assert.equal(page.worktrees.length, 0);
  await f.create();
  assert.equal(f.store.worktreeOperations(f.project.id).length, 1);
  assert.throws(
    () => f.store.beginRun(f.project.id, 'blocked', 'blocked', 'readOnly'),
    /WORKSPACE_BUSY/,
  );
  const reconciled = await f.service.command({
    kind: 'reconcile',
    projectId: f.project.id,
    operationId: op.operationId,
  });
  assert.equal(reconciled.worktrees.length, 1);
  assert.equal(reconciled.operations[0]!.state, 'completed');
  assert.equal(
    f
      .g('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((s) => s.startsWith('worktree ')).length,
    2,
  );
});
test('Owner recovery distinguishes unsent preparation from dispatch and retains Unknown project lease', (t) => {
  const f = fixture(t),
    source = f.service.snapshot(f.cwd),
    a = f.store.prepareWorktree(
      f.project.id,
      'prepared',
      { name: 'prepared' },
      'create',
      source,
      join(f.root, 'trees'),
    );
  const second = new ExecutionLedger(f.file, schema);
  second.startOwner('second-owner', true);
  assert.equal(second.worktreeDispatch(f.project.id, a.operationId).state, 'failed');
  const b = second.prepareWorktree(
    f.project.id,
    'dispatch',
    { name: 'dispatch' },
    'create',
    source,
    join(f.root, 'trees'),
  );
  second.dispatchWorktree(f.project.id, b.operationId, 99999999);
  second.close();
  const third = new ExecutionLedger(f.file, schema);
  try {
    third.startOwner('third-owner', true);
    assert.equal(third.worktreeDispatch(f.project.id, b.operationId).state, 'outcome_unknown');
    assert.throws(
      () => third.beginRun(f.project.id, 'must wait', 'wait', 'readOnly'),
      /WORKSPACE_BUSY/,
    );
    assert.throws(
      () => f.store.finishWorktree(f.project.id, a.operationId, 'failed'),
      /STALE_RUNTIME_OWNER/,
    );
  } finally {
    third.close();
  }
});
test('revision 4 WAL migration backs up actual data and creates revision 6 atomically', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-worktree-migration-'))),
    file = join(root, 'old.db'),
    db = new DatabaseSync(file);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  db.exec(legacySchema(schema, 4));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO profiles VALUES ('fixture','WAL data',1)",
  );
  const store = new ExecutionLedger(file, schema);
  try {
    assert.equal(db.prepare('SELECT schema_revision AS n FROM schema_metadata').get()!.n, 6);
    const backup = join(
      root,
      readdirSync(root).find((n) => n.endsWith('.backup'))!,
    );
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    const saved = new DatabaseSync(backup, { readOnly: true });
    try {
      assert.equal(
        saved.prepare('SELECT display_name FROM profiles').get()!.display_name,
        'WAL data',
      );
      assert.equal(saved.prepare('SELECT schema_revision AS n FROM schema_metadata').get()!.n, 4);
      assert.equal(saved.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    } finally {
      saved.close();
    }
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    store.close();
    db.close();
  }
});
test('revision 4 failed migration rolls all new tables and metadata back', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-worktree-rollback-'))),
    file = join(root, 'old.db'),
    db = new DatabaseSync(file);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(legacySchema(schema, 4));
  assert.throws(
    () =>
      new ExecutionLedger(
        file,
        schema.replace(
          'git_identity_json TEXT NOT NULL CHECK (json_valid(git_identity_json))',
          'git_identity_json TEXT NOT NULL CHECK (no_such_column = 1)',
        ),
      ),
  );
  assert.equal(db.prepare('SELECT schema_revision AS n FROM schema_metadata').get()!.n, 4);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('worktree_operations','project_operation_leases','managed_worktrees')",
      )
      .get()!.n,
    0,
  );
});
for (const stage of ['prepared', 'dispatch', 'result'])
  test(`real Host SIGKILL at ${stage} preserves committed Git intent and requires explicit recovery`, async (t) => {
    const f = fixture(t),
      child = spawn(
        process.execPath,
        [
          resolve('tests/fixtures/worktree-crash-worker.ts'),
          f.file,
          f.cwd,
          join(f.root, 'state'),
          git,
          stage,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    let output = '';
    const ready = new Promise<void>((done, reject) => {
      child.stdout.on('data', (data) => {
        output += data;
        if (output.includes('\n')) done();
      });
      child.once('exit', () => reject(Error('EARLY_CHILD_EXIT')));
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    try {
      await ready;
      const row = f.db.prepare('SELECT * FROM worktree_operations').get()!;
      assert.equal(row.state, stage === 'prepared' ? 'prepared' : 'dispatching');
      assert.equal(row.supervisor_pid === null, stage === 'prepared');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      const [code, signal] = await exited;
      assert.equal(code, null);
      assert.equal(signal, 'SIGKILL');
      if (row.supervisor_pid) {
        const pid = Number(row.supervisor_pid),
          deadline = Date.now() + 4000;
        while (true) {
          let gone = false;
          try {
            process.kill(-pid, 0);
          } catch (e) {
            gone = (e as NodeJS.ErrnoException).code === 'ESRCH';
          }
          if (gone) break;
          if (Date.now() > deadline) throw Error('OWNED_GROUP_STILL_ALIVE');
          await new Promise((done) => setTimeout(done, 20));
        }
      }
      const next = new ExecutionLedger(f.file, schema);
      try {
        next.startOwner('after-actual-sigkill-' + stage, true);
        const recovered = next.worktreeDispatch(f.project.id, String(row.operation_id));
        assert.equal(recovered.state, stage === 'prepared' ? 'failed' : 'outcome_unknown');
        const service = new WorktreeService(next, {
          git,
          node,
          worker,
          stateDirectory: join(f.root, 'state'),
        });
        if (stage !== 'prepared') {
          const page = await service.command({
            kind: 'reconcile',
            projectId: f.project.id,
            operationId: recovered.operationId,
          });
          assert.equal(page.operations[0]!.state, stage === 'result' ? 'completed' : 'failed');
          assert.equal(page.worktrees.length, stage === 'result' ? 1 : 0);
        }
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n, 0);
      } finally {
        next.close();
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
test('a last-moment ignored file survives removal in the private atomic recovery directory', async (t) => {
  let directory = '';
  const f = fixture(t, {
      afterDispatch: () => {
        if (directory) writeFileSync(join(directory, 'ignored'), 'RACE_PRESERVED\n');
      },
    }),
    w = (await f.create()).worktrees[0]!;
  directory = w.directory;
  const i = f.service.inspect(f.project.id, w.id);
  assert.equal(i.canRemove, true);
  await f.service.command({
    kind: 'remove',
    projectId: f.project.id,
    commandKey: 'archive-race',
    workspaceId: w.id,
    expectedVersion: 1,
    inspectionId: i.inspectionId,
  });
  const row = f.db
      .prepare("SELECT payload_json FROM worktree_operations WHERE kind='remove'")
      .get()!,
    payload = JSON.parse(String(row.payload_json));
  assert.equal(
    readFileSync(join(payload.recoveryDirectory, 'ignored'), 'utf8'),
    'RACE_PRESERVED\n',
  );
  assert.equal(existsSync(directory), false);
  assert.equal(
    f
      .g('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((s) => s.startsWith('worktree ')).length,
    1,
  );
});
test('managed linked Git previews use the recorded metadata identity, while retargeting is rejected', async (t) => {
  const f = fixture(t),
    w = (await f.create()).worktrees[0]!,
    reader = new WorkspaceService((id) => f.store.workspace(id), {
      node,
      cli: process.execPath,
      git,
      worker: resolve('packages/workspace/src/reader.mjs'),
      stateDirectory: join(f.root, 'reader'),
      managedGit: (id) => f.store.worktreeMetadata(id),
      withoutSandboxForTests: true,
    });
  writeFileSync(join(w.directory, 'file.txt'), 'managed edit\n');
  const view = await reader.overview({ projectId: w.id });
  assert.equal(view.git.available, true);
  assert.equal(view.git.branch, w.branch);
  const diff = await reader.diff({
    projectId: w.id,
    changeId: view.git.changes[0]!.id,
    part: 'unstaged',
  });
  assert.ok(diff.text.includes('+managed edit'));
  writeFileSync(join(w.directory, '.git'), 'gitdir: ' + join(f.cwd, '.git') + '\n');
  assert.throws(() => f.store.workspace(w.id), /WORKTREE_IDENTITY_CHANGED/);
  await assert.rejects(() => reader.overview({ projectId: w.id }), /WORKTREE_IDENTITY_CHANGED/);
});
test('a foreign workspace, raw argv and a changed branch cannot authorize managed removal', async (t) => {
  const f = fixture(t),
    w = (await f.create()).worktrees[0]!;
  mkdirSync(join(f.root, 'foreign'));
  const foreign = f.store.registerWorkspace(join(f.root, 'foreign'), join(f.root, 'foreign'));
  assert.throws(() => f.service.inspect(foreign.id, w.id), /WORKTREE_SCOPE_MISMATCH/);
  await assert.rejects(
    () =>
      f.service.command({
        kind: 'create',
        projectId: f.project.id,
        commandKey: 'argv',
        name: 'bad',
        args: ['status'],
      } as never),
    /INVALID_WORKTREE_COMMAND/,
  );
  execFileSync(git, ['-C', w.directory, 'checkout', '-b', 'other-branch'], { stdio: 'ignore' });
  assert.throws(() => f.service.inspect(f.project.id, w.id), /WORKTREE_BRANCH_CHANGED/);
  assert.ok(existsSync(w.directory));
});
async function archiveGap(
  t: Parameters<typeof fixture>[0],
  extra: Partial<ConstructorParameters<typeof WorktreeService>[1]> = {},
) {
  const revealed: string[] = [],
    f = fixture(t, {
      afterArchived: () => {
        throw Error('owned archive-to-Git gap');
      },
      reveal: (path) => {
        revealed.push(path);
      },
      ...extra,
    }),
    w = (await f.create()).worktrees[0]!,
    i = f.service.inspect(f.project.id, w.id),
    page = await f.service.command({
      kind: 'remove',
      projectId: f.project.id,
      workspaceId: w.id,
      expectedVersion: 1,
      inspectionId: i.inspectionId,
      commandKey: 'remove-gap',
    }),
    op = page.operations[0]!,
    dispatch = f.store.worktreeDispatch(f.project.id, op.operationId);
  assert.equal(op.state, 'outcome_unknown');
  assert.equal(existsSync(w.directory), false);
  assert.equal(
    readFileSync(join(dispatch.payload.recoveryDirectory!, 'file.txt'), 'utf8'),
    'base\n',
  );
  assert.ok(f.g('worktree', 'list', '--porcelain').includes(w.directory));
  return { ...f, w, op, dispatch, revealed };
}
test('explicit fresh repair removes only stale Git registration, resolves parent and preserves archive and branch', async (t) => {
  const f = await archiveGap(t),
    r = f.service.page(f.project.id).recoveries[0]!;
  assert.equal(r.state, 'pending_metadata');
  assert.equal(r.repairOperationId, f.op.operationId);
  await assert.rejects(
    () =>
      f.service.command({
        kind: 'reconcile',
        projectId: f.project.id,
        operationId: f.op.operationId,
      }),
    /WORKTREE_RECONCILIATION_AMBIGUOUS/,
  );
  assert.throws(() => f.store.beginRun(f.project.id, 'wait', 'wait', 'readOnly'), /WORKSPACE_BUSY/);
  const input = {
      kind: 'repairRemove' as const,
      projectId: f.project.id,
      operationId: f.op.operationId,
      commandKey: 'repair',
    },
    page = await f.service.command(input);
  assert.equal(page.operations[0]!.kind, 'repairRemove');
  assert.equal(page.operations[0]!.state, 'completed');
  assert.equal(f.store.worktreeDispatch(f.project.id, f.op.operationId).state, 'completed');
  assert.equal(page.worktrees.length, 0);
  assert.equal(page.recoveries[0]!.state, 'retained');
  assert.equal(f.g('worktree', 'list', '--porcelain').includes(f.w.directory), false);
  assert.equal(f.g('rev-parse', f.w.branch), f.w.baseCommit);
  assert.equal(
    readFileSync(join(f.dispatch.payload.recoveryDirectory!, 'file.txt'), 'utf8'),
    'base\n',
  );
  assert.equal((await f.service.command(input)).operations.length, page.operations.length);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM execution_intents').get()!.n, 0);
  await f.service.command({
    kind: 'revealRecovery',
    projectId: f.project.id,
    recoveryId: f.op.operationId,
  });
  assert.deepEqual(f.revealed, [f.dispatch.payload.recoveryDirectory]);
  assert.throws(
    () => f.store.finishWorktree(f.project.id, f.op.operationId, 'completed'),
    /STALE_WORKTREE_OPERATION/,
  );
});
test('recovery lookup can reveal owned data after the source repository disappears, without execution authority', async (t) => {
  const f = await archiveGap(t);
  renameSync(f.cwd, join(f.root, 'source-moved'));
  const page = f.service.page(f.project.id),
    r = page.recoveries[0]!;
  assert.equal(r.state, 'unavailable');
  assert.ok(r.reasons.includes('SOURCE_CHANGED'));
  assert.equal(r.canReveal, true);
  await f.service.command({
    kind: 'revealRecovery',
    projectId: f.project.id,
    recoveryId: r.recoveryId,
  });
  assert.deepEqual(f.revealed, [f.dispatch.payload.recoveryDirectory]);
  assert.throws(
    () => f.store.beginRun(f.project.id, 'no replaced authority', 'no', 'readOnly'),
    /PROJECT_UNAVAILABLE/,
  );
});
test('a reappearing broken symlink or replaced recovery directory blocks repair without touching either location', async (t) => {
  const f = await archiveGap(t),
    before = f.store.worktreeOperations(f.project.id).length;
  symlinkSync(join(f.root, 'not-present'), f.w.directory);
  assert.equal(f.service.page(f.project.id).recoveries[0]!.repairOperationId, null);
  await assert.rejects(
    () =>
      f.service.command({
        kind: 'repairRemove',
        projectId: f.project.id,
        operationId: f.op.operationId,
        commandKey: 'reappeared',
      }),
    /WORKTREE_ORIGINAL_PATH_PRESENT/,
  );
  assert.equal(f.store.worktreeOperations(f.project.id).length, before);
  rmSync(f.w.directory);
  const original = f.dispatch.payload.recoveryDirectory!;
  renameSync(original, original + '-preserved');
  mkdirSync(original);
  await assert.rejects(
    () =>
      f.service.command({
        kind: 'revealRecovery',
        projectId: f.project.id,
        recoveryId: f.op.operationId,
      }),
    /WORKTREE_RECOVERY_MISSING/,
  );
  await assert.rejects(
    () =>
      f.service.command({
        kind: 'repairRemove',
        projectId: f.project.id,
        operationId: f.op.operationId,
        commandKey: 'replaced',
      }),
    /WORKTREE_RECOVERY_MISSING/,
  );
  assert.deepEqual(f.revealed, []);
  assert.equal(readFileSync(join(original + '-preserved', 'file.txt'), 'utf8'), 'base\n');
});
test('Git locked metadata and foreign recovery IDs are refused before new repair intent', async (t) => {
  const f = await archiveGap(t),
    before = f.store.worktreeOperations(f.project.id).length;
  f.g('worktree', 'lock', '--reason', 'owned fixture', f.w.directory);
  assert.ok(f.service.page(f.project.id).recoveries[0]!.reasons.includes('GIT_WORKTREE_LOCKED'));
  await assert.rejects(
    () =>
      f.service.command({
        kind: 'repairRemove',
        projectId: f.project.id,
        operationId: f.op.operationId,
        commandKey: 'locked',
      }),
    /WORKTREE_LOCKED/,
  );
  assert.equal(f.store.worktreeOperations(f.project.id).length, before);
  mkdirSync(join(f.root, 'foreign'));
  const other = f.store.registerWorkspace(join(f.root, 'foreign'), join(f.root, 'foreign'));
  await assert.rejects(
    () =>
      f.service.command({
        kind: 'revealRecovery',
        projectId: other.id,
        recoveryId: f.op.operationId,
      }),
    /WORKTREE_RECOVERY_NOT_FOUND/,
  );
  await assert.rejects(
    () =>
      f.service.command({
        kind: 'revealRecovery',
        projectId: f.project.id,
        recoveryId: f.op.operationId,
        path: '/etc',
      } as never),
    /INVALID_WORKTREE_COMMAND/,
  );
  assert.deepEqual(f.revealed, []);
  f.g('worktree', 'unlock', f.w.directory);
  await f.service.command({
    kind: 'repairRemove',
    projectId: f.project.id,
    operationId: f.op.operationId,
    commandKey: 'unlocked',
  });
  assert.equal(f.service.page(f.project.id).recoveries[0]!.state, 'retained');
});
test('failed repair before dispatch retains unresolved project lock and a later explicit child can converge the chain', async (t) => {
  const f = await archiveGap(t),
    workerCopy = join(f.root, 'owned-worker.mjs');
  writeFileSync(workerCopy, readFileSync(worker));
  const service = new WorktreeService(f.store, {
    git,
    node,
    worker: workerCopy,
    stateDirectory: join(f.root, 'state'),
  });
  writeFileSync(workerCopy, readFileSync(workerCopy, 'utf8') + '\n// controlled change\n');
  const page = await service.command({
      kind: 'repairRemove',
      projectId: f.project.id,
      operationId: f.op.operationId,
      commandKey: 'failed-before-dispatch',
    }),
    child = page.operations[0]!;
  assert.equal(child.state, 'outcome_unknown');
  assert.equal(f.store.currentWorktreeOperation(f.project.id)!.operationId, child.operationId);
  assert.throws(
    () => f.store.beginRun(f.project.id, 'unresolved', 'unresolved', 'readOnly'),
    /WORKSPACE_BUSY/,
  );
  const replacement = new WorktreeService(f.store, {
    git,
    node,
    worker,
    stateDirectory: join(f.root, 'state'),
  });
  await replacement.command({
    kind: 'repairRemove',
    projectId: f.project.id,
    operationId: child.operationId,
    commandKey: 'explicit-repair-again',
  });
  assert.equal(f.store.worktreeDispatch(f.project.id, child.operationId).state, 'completed');
  assert.equal(f.store.worktreeDispatch(f.project.id, f.op.operationId).state, 'completed');
  assert.equal(f.store.currentWorktreeOperation(f.project.id), null);
});
test('a path recreated after dispatch is preserved by the supervised final guard rather than removed', async (t) => {
  const f = await archiveGap(t),
    service = new WorktreeService(f.store, {
      git,
      node,
      worker,
      stateDirectory: join(f.root, 'state'),
      afterDispatch: () => {
        mkdirSync(f.w.directory);
        writeFileSync(join(f.w.directory, 'user-kept.txt'), 'PRESERVED\n');
      },
    }),
    page = await service.command({
      kind: 'repairRemove',
      projectId: f.project.id,
      operationId: f.op.operationId,
      commandKey: 'race',
    });
  assert.equal(page.operations[0]!.state, 'outcome_unknown');
  assert.equal(readFileSync(join(f.w.directory, 'user-kept.txt'), 'utf8'), 'PRESERVED\n');
  assert.equal(
    readFileSync(join(f.dispatch.payload.recoveryDirectory!, 'file.txt'), 'utf8'),
    'base\n',
  );
  assert.ok(f.g('worktree', 'list', '--porcelain').includes(f.w.directory));
  assert.notEqual(f.store.currentWorktreeOperation(f.project.id), null);
});
for (const stage of ['archived', 'repair-prepared', 'repair-result'])
  test(`actual SIGKILL at ${stage} keeps the unresolved project lock until explicit metadata repair or reconciliation`, async (t) => {
    const f = fixture(t),
      child = spawn(
        node,
        [
          resolve('tests/fixtures/worktree-recovery-worker.ts'),
          f.file,
          f.cwd,
          join(f.root, 'state'),
          git,
          stage,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    let output = '';
    const ready = new Promise<{ operationId: string; workspaceId: string }>((done, reject) => {
      child.stdout.on('data', (data) => {
        output += data;
        if (output.includes('\n')) done(JSON.parse(output.trim()));
      });
      child.once('exit', () => reject(Error('EARLY_RECOVERY_WORKER_EXIT')));
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    try {
      const receipt = await ready,
        row = f.db
          .prepare('SELECT * FROM worktree_operations WHERE operation_id=?')
          .get(receipt.operationId)!,
        p = JSON.parse(String(row.payload_json));
      assert.equal(row.state, stage === 'repair-prepared' ? 'prepared' : 'dispatching');
      assert.equal(existsSync(p.targetDirectory), false);
      assert.equal(readFileSync(join(p.recoveryDirectory, 'file.txt'), 'utf8'), 'base\n');
      assert.equal(
        f.g('worktree', 'list', '--porcelain').includes(p.targetDirectory),
        stage !== 'repair-result',
      );
      const before = Number(f.db.prepare('SELECT COUNT(*) AS n FROM worktree_operations').get()!.n);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      const [, signal] = await exited;
      assert.equal(signal, 'SIGKILL');
      if (row.supervisor_pid) {
        const deadline = Date.now() + 4000;
        while (true) {
          try {
            process.kill(-Number(row.supervisor_pid), 0);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH') break;
            throw e;
          }
          if (Date.now() > deadline) throw Error('RECOVERY_GROUP_STILL_ALIVE');
          await new Promise((done) => setTimeout(done, 20));
        }
      }
      const next = new ExecutionLedger(f.file, schema);
      try {
        next.startOwner('after-real-recovery-kill-' + stage, true);
        assert.equal(
          next.worktreeDispatch(f.project.id, receipt.operationId).state,
          'outcome_unknown',
        );
        assert.equal(next.currentWorktreeOperation(f.project.id)!.operationId, receipt.operationId);
        assert.equal(
          Number(f.db.prepare('SELECT COUNT(*) AS n FROM worktree_operations').get()!.n),
          before,
        );
        assert.throws(
          () => next.beginRun(f.project.id, 'unresolved', 'blocked', 'readOnly'),
          /WORKSPACE_BUSY/,
        );
        const service = new WorktreeService(next, {
          git,
          node,
          worker,
          stateDirectory: join(f.root, 'state'),
        });
        if (stage === 'repair-result')
          await service.command({
            kind: 'reconcile',
            projectId: f.project.id,
            operationId: receipt.operationId,
          });
        else
          await service.command({
            kind: 'repairRemove',
            projectId: f.project.id,
            operationId: receipt.operationId,
            commandKey: 'explicit-after-kill',
          });
        assert.equal(next.currentWorktreeOperation(f.project.id), null);
        assert.equal(next.worktreeDispatch(f.project.id, receipt.operationId).state, 'completed');
        assert.equal(f.g('worktree', 'list', '--porcelain').includes(p.targetDirectory), false);
        assert.equal(f.g('rev-parse', p.branch), p.baseCommit);
        assert.equal(readFileSync(join(p.recoveryDirectory, 'file.txt'), 'utf8'), 'base\n');
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n, 0);
        assert.equal(
          f.db
            .prepare("SELECT COUNT(*) AS n FROM worktree_operations WHERE state='outcome_unknown'")
            .get()!.n,
          0,
        );
        assert.equal(
          Number(f.db.prepare('SELECT COUNT(*) AS n FROM worktree_operations').get()!.n),
          before + (stage === 'repair-result' ? 0 : 1),
        );
        t.diagnostic(
          'WORKTREE_RECOVERY_SIGKILL_RECEIPT ' +
            JSON.stringify({
              stage,
              signal,
              operationId: receipt.operationId,
              keptLockAfterRecovery: true,
              automaticResends: 0,
              explicitNewMetadataIntent: stage !== 'repair-result',
              archivePreserved: true,
              modelRuns: 0,
            }),
        );
      } finally {
        next.close();
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
test('a forced epoch change after archive fences the old continuation before Git metadata starts', async (t) => {
  let replacement: ExecutionLedger | undefined;
  const f = fixture(t, {
      afterArchived: () => {
        replacement = new ExecutionLedger(f.file, schema);
        replacement.startOwner('forced-epoch-component-fixture', true);
      },
    }),
    w = (await f.create()).worktrees[0]!,
    i = f.service.inspect(f.project.id, w.id);
  try {
    await assert.rejects(
      () =>
        f.service.command({
          kind: 'remove',
          projectId: f.project.id,
          commandKey: 'epoch-remove',
          workspaceId: w.id,
          expectedVersion: 1,
          inspectionId: i.inspectionId,
        }),
      /STALE_RUNTIME_OWNER/,
    );
    assert.ok(replacement);
    const current = replacement.currentWorktreeOperation(f.project.id)!;
    assert.equal(current.state, 'outcome_unknown');
    assert.equal(existsSync(w.directory), false);
    assert.ok(f.g('worktree', 'list', '--porcelain').includes(w.directory));
    assert.equal(
      readFileSync(join(current.payload.recoveryDirectory!, 'file.txt'), 'utf8'),
      'base\n',
    );
    assert.throws(
      () => replacement!.beginRun(f.project.id, 'blocked', 'blocked', 'readOnly'),
      /WORKSPACE_BUSY/,
    );
    const service = new WorktreeService(replacement, {
      git,
      node,
      worker,
      stateDirectory: join(f.root, 'state'),
    });
    await service.command({
      kind: 'repairRemove',
      projectId: f.project.id,
      operationId: current.operationId,
      commandKey: 'new-owner-explicit-repair',
    });
    assert.equal(replacement.currentWorktreeOperation(f.project.id), null);
  } finally {
    replacement?.close();
  }
});
