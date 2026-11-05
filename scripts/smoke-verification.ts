import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { resolveVerifierNode } from '../packages/codex-adapter/src/launch.ts';
import { ExecutionLedger, LedgerError } from '../packages/store/src/ledger.ts';
import { NodeVerification } from '../packages/verification/src/verification.ts';
const root = resolve(import.meta.dirname, '..'),
  { executable, lock, platform } = verifiedCodex(root),
  node = resolveVerifierNode(root);
mkdirSync(join(root, '.local'), { recursive: true });
const folder = mkdtempSync(join(root, '.local/M1-verifier-')),
  cwd = join(folder, 'workspace');
mkdirSync(cwd);
mkdirSync(join(cwd, 'src'));
mkdirSync(join(cwd, 'test'));
writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
writeFileSync(join(cwd, 'src/math.mjs'), 'export const sum=(a,b)=>a-b;\n');
writeFileSync(
  join(cwd, 'test/math.test.mjs'),
  "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {sum} from '../src/math.mjs';\ntest('adds positive integers',()=>assert.equal(sum(2,3),5));\ntest('adds negative integers',()=>assert.equal(sum(-2,-3),-5));\n",
);
const git = (args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { stdio: 'ignore' });
git(['init', '--quiet']);
git(['add', '.']);
git([
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '--quiet',
  '--no-gpg-sign',
  '-m',
  'verification baseline',
]);
const store = new ExecutionLedger(
  join(folder, 'store.db'),
  readFileSync(join(root, 'docs/design/contracts/schema.sql'), 'utf8'),
);
store.startOwner(randomUUID(), true);
const project = store.registerWorkspace(cwd);
const { token } = store.beginRun(
  project.id,
  'Trusted verifier sandbox fixture; no model',
  'verification-smoke',
  'workspaceWrite',
);
const service = new NodeVerification(store, {
  node,
  cli: executable,
  reporter: join(root, 'packages/verification/src/reporter.mjs'),
  stateDirectory: join(folder, 'verification'),
});
let evidence: Record<string, unknown>;
try {
  await service.prepare(token, {
    profile: 'node-test',
    target: 'test/math.test.mjs',
    allowedPaths: ['src/math.mjs'],
  });
  writeFileSync(join(cwd, 'src/math.mjs'), 'export const sum=(a,b)=>a+b;\n');
  // Synthetic model execution metadata only. This probe exercises the real verifier, not inference.
  const thread = store.prepare(token, 'thread', 'thread_start', {});
  store.sending(token, thread.intentId, 1);
  store.accepted(token, thread.intentId, { threadId: 'synthetic-verifier-thread' });
  const turn = store.prepare(token, 'turn', 'turn_start', {}, 'synthetic-verifier-thread');
  store.sending(token, turn.intentId, 1);
  store.accepted(token, turn.intentId, { turnId: 'synthetic-verifier-turn' });
  store.finish(token, 'completed');
  const receipt = await service.verify(project.id, token.runId);
  if (receipt.status !== 'passed' || receipt.executed !== 2) throw new LedgerError(receipt.code);
  evidence = {
    status: 'passed',
    observedAt: new Date().toISOString(),
    kind: 'real_sandbox_node_verifier_with_synthetic_model_metadata',
    cliVersion: lock.cliVersion,
    platform,
    inferenceRequested: false,
    modelExecution: 'synthetic_metadata_only',
    scope:
      'Real CLI minimal filesystem/network permission profile, real Node test event reporter and real Git/SQLite/artifact receipt. Math edit performed by the Host fixture; not a model code task or M1 gate.',
    requiredCases: receipt.requiredCases.length,
    discovered: receipt.discovered,
    executed: receipt.executed,
    skipped: receipt.skipped,
    exitCode: receipt.exitCode,
    taskStatus: store.runs(project.id)[0]!.taskStatus,
    receiptHashVerified:
      service.result(project.id, token.runId)?.verificationId === receipt.verificationId,
  };
} catch (error) {
  evidence = {
    status: 'blocked',
    observedAt: new Date().toISOString(),
    kind: 'real_sandbox_node_verifier_with_synthetic_model_metadata',
    inferenceRequested: false,
    code: error instanceof LedgerError ? error.code : 'HOST_ERROR',
  };
  process.exitCode = 1;
} finally {
  store.close();
}
const file = join(
  process.env.PERSONAL_AGENT_EVIDENCE_DIR
    ? resolve(process.env.PERSONAL_AGENT_EVIDENCE_DIR)
    : join(root, 'docs/progress/evidence'),
  'M1.3b-native-verifier.json',
);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(
  file.replace(
    '.json',
    `-${String(evidence.observedAt).replaceAll(':', '-').replaceAll('.', '-')}.json`,
  ),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
