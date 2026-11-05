import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import electron from 'electron';
import { openDisplay } from './virtual-display.mjs';
const root = resolve('.'),
  original = JSON.parse(
    await readFile(join(root, 'docs/progress/evidence/M2.7c-desktop.json'), 'utf8'),
  );
let state;
for (const name of await readdir(join(root, '.local'))) {
  if (!name.startsWith('desktop-restore-smoke-')) continue;
  try {
    const path = join(root, '.local', name),
      prior = JSON.parse(await readFile(join(path, 'reopen-result.json'), 'utf8'));
    if (prior.native?.runId === original.native.runId) {
      state = path;
      break;
    }
  } catch {}
}
if (!state) throw Error('RESTORED_NATIVE_FIXTURE_NOT_FOUND');
let display, evidence;
try {
  display = await openDisplay(root);
  const child = spawn(
      electron,
      ['.', '--m2-restore-smoke', '--restore-phase=verify', '--restore-state=' + state],
      { cwd: root, env: display.env, stdio: 'inherit' },
    ),
    timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  let exit;
  try {
    exit = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => done({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
  }
  const result = JSON.parse(await readFile(join(state, 'verify-result.json'), 'utf8'));
  evidence = {
    status: exit.code === 0 && Object.values(result.result).every(Boolean) ? 'passed' : 'blocked',
    kind: 'new_electron_process_reads_same_completed_restored_native_run',
    inferenceRequested: false,
    additionalModelTurns: 0,
    originalEvidence: 'M2.7c-desktop.json',
    originalModelTurns: original.modelTurns,
    correction:
      'initial assertion used runForHost without snapshots; fixed to scoped snapshot query, never resubmitted',
    ...result,
  };
} catch (error) {
  evidence = {
    status: 'blocked',
    kind: 'existing_restored_run_verification',
    inferenceRequested: false,
    additionalModelTurns: 0,
    code: 'RESTORED_RUN_VERIFICATION_FAILED',
  };
} finally {
  await display?.close();
}
evidence.observedAt = new Date().toISOString();
await writeFile(
  join(root, 'docs/progress/evidence/M2.7c-native-verification.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
if (evidence.status !== 'passed') process.exitCode = 1;
