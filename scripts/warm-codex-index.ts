// Prepares a private Codex state directory before smokes: the pinned app-server indexes the whole
// ~/.codex history into it on first start. Codex only waits 30 s for that index during initialize,
// and an interrupted first start leaves a "running" lease that blocks later starts for ~15 minutes.
// This keeps one app-server alive (initialize only, no model request) until the index is complete.
//
//   node scripts/warm-codex-index.ts [stateDirectory ...]   # default: the smoke state directories
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { launchArguments, runtimeEnvironment } from '../packages/codex-adapter/src/launch.ts';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';

const root = resolve(import.meta.dirname, '..');
const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((path) => resolve(path))
  : [join(root, '.local/codex-state'), join(root, '.local/desktop-smoke-data/codex-state')];
const limitMs = 25 * 60_000;
const { executable } = verifiedCodex(root);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function indexState(directory: string): { status: string; threads: number } | null {
  const file = join(directory, 'db/state_5.sqlite');
  if (!existsSync(file)) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare('SELECT status FROM backfill_state WHERE id = 1').get() as
        { status?: string } | undefined;
      const threads = (db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n;
      return { status: row?.status ?? 'pending', threads };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** One app-server start. Resolves when the index is complete or the server exits (e.g. waiting on a stale lease). */
async function attempt(directory: string): Promise<boolean> {
  const child = spawn(executable, launchArguments(directory), {
    env: runtimeEnvironment(),
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'personal_agent_desktop', title: 'Personal Agent', version: '0.1.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    }) + '\n',
  );
  let last = '';
  try {
    while (child.exitCode === null && child.signalCode === null) {
      const state = indexState(directory);
      const line = state ? `${state.status}, ${state.threads} threads` : 'starting';
      if (line !== last) {
        console.log(`  ${new Date().toISOString()} ${line}`);
        last = line;
      }
      if (state?.status === 'complete') return true;
      await sleep(5_000);
    }
    return indexState(directory)?.status === 'complete';
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill('SIGTERM');
    }
  }
}

let failed = 0;
for (const directory of targets) {
  console.log(`Codex index: ${directory}`);
  const start = Date.now();
  let done = indexState(directory)?.status === 'complete';
  while (!done && Date.now() - start < limitMs) {
    done = await attempt(directory);
    if (!done) {
      console.log(
        '  app-server exited before the index finished (probably a stale lease); retrying in 60 s',
      );
      await sleep(60_000);
    }
  }
  console.log(done ? '  complete' : '  NOT complete within 25 minutes');
  if (!done) failed++;
}
process.exitCode = failed ? 1 : 0;
