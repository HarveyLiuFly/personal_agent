// CORE.3 closing acceptance on this machine: a real code task with REAL MODEL TURNS (about five
// turns of quota) in a small Python project, in a real sandboxed window with the pinned Codex.
// Checks: auto mode edits files; a command leaving the sandbox asks for approval (allowed -> it
// ran, declined -> no side effect); extra words reach a running turn; Stop ends the Codex process;
// the project check (python3 -m unittest) fails before and passes after; the diff only touches
// calc.py. Per-run output stays in .local/; the summary goes to the evidence directory.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import electron from 'electron';
import { openDisplay } from './virtual-display.mjs';
import { evidenceDir } from './lib/evidence.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = resolve(root, '.local/core3-acceptance'),
  data = join(base, 'data'),
  project = join(base, 'project'),
  stateFile = join(base, 'state.json');
for (const path of [data, project, stateFile]) rmSync(path, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'calc.py'), 'def add(a, b):\n    return a - b\n');
writeFileSync(
  join(project, 'test_calc.py'),
  'import unittest\n\nfrom calc import add\n\n\nclass AddTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
);
const git = (...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=acceptance', '-c', 'user.email=acceptance@invalid', ...args],
    {
      cwd: project,
      encoding: 'utf8',
    },
  );
git('init', '-q');
git('add', '.');
git('commit', '-q', '-m', 'fixture');
const id = randomUUID().slice(0, 8);
const allowFile = `/tmp/pa-core3-allow-${id}`,
  denyFile = `/tmp/pa-core3-deny-${id}`;
writeFileSync(stateFile, JSON.stringify({ allowFile, denyFile }, null, 2) + '\n');

// Baseline: the project check fails before the fix (same runner as the app).
const { runProjectCheck } = await import('../packages/verification/src/project-checks.ts');
const { verifiedCodex } = await import('../packages/codex-adapter/src/binary.ts');
const cli = verifiedCodex(root).executable;
const baseline = await runProjectCheck({
  cli,
  cwd: project,
  argv: ['python3', '-m', 'unittest', '-v'],
  stateDirectory: join(base, 'checks'),
});
const indexed = resolve(root, '.local/desktop-concurrency-smoke-data/codex-state');
if (existsSync(indexed)) cpSync(indexed, join(data, 'codex-state'), { recursive: true });

const display = await openDisplay(root);
let exit;
try {
  const child = spawn(
    electron,
    ['.', `--core3-project=${project}`, `--core3-state=${stateFile}`, `--user-data-dir=${data}`],
    { cwd: root, stdio: 'inherit', env: display.env },
  );
  exit = await new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done('timeout');
    }, 2_400_000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      done(signal ?? code);
    });
  });
} finally {
  await display.close();
}
const s = JSON.parse(readFileSync(stateFile, 'utf8'));
const r = s.result ?? {};
const changed = git('diff', '--name-only').trim().split('\n').filter(Boolean);
const db = new DatabaseSync(join(data, 'execution/ledger.db'), { readOnly: true });
const usage = db
  .prepare(
    'SELECT r.status,(u.latest_total_tokens-coalesce(u.baseline_tokens,0)) AS tokens FROM task_runs r LEFT JOIN run_usage u USING(run_id) WHERE r.task_id=? ORDER BY r.started_at_ms',
  )
  .all(r.conversationId ?? '');
db.close();
const approvalCount = (turn) => (turn?.approvals ?? []).length;
const checks = {
  baselineCheckFails: baseline.status === 'failed',
  autoModeFixesFile: r.fix?.status === 'completed' && changed.includes('calc.py'),
  testsUntouched: !changed.includes('test_calc.py'),
  checkPassesAfterFix: r.autoCheck === 'passed',
  approvalAskedAndAllowedRan: approvalCount(r.allowed) > 0 && s.allowFileExists === true,
  approvalDeclinedNoSideEffect: approvalCount(r.declined) > 0 && s.denyFileExists === false,
  steerAccepted: (s.steerIntents ?? []).includes('accepted') && r.composerSaidAdd === true,
  stopEndsProcess:
    r.stopShown === true && r.stopped?.status === 'cancelled' && s.stoppedExecutorExited === true,
  diffMatchesCheck: changed.length === 1 && changed[0] === 'calc.py' && r.lastCheck === 'passed',
  sandboxed: r.sandboxed === true && r.isolated === true,
};
const evidence = {
  checkpoint: 'CORE.3',
  observedAt: new Date().toISOString(),
  status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
  kind: 'real Electron window, real pinned Codex, real model turns, real codex sandbox check command',
  platform: `${process.platform}-${process.arch}`,
  checks,
  baseline: { status: baseline.status, exitCode: baseline.exitCode },
  turns: {
    fix: r.fix,
    allowed: r.allowed,
    declined: r.declined,
    steered: { status: r.steered?.status, steerShown: r.steerShown, answerTail: r.steeredAnswer },
    stopped: r.stopped,
  },
  steerIntents: s.steerIntents,
  steerError: r.steerError || null,
  allowFileExists: s.allowFileExists,
  denyFileExists: s.denyFileExists,
  stoppedExecutorExited: s.stoppedExecutorExited,
  changedFiles: changed,
  calcPy: s.calcPy,
  error: s.error ?? null,
  exit,
  turnTokens: usage.map((row) => ({ status: row.status, tokens: row.tokens })),
  totalTokens: usage.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0),
};
for (const file of [allowFile, denyFile]) rmSync(file, { force: true });
writeFileSync(
  join(evidenceDir(root), 'CORE.3-acceptance-desktop.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = evidence.status === 'passed' ? 0 : 1;
