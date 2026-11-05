import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { AppServerRuntime } from '../packages/codex-adapter/src/app-server.ts';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import {
  restrictedAppServerArguments,
  runtimeEnvironment,
} from '../packages/codex-adapter/src/launch.ts';
import { inspectCatalog } from '../packages/codex-adapter/src/smoke.ts';
const root = resolve(import.meta.dirname, '..'),
  pin = verifiedCodex(root),
  directory = mkdtempSync(join(root, '.local/runtime-native-')),
  state = join(directory, 'state'),
  cwd = join(directory, 'public-workspace');
mkdirSync(cwd);
let locale = 'en_US.UTF-8';
const options = () => ({
  executable: verifiedCodex(root).executable,
  args: restrictedAppServerArguments(state, true),
  env: { ...runtimeEnvironment(), LANG: locale },
});
const runtime = new AppServerRuntime(options),
  samples: Array<{ step: string; runtime: ReturnType<AppServerRuntime['snapshot']> }> = [];
const capture = (step: string) => samples.push({ step, runtime: runtime.snapshot() });
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
};
let evidence: Record<string, unknown>;
try {
  const first = await runtime.read(inspectCatalog);
  capture('first-catalog');
  const pid = runtime.snapshot().metadataPid;
  const second = await runtime.read(inspectCatalog);
  await runtime.read((p) => p.request('thread/list', { cwd, limit: 10 }));
  capture('second-catalog-and-empty-public-history');
  assert.equal(runtime.snapshot().metadataPid, pid);
  assert.equal(runtime.snapshot().initializations, 1);
  assert.ok(first.models > 0 && second.models > 0);
  // Changing trusted launch environment retires only this probe's owned connection.
  locale = 'C';
  await runtime.read(inspectCatalog);
  capture('environment-identity-rotation');
  assert.ok(gone(pid!));
  const metadata = runtime.snapshot().metadataPid!,
    fence = await runtime.prepare();
  const dedicated = runtime.openDedicated(options(), fence);
  await dedicated.request('initialize', {
    clientInfo: { name: 'personal_agent_runtime_probe', version: '0.1.0' },
    capabilities: { experimentalApi: false },
  });
  await dedicated.notify('initialized');
  await inspectCatalog(dedicated);
  capture('dedicated-native-initialized-no-thread');
  const dedicatedPid = dedicated.processId!;
  await dedicated.close();
  assert.ok(gone(dedicatedPid));
  assert.equal(runtime.snapshot().metadataPid, metadata);
  assert.equal(runtime.snapshot().dedicatedProcesses, 0);
  capture('dedicated-actually-closed');
  await runtime.reset();
  assert.ok(gone(metadata));
  capture('privacy-fence-closed');
  await runtime.read(inspectCatalog);
  capture('explicit-read-after-reset');
  const last = runtime.snapshot().metadataPid!;
  await runtime.close();
  assert.ok(gone(last));
  capture('shutdown');
  await assert.rejects(runtime.read(inspectCatalog), /APP_SERVER_CLOSED/);
  evidence = {
    status: 'passed',
    checkpoint: 'M3.runtime',
    platform: pin.platform,
    cliVersion: pin.lock.cliVersion,
    kind: 'real pinned CLI stdio initialize/catalog/empty public history; no model execution',
    firstCatalogModels: first.models,
    samePidReused: true,
    initializationsBeforeRotation: 1,
    configurationRotationClosedOldPid: true,
    dedicatedPidActuallyClosed: true,
    privacyResetActuallyClosed: true,
    shutdownActuallyClosed: true,
    modelRequests: 0,
    threadsStarted: 0,
    samples,
  };
} catch (error) {
  evidence = {
    status: 'failed',
    checkpoint: 'M3.runtime',
    code:
      error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'NATIVE_ASSERTION_FAILED',
    modelRequests: 0,
    samples,
  };
  process.exitCode = 1;
} finally {
  await runtime.close();
}
writeFileSync(
  resolve(root, 'docs/progress/evidence/M3-runtime-native.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
