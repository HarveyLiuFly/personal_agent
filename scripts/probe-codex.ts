import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectConnection } from '../packages/codex-adapter/src/smoke.ts';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { RpcFailure } from '../packages/codex-adapter/src/rpc.ts';
import { evidenceDir } from './lib/evidence.mjs';
const root = resolve(import.meta.dirname, '..');
const { executable: binary, lock, platform } = verifiedCodex(root);
const directory = evidenceDir(root);
await mkdir(directory, { recursive: true });
let evidence: Record<string, unknown>;
try {
  evidence = {
    status: 'passed',
    observedAt: new Date().toISOString(),
    kind: 'real_app_server_catalog_probe',
    cliVersion: lock.cliVersion,
    platform,
    verifiedMethods: ['initialize', 'initialized', 'model/list'],
    ...(await inspectConnection(binary, resolve(root, '.local/codex-state'))),
  };
} catch (error) {
  evidence = {
    status: 'blocked',
    observedAt: new Date().toISOString(),
    kind: 'real_app_server_catalog_probe',
    code: error instanceof RpcFailure ? error.code : 'HOST_ERROR',
  };
  process.exitCode = 1;
}
await writeFile(
  resolve(directory, 'M0-local-catalog-probe.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
