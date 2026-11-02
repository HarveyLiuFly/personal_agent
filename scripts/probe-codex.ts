import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectConnection } from '../packages/codex-adapter/src/smoke.ts';
import { resolveExecutable, verifyExecutable } from '../packages/codex-adapter/src/launch.ts';
import { RpcFailure } from '../packages/codex-adapter/src/rpc.ts';
const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(root, 'codex-version.lock.json'), 'utf8')) as { executableSha256: string; cliVersion: string };
const binary = resolveExecutable('codex');
verifyExecutable(binary, lock.executableSha256);
await mkdir(resolve(root, 'docs/progress/evidence'), { recursive: true });
let evidence: Record<string, unknown>;
try {
  evidence = { status: 'passed', observedAt: new Date().toISOString(), kind: 'real_app_server_catalog_probe',
    cliVersion: lock.cliVersion, verifiedMethods: ['initialize', 'initialized', 'model/list'],
    ...await inspectConnection(binary, resolve(root, '.local/codex-state')) };
} catch (error) {
  evidence = { status: 'blocked', observedAt: new Date().toISOString(), kind: 'real_app_server_catalog_probe',
    code: error instanceof RpcFailure ? error.code : 'HOST_ERROR' };
  process.exitCode = 1;
}
await writeFile(resolve(root, 'docs/progress/evidence/M0-catalog-probe.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
