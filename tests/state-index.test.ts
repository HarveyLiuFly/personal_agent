import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StateIndexWarmup, readStateIndex } from '../packages/codex-adapter/src/state-index.ts';
import { AppServerRuntime } from '../packages/codex-adapter/src/app-server.ts';
import type { WarmupState } from '../packages/codex-adapter/src/state-index.ts';

/**
 * A stand-in app-server: finds `sqlite_home` in its arguments and fills a Codex-like backfill
 * table. `mode.json` beside the state directory chooses the behaviour; `starts` counts launches.
 */
const fakeServer = `
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const arg = process.argv.find((a) => a.startsWith('sqlite_home='));
const home = JSON.parse(arg.slice('sqlite_home='.length));
const state = dirname(home);
const mode = JSON.parse(readFileSync(join(state, 'mode.json'), 'utf8'));
appendFileSync(join(state, 'starts'), 'x');
const starts = readFileSync(join(state, 'starts'), 'utf8').length;
mkdirSync(home, { recursive: true });
const db = new DatabaseSync(join(home, 'state_5.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS backfill_state (id INTEGER PRIMARY KEY, status TEXT); CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY);');
db.exec("INSERT OR IGNORE INTO backfill_state VALUES (1, 'running')");
if (mode.staleStarts && starts <= mode.staleStarts) process.exit(1);
let n = 0;
const timer = setInterval(() => {
  db.exec('INSERT INTO threads DEFAULT VALUES');
  if (++n >= mode.threads) {
    db.exec("UPDATE backfill_state SET status='complete'");
    clearInterval(timer);
  }
}, 20);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

function fixture(t: { after(fn: () => void): void }, mode: Record<string, number>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-state-index-'))),
    state = join(root, 'codex-state'),
    script = join(root, 'fake-app-server.mjs'),
    executable = join(root, 'fake-codex');
  mkdirSync(state);
  writeFileSync(script, fakeServer);
  writeFileSync(join(state, 'mode.json'), JSON.stringify(mode));
  writeFileSync(
    executable,
    `#!/bin/sh\nexec '${process.execPath}' --disable-warning=ExperimentalWarning '${script}' "$@"\n`,
  );
  chmodSync(executable, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const starts = () =>
    existsSync(join(state, 'starts')) ? readFileSync(join(state, 'starts'), 'utf8').length : 0;
  return { state, executable, starts };
}

test('a fresh state directory is indexed by one long-lived process', async (t) => {
  if (process.platform === 'win32') return;
  const f = fixture(t, { threads: 12 });
  assert.equal(readStateIndex(f.state).status, 'missing');
  const seen: Array<[WarmupState, number]> = [];
  const warmup = new StateIndexWarmup({
    executable: f.executable,
    stateDirectory: f.state,
    env: process.env,
    pollMs: 30,
    onChange: (state, index) => seen.push([state, index.threads]),
  });
  assert.equal(await warmup.start(), 'complete');
  assert.equal(f.starts(), 1);
  assert.deepEqual(readStateIndex(f.state), { status: 'complete', threads: 12 });
  assert.equal(seen[0]![0], 'indexing');
  assert.deepEqual(seen.at(-1), ['complete', 12]);
  assert.equal(warmup.active, false);
  // Already complete: no process is started again.
  assert.equal(
    await new StateIndexWarmup({ executable: f.executable, stateDirectory: f.state }).start(),
    'complete',
  );
  assert.equal(f.starts(), 1);
});

test('a process that exits behind a stale lease is retried until the index completes', async (t) => {
  if (process.platform === 'win32') return;
  const f = fixture(t, { threads: 5, staleStarts: 2 });
  const states: WarmupState[] = [];
  const warmup = new StateIndexWarmup({
    executable: f.executable,
    stateDirectory: f.state,
    env: process.env,
    pollMs: 30,
    retryMs: 40,
    onChange: (state) => states.push(state),
  });
  assert.equal(await warmup.start(), 'complete');
  assert.equal(f.starts(), 3);
  assert.ok(states.includes('waiting'));
});

test('stop ends the warm-up process', async (t) => {
  if (process.platform === 'win32') return;
  const f = fixture(t, { threads: 100_000 });
  const warmup = new StateIndexWarmup({
    executable: f.executable,
    stateDirectory: f.state,
    env: process.env,
    pollMs: 30,
  });
  const done = warmup.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(warmup.active, true);
  warmup.stop();
  assert.equal(await done, 'idle');
  assert.equal(warmup.active, false);
});

test('reads fail fast without starting a process while the Host warms the index', async () => {
  let started = 0;
  const runtime = new AppServerRuntime(
    () => {
      started++;
      return { executable: '/nonexistent/codex', args: [], env: {} };
    },
    { blocked: () => 'CODEX_STATE_INDEX_PENDING' },
  );
  await assert.rejects(() => runtime.read(async () => 'unused'), /CODEX_STATE_INDEX_PENDING/);
  assert.equal(runtime.snapshot().starts, 0);
  assert.ok(started <= 1, 'only the option factory ran');
  await runtime.close();
});
