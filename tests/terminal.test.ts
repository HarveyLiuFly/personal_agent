import { terminalAvailable } from '../packages/workspace/src/terminal-binding.ts';
import { legacySchema } from './fixtures/schema-history.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { TerminalService } from '../packages/workspace/src/terminal.ts';
import { resolveVerifierNode } from '../packages/codex-adapter/src/launch.ts';
const schema = readFileSync('docs/design/contracts/schema.sql', 'utf8'),
  node = resolveVerifierNode(resolve('.')),
  worker = resolve('packages/workspace/src/terminal-worker.mjs');
function fixture(
  t: { after(fn: () => Promise<void>): void },
  options: Partial<ConstructorParameters<typeof TerminalService>[1]> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-terminal-'))),
    cwd = join(root, 'workspace');
  mkdirSync(cwd);
  const file = join(root, 'ledger.db'),
    store = new ExecutionLedger(file, schema);
  store.startOwner('terminal-fixture', true);
  const project = store.registerWorkspace(cwd, cwd),
    db = new DatabaseSync(file),
    service = new TerminalService(store, {
      node,
      worker,
      stateDirectory: join(root, 'state'),
      ...options,
    });
  t.after(async () => {
    await service.stop();
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const open = (key = 'open') =>
      service.open({ projectId: project.id, commandKey: key, cols: 80, rows: 24 }),
    view = (afterSequence = 0) => service.view({ projectId: project.id, afterSequence }),
    text = () =>
      view()
        .chunks.map((c) => Buffer.from(c.data, 'base64').toString('utf8'))
        .join('');
  return { root, cwd, file, store, db, project, service, open, view, text };
}
async function wait(check: () => boolean, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw Error('TERMINAL_WAIT_TIMEOUT');
    await new Promise((done) => setTimeout(done, 20));
  }
}
const supported = terminalAvailable();
test(
  'real user PTY has tty stdin/stdout, pinned cwd, resize, input dedupe and actual process shutdown',
  { skip: !supported },
  async (t) => {
    const f = fixture(t),
      opened = await f.open(),
      session = opened.session!;
    assert.equal(session.state, 'running');
    const host = f.store.terminalHost(f.project.id, session.sessionId);
    assert.ok(host.ptyPid);
    assert.ok(host.supervisorPid);
    assert.throws(
      () => f.store.beginRun(f.project.id, 'must wait', 'busy', 'readOnly'),
      /WORKSPACE_TERMINAL_ACTIVE/,
    );
    assert.equal((await f.open()).session!.sessionId, session.sessionId);
    const q = {
      projectId: f.project.id,
      sessionId: session.sessionId,
      sequence: 1,
      text: "test -t 0 && test -t 1 && printf '\\nTTY_OK\\n'; printf '%s\\n' \"$PWD\"; printf ONCE >> count.txt\r",
    };
    assert.equal((await f.service.write(q)).state, 'accepted');
    await wait(() => f.text().includes('\r\nTTY_OK\r\n'));
    assert.ok(f.text().includes(f.cwd));
    await f.service.write(q);
    await assert.rejects(
      () => f.service.write({ ...q, text: 'different' }),
      /TERMINAL_INPUT_CONFLICT/,
    );
    f.service.resize({
      projectId: f.project.id,
      sessionId: session.sessionId,
      cols: 100,
      rows: 30,
    });
    await f.service.write({
      projectId: f.project.id,
      sessionId: session.sessionId,
      sequence: 2,
      text: 'stty size\r',
    });
    await wait(() => f.text().includes('30 100'));
    assert.equal(readFileSync(join(f.cwd, 'count.txt'), 'utf8'), 'ONCE');
    const closed = await f.service.close({
      projectId: f.project.id,
      sessionId: session.sessionId,
      commandKey: 'close',
    });
    assert.equal(closed.session!.state, 'exited');
    for (const pid of [host.ptyPid!, host.supervisorPid!])
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workspace_terminal_leases').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM execution_intents').get()!.n, 0);
    assert.equal((await f.service.write(q)).state, 'accepted');
    assert.ok(f.store.beginRun(f.project.id, 'after close', 'released', 'readOnly'));
  },
);
test(
  'terminal text stays out of SQLite, output is bounded and stale cursors reset',
  { skip: !supported },
  async (t) => {
    const f = fixture(t),
      session = (await f.open()).session!,
      marker = 'PRIVATE_FIXTURE_ONLY_TERMINAL_TEXT';
    await f.service.write({
      projectId: f.project.id,
      sessionId: session.sessionId,
      sequence: 1,
      text: `printf '${marker}\\n'; head -c 1600000 /dev/zero | tr '\\0' x; printf '\\nOUTPUT_END\\n'\r`,
    });
    let cursor = 0,
      output = '',
      reset = false;
    await wait(() => {
      const part = f.view(cursor);
      reset ||= part.reset;
      cursor = part.nextSequence;
      output = (
        output + part.chunks.map((c) => Buffer.from(c.data, 'base64').toString('utf8')).join('')
      ).slice(-200000);
      return output.includes('\r\nOUTPUT_END\r\n');
    }, 12000);
    const v = f.view();
    assert.ok(v.chunks.reduce((n, c) => n + Buffer.byteLength(c.data, 'base64'), 0) <= 131072);
    assert.equal(v.reset, true);
    const allRows = JSON.stringify(
      ['messages', 'operations', 'terminal_inputs'].flatMap((table) =>
        f.db.prepare(`SELECT * FROM ${table}`).all(),
      ),
    );
    assert.equal(allRows.includes(marker), false);
    assert.equal(Number(f.db.prepare('SELECT bytes FROM terminal_inputs').get()!.bytes) > 0, true);
  },
);
test(
  'raw command, environment, foreign workspace and invalid dimensions are refused',
  { skip: !supported },
  async (t) => {
    const f = fixture(t);
    await assert.rejects(
      () =>
        f.service.open({
          projectId: f.project.id,
          commandKey: 'bad',
          cols: 80,
          rows: 24,
          shell: '/bin/sh',
        }),
      /INVALID_TERMINAL_QUERY/,
    );
    await assert.rejects(
      () => f.service.open({ projectId: f.project.id, commandKey: 'size', cols: 1, rows: 24 }),
      /INVALID_TERMINAL_SIZE/,
    );
    const s = (await f.open()).session!;
    mkdirSync(join(f.root, 'other'));
    const other = f.store.registerWorkspace(join(f.root, 'other'), join(f.root, 'other'));
    await assert.rejects(
      () =>
        f.service.write({ projectId: other.id, sessionId: s.sessionId, sequence: 1, text: 'no' }),
      /TERMINAL_SCOPE_MISMATCH/,
    );
    assert.throws(
      () => f.service.view({ projectId: f.project.id, afterSequence: -1 }),
      /INVALID_TERMINAL_CURSOR/,
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM terminal_inputs').get()!.n, 0);
  },
);
test(
  'lost input acknowledgement does not resend, and process termination preserves an unknown input receipt',
  { skip: !supported },
  async (t) => {
    const f = fixture(t, {
        beforeInputAck: () => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
          throw Error('controlled ack gap');
        },
      }),
      s = (await f.open()).session!,
      q = {
        projectId: f.project.id,
        sessionId: s.sessionId,
        sequence: 1,
        text: 'printf ONE >> once.txt\r',
      };
    await assert.rejects(() => f.service.write(q), /TERMINAL_INPUT_UNKNOWN/);
    await wait(() => f.view().session!.state === 'exited');
    assert.equal(readFileSync(join(f.cwd, 'once.txt'), 'utf8'), 'ONE');
    assert.equal((await f.service.write(q)).state, 'outcome_unknown');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM terminal_inputs').get()!.n, 1);
  },
);
test(
  'terminal admission is blocked by existing model execution; unsent recovery never spawns a shell',
  { skip: !supported },
  async (t) => {
    const f = fixture(t),
      run = f.store.beginRun(f.project.id, 'controlled admission', 'run', 'readOnly');
    await assert.rejects(() => f.open(), /WORKSPACE_BUSY/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM terminal_sessions').get()!.n, 0);
    f.store.finish(run.token, 'failed');
    const opened = f.store.terminalOpen({
      projectId: f.project.id,
      commandKey: 'prepared',
      cols: 80,
      rows: 24,
    });
    assert.equal(opened.session.state, 'prepared');
    const next = new ExecutionLedger(f.file, schema);
    try {
      next.startOwner('recover-unsent-terminal', true);
      assert.equal(next.terminalLatest(f.project.id)!.state, 'exited');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workspace_terminal_leases').get()!.n, 0);
      assert.equal(next.terminalHost(f.project.id, opened.session.sessionId).ptyPid, null);
    } finally {
      next.close();
    }
  },
);
test(
  'revision 5 migration preserves actual WAL data and worktree tables, failed DDL rolls back terminal tables',
  { skip: !supported },
  (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-terminal-migration-')));
    t.after(async () => {
      rmSync(root, { recursive: true, force: true });
    });
    for (const broken of [false, true]) {
      const file = join(root, broken ? 'failed.db' : 'valid.db'),
        db = new DatabaseSync(file);
      db.exec(legacySchema(schema, 5));
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO profiles VALUES ('fixture','ACTUAL_WAL_REV5',1)",
      );
      try {
        if (broken) {
          assert.throws(
            () =>
              new ExecutionLedger(
                file,
                schema.replace(
                  'input_hash TEXT NOT NULL,\n  bytes INTEGER NOT NULL,',
                  'input_hash TEXT NOT NULL CHECK (missing_column = 1),\n  bytes INTEGER NOT NULL,',
                ),
              ),
          );
          assert.equal(db.prepare('SELECT schema_revision AS n FROM schema_metadata').get()!.n, 5);
          assert.equal(
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('terminal_sessions','workspace_terminal_leases','terminal_inputs')",
              )
              .get()!.n,
            0,
          );
        } else {
          const store = new ExecutionLedger(file, schema);
          store.close();
          assert.equal(db.prepare('SELECT schema_revision AS n FROM schema_metadata').get()!.n, 6);
          assert.equal(
            db
              .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='managed_worktrees'")
              .get()!.n,
            1,
          );
        }
        const backup = join(
            root,
            readdirSync(root).find(
              (f) => f.startsWith(broken ? 'failed.db.' : 'valid.db.') && f.endsWith('.backup'),
            )!,
          ),
          saved = new DatabaseSync(backup, { readOnly: true });
        try {
          assert.equal(
            saved.prepare('SELECT display_name FROM profiles').get()!.display_name,
            'ACTUAL_WAL_REV5',
          );
          assert.equal(
            saved.prepare('SELECT schema_revision AS n FROM schema_metadata').get()!.n,
            5,
          );
          assert.equal(saved.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
          assert.equal(statSync(backup).mode & 0o777, 0o600);
        } finally {
          saved.close();
        }
      } finally {
        db.close();
      }
    }
  },
);
for (const stage of ['prepared', 'running'])
  test(
    `actual terminal Host SIGKILL at ${stage} never restarts a Shell or input`,
    { skip: !supported },
    async (t) => {
      const f = fixture(t),
        child = spawn(
          node,
          [
            resolve('tests/fixtures/terminal-crash-worker.ts'),
            f.file,
            f.cwd,
            join(f.root, 'state'),
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
        child.once('exit', () => reject(Error('EARLY_HOST_EXIT')));
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
      try {
        await ready;
        const row = f.db.prepare('SELECT * FROM terminal_sessions').get()!;
        assert.equal(row.state, stage === 'prepared' ? 'prepared' : 'running');
        const job = existsSync(join(f.cwd, 'child.pid'))
          ? Number(readFileSync(join(f.cwd, 'child.pid'), 'utf8').trim())
          : null;
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        const [, signal] = await exited;
        assert.equal(signal, 'SIGKILL');
        const gone = (pid: number) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (e) {
            return (e as NodeJS.ErrnoException).code === 'ESRCH';
          }
        };
        if (stage === 'running') {
          try {
            await wait(
              () =>
                gone(Number(row.supervisor_pid)) &&
                gone(Number(row.pty_pid)) &&
                (!job || gone(job)),
              6000,
            );
          } finally {
            if (job && !gone(job))
              try {
                process.kill(job, 'SIGKILL');
              } catch {}
          }
        }
        const next = new ExecutionLedger(f.file, schema);
        try {
          next.startOwner('terminal-owner-after-real-kill', true);
          assert.equal(
            next.terminalLatest(f.project.id)!.state,
            stage === 'prepared' ? 'exited' : 'outcome_unknown',
          );
          if (stage === 'running') {
            assert.throws(
              () => next.beginRun(f.project.id, 'blocked', 'blocked', 'readOnly'),
              /WORKSPACE_TERMINAL_ACTIVE/,
            );
            const service = new TerminalService(next, {
              node,
              worker,
              stateDirectory: join(f.root, 'state'),
            });
            assert.equal(
              service.reconcile({ projectId: f.project.id, sessionId: String(row.session_id) })
                .session!.state,
              'exited',
            );
          }
          assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM terminal_sessions').get()!.n, 1);
          assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_runs').get()!.n, 0);
        } finally {
          next.close();
        }
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
  );
test(
  'input fingerprints use an ephemeral key and sequence, and a new Owner cannot replay old terminal text',
  { skip: !supported },
  async (t) => {
    const f = fixture(t),
      s = (await f.open()).session!;
    for (const sequence of [1, 2])
      await f.service.write({
        projectId: f.project.id,
        sessionId: s.sessionId,
        sequence,
        text: 'x',
      });
    const hashes = f.db
      .prepare('SELECT input_hash FROM terminal_inputs ORDER BY sequence')
      .all()
      .map((r) => r.input_hash);
    assert.notEqual(hashes[0], hashes[1]);
    await f.service.close({
      projectId: f.project.id,
      sessionId: s.sessionId,
      commandKey: 'close-hmac',
    });
    const next = new ExecutionLedger(f.file, schema);
    try {
      next.startOwner('new-owner-no-input-key', true);
      assert.throws(
        () =>
          next.terminalInput({
            projectId: f.project.id,
            sessionId: s.sessionId,
            sequence: 1,
            text: 'x',
          }),
        /TERMINAL_INPUT_OWNER_CHANGED/,
      );
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM terminal_inputs').get()!.n, 2);
    } finally {
      next.close();
    }
  },
);
test(
  'Store input receipt window expires old sequences without resending; metadata fixture starts no processes',
  { skip: !supported },
  (t) => {
    const store = new ExecutionLedger(':memory:', schema);
    try {
      store.startOwner('input-window-metadata-fixture', true);
      const project = store.registerWorkspace(realpathSync(tmpdir()), realpathSync(tmpdir())),
        s = store.terminalOpen({
          projectId: project.id,
          commandKey: 'fixture',
          cols: 80,
          rows: 24,
        }).session;
      store.terminalDispatch(project.id, s.sessionId, 99999991);
      store.terminalStarted(project.id, s.sessionId, 99999992);
      for (let sequence = 1; sequence <= 1002; sequence++) {
        assert.equal(
          store.terminalInput({
            projectId: project.id,
            sessionId: s.sessionId,
            sequence,
            text: 'fixture',
          }).created,
          true,
        );
        store.terminalInputAccepted(project.id, s.sessionId, sequence);
      }
      assert.throws(
        () =>
          store.terminalInput({
            projectId: project.id,
            sessionId: s.sessionId,
            sequence: 1,
            text: 'fixture',
          }),
        /TERMINAL_INPUT_EXPIRED/,
      );
      assert.equal(
        store.terminalInput({
          projectId: project.id,
          sessionId: s.sessionId,
          sequence: 1002,
          text: 'fixture',
        }).created,
        false,
      );
      assert.equal(store.terminalLatest(project.id)!.lastInputSequence, 1002);
    } finally {
      store.close();
    }
  },
);
test(
  'replaying an old open key returns its original session without replacing or starting the newer live Shell',
  { skip: !supported },
  async (t) => {
    const f = fixture(t),
      old = (await f.open('old')).session!;
    await f.service.close({
      projectId: f.project.id,
      sessionId: old.sessionId,
      commandKey: 'close-old',
    });
    const current = (await f.open('new')).session!,
      replay = (await f.open('old')).session!;
    assert.equal(replay.sessionId, old.sessionId);
    assert.equal(replay.state, 'exited');
    assert.equal(f.view().session!.sessionId, current.sessionId);
    assert.equal(f.view().session!.state, 'running');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM terminal_sessions').get()!.n, 2);
    assert.deepEqual(
      Object.keys(replay).sort(),
      [
        'sessionId',
        'projectId',
        'state',
        'cols',
        'rows',
        'lastInputSequence',
        'lastInputState',
        'exitCode',
        'errorCode',
        'createdAt',
      ].sort(),
    );
  },
);
