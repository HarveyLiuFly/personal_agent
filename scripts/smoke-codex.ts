import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runRealSmoke } from '../packages/codex-adapter/src/smoke.ts';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { RpcFailure } from '../packages/codex-adapter/src/rpc.ts';

const root = resolve(import.meta.dirname, '..');
const { executable, lock, platform } = verifiedCodex(root);
const directory = resolve(root, 'docs/progress/evidence');
await mkdir(directory, { recursive: true });
let evidence: Record<string, unknown>;
try {
  evidence = { observedAt: new Date().toISOString(), cliVersion: lock.cliVersion, platform,
    ...await runRealSmoke(executable, resolve(root, '.local/codex-state')), kind: 'real_app_server_model_smoke',
    executableSha256: lock.platforms[platform]!.executableSha256, schemaFingerprint: lock.schemaFingerprint,
    verifiedMethods: ['initialize', 'initialized', 'model/list', 'thread/start', 'turn/start'],
    scope: 'One client turn/start in an isolated ephemeral read-only workspace; no tools permitted or task Composer enabled.' };
} catch (error) {
  evidence = { observedAt: new Date().toISOString(), cliVersion: lock.cliVersion, platform, status: 'blocked',
    kind: 'real_app_server_model_smoke', code: error instanceof RpcFailure ? error.code : 'HOST_ERROR',
    outcomeUnknown: error instanceof RpcFailure ? error.outcomeUnknown : true,
    details: error instanceof RpcFailure ? error.details : undefined };
  process.exitCode = 1;
}
await writeFile(resolve(directory, 'M0-real-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
await writeFile(resolve(directory, `M0-real-smoke-${String(evidence.observedAt).replaceAll(':', '-').replaceAll('.', '-')}.json`), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
