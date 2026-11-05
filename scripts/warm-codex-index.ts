// Prepares private Codex state directories before smokes. The pinned app-server indexes the whole
// ~/.codex history into each state directory on first start; see StateIndexWarmup for why this
// needs one long-lived process. Initialize only, no model request.
//
//   node scripts/warm-codex-index.ts [stateDirectory ...]   # default: the smoke state directories
import { join, resolve } from 'node:path';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { StateIndexWarmup } from '../packages/codex-adapter/src/state-index.ts';

const root = resolve(import.meta.dirname, '..');
const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((path) => resolve(path))
  : [join(root, '.local/codex-state'), join(root, '.local/desktop-smoke-data/codex-state')];
const { executable } = verifiedCodex(root);

let failed = 0;
for (const stateDirectory of targets) {
  console.log(`Codex index: ${stateDirectory}`);
  const warmup = new StateIndexWarmup({
    executable,
    stateDirectory,
    pollMs: 5000,
    onChange: (state, index) =>
      console.log(
        `  ${new Date().toISOString()} ${state}: ${index.status}, ${index.threads} threads`,
      ),
  });
  const state = await warmup.start();
  console.log(state === 'complete' ? '  complete' : `  NOT complete (${state})`);
  if (state !== 'complete') failed++;
}
process.exitCode = failed ? 1 : 0;
