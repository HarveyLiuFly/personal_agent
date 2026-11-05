// CORE.2 closing acceptance on this machine (real window, real pinned Codex, REAL MODEL TURNS:
// about four turns of quota). Steps:
//   1. Records written by the previous version (checkpoint/CORE.2a, revision 7) into a fresh
//      data directory, for a small git project whose README holds a codename.
//   2. first   – the app migrates them and shows them; a new conversation answers from the README
//                and a follow-up must cite a number from the previous answer.
//   3. restart – a cold restart continues the same conversation; a long fourth turn starts and
//                this script kills the app (SIGKILL) while it streams.
//   4. recover – the next start must reconcile that turn by itself without sending it again.
// Per-run output stays in .local/; the summary goes to the evidence directory.
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import electron from 'electron';
import { openDisplay } from './virtual-display.mjs';
import { evidenceDir } from './lib/evidence.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = resolve(root, '.local/core2-acceptance'),
  data = join(base, 'data'),
  project = join(base, 'project'),
  old = join(base, 'old'),
  stateFile = join(base, 'state.json');
const state = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};

for (const path of [data, project, stateFile]) rmSync(path, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
writeFileSync(
  join(project, 'README.md'),
  '# Acceptance fixture\n\nThe codename of this project is BLUE-HERON-42.\n',
);
const git = (...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=acceptance', '-c', 'user.email=acceptance@invalid', ...args],
    {
      cwd: project,
    },
  );
git('init', '-q');
git('add', 'README.md');
git('commit', '-q', '-m', 'fixture');

if (!existsSync(old))
  execFileSync('git', ['worktree', 'add', '-q', '--detach', old, 'checkpoint/CORE.2a'], {
    cwd: root,
  });
if (!existsSync(join(old, 'node_modules')))
  symlinkSync(join(root, 'node_modules'), join(old, 'node_modules'));
const seed = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      join(root, 'scripts/lib/core2-seed-old.ts'),
      old,
      data,
      project,
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .at(-1),
);
// Reuse an already indexed private Codex state when there is one (else the app indexes first).
const indexed = resolve(root, '.local/desktop-concurrency-smoke-data/codex-state');
if (existsSync(indexed)) cpSync(indexed, join(data, 'codex-state'), { recursive: true });

const display = await openDisplay(root);
const launch = (phase) =>
  spawn(
    electron,
    ['.', `--core2-acceptance=${phase}`, `--core2-state=${stateFile}`, `--user-data-dir=${data}`],
    { cwd: root, stdio: 'inherit', env: display.env },
  );
const ended = (child, ms) =>
  new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done('timeout');
    }, ms);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      done(signal ?? code);
    });
  });
const outcome = { seed, phases: {} };
try {
  outcome.phases.first = await ended(launch('first'), 900_000);
  const restart = launch('restart');
  const exited = ended(restart, 900_000);
  const deadline = Date.now() + 900_000;
  while (!state().killReady && !state().restartError && Date.now() < deadline) await sleep(500);
  if (state().killReady) {
    const db = new DatabaseSync(join(data, 'execution/ledger.db'), { readOnly: true });
    const started = db
      .prepare(
        "SELECT json_extract(payload_json,'$.pid') AS pid FROM task_events WHERE run_id=? AND event_type='executor_started' ORDER BY sequence DESC LIMIT 1",
      )
      .get(state().killRunId);
    db.close();
    restart.kill('SIGKILL');
    outcome.phases.restart = await exited;
    const pid = Number(started?.pid);
    outcome.kill = {
      executorRecorded: Number.isSafeInteger(pid),
      executorAliveAfterKill: alive(pid),
    };
    const until = Date.now() + 120_000;
    while (alive(pid) && Date.now() < until) await sleep(1000);
    outcome.kill.executorAliveAfter2Min = alive(pid);
  } else outcome.phases.restart = await exited;
  outcome.phases.recover = await ended(launch('recover'), 900_000);
} finally {
  await display.close();
}
const db = new DatabaseSync(join(data, 'execution/ledger.db'), { readOnly: true });
const s = state();
const usage = db
  .prepare(
    'SELECT r.run_id,r.status,(u.latest_total_tokens-coalesce(u.baseline_tokens,0)) AS tokens FROM task_runs r LEFT JOIN run_usage u USING(run_id) WHERE r.task_id=? ORDER BY r.started_at_ms',
  )
  .all(s.conversationId ?? '');
const revision = db.prepare('SELECT schema_revision AS n FROM schema_metadata').get().n;
db.close();
const backups = readdirSync(join(data, 'execution')).filter((name) =>
  /\.revision7-.*\.backup$/.test(name),
).length;
const first = s.first ?? {},
  restart = s.restart ?? {},
  recover = s.recover ?? {};
const checks = {
  migratedToRevision8: revision === 8 && backups === 1,
  oldConversationReadable: first.oldTurnReadable === true,
  oldDotReadable: first.oldDotReadable === true,
  firstAnswerFromReadme: first.turn1Status === 'completed' && first.codenameInAnswer1 === true,
  followUpCitesPreviousAnswer:
    first.turn2Status === 'completed' && first.followUpCitesPreviousAnswer === true,
  coldRestartContinues:
    restart.restoredTurns === 2 &&
    restart.turn3Status === 'completed' &&
    restart.coldRestartContinues === true,
  killedTurnReconciledAutomatically:
    typeof recover.status === 'string' &&
    recover.status !== 'outcome_unknown' &&
    recover.blocked === false,
  killedTurnNotResent: recover.turnStartIntents === 1 && recover.turns === 4,
  sandboxed: first.sandboxed === true && first.isolated === true,
};
const evidence = {
  checkpoint: 'CORE.2',
  observedAt: new Date().toISOString(),
  status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
  kind: 'real Electron window, real pinned Codex, real model turns; previous-version data seeded without a model',
  platform: `${process.platform}-${process.arch}`,
  checks,
  first,
  restart,
  recover,
  kill: outcome.kill,
  phases: outcome.phases,
  errors: Object.fromEntries(Object.entries(s).filter(([key]) => key.endsWith('Error'))),
  turnTokens: usage.map((row) => ({ status: row.status, tokens: row.tokens })),
  totalTokens: usage.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0),
};
writeFileSync(
  join(evidenceDir(root), 'CORE.2-acceptance-desktop.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = evidence.status === 'passed' ? 0 : 1;
