// CORE.2a: on the real pinned Codex, a slow history listing no longer holds up other metadata
// reads, and the history page is answered from the cache. No model request, no thread is started.
// Usage: node scripts/probe-metadata-concurrency.ts [--state <codex-state dir>] [--cwd <folder>]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AppServerRuntime } from '../packages/codex-adapter/src/app-server.ts';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { HistoryBrowser } from '../packages/codex-adapter/src/history.ts';
import {
  restrictedAppServerArguments,
  runtimeEnvironment,
} from '../packages/codex-adapter/src/launch.ts';
import { inspectCatalog } from '../packages/codex-adapter/src/smoke.ts';
import { readStateIndex } from '../packages/codex-adapter/src/state-index.ts';
import { evidenceDir } from './lib/evidence.mjs';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    state: { type: 'string', default: '.local/desktop-concurrency-smoke-data/codex-state' },
    cwd: { type: 'string', default: root },
  },
});
const state = resolve(values.state!),
  cwd = resolve(values.cwd!),
  pin = verifiedCodex(root);
const index = readStateIndex(state);
if (index.status !== 'complete') {
  console.error(
    `The Codex state index in ${state} is ${index.status}; start the app once with it first.`,
  );
  process.exit(2);
}
const runtime = new AppServerRuntime(() => ({
  executable: pin.executable,
  args: restrictedAppServerArguments(state, true),
  env: runtimeEnvironment(),
}));
let step = 'start';
const timed = async <T>(
  name: string,
  work: () => Promise<T>,
): Promise<{ ms: number; value: T }> => {
  step = name;
  const begun = performance.now();
  try {
    const value = await work();
    return { ms: Math.round(performance.now() - begun), value };
  } catch (error) {
    console.error(`${name} failed after ${Math.round(performance.now() - begun)} ms`);
    throw error;
  }
};
const list = () =>
  runtime.read((port) =>
    port.request<{ data: unknown[] }>('thread/list', {
      cwd,
      limit: 20,
      modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
      sortKey: 'updated_at',
      sortDirection: 'desc',
    }),
  );
let evidence: Record<string, unknown>;
try {
  const started = await timed('start', () => runtime.read(inspectCatalog));
  const listAlone = await timed('listAlone', list);
  const inspectAlone = await timed('inspectAlone', () => runtime.read(inspectCatalog));
  // A slow listing in flight; the connection check and a second catalog read go beside it.
  const slow = timed('listDuring', list);
  await new Promise((done) => setTimeout(done, 200));
  const [inspectDuring, readDuring] = await Promise.all([
    timed('inspectDuring', () => runtime.read(inspectCatalog)),
    timed('readDuring', () => runtime.read(inspectCatalog)),
  ]);
  const listDuring = await slow;
  // History page: the first call reads live, the next is served from the cache.
  const history = new HistoryBrowser((read) => runtime.read(read));
  const project = await history.registerDirectory(cwd);
  const firstPage = await timed('historyFirst', () =>
    history.listThreads({ projectId: project.id }),
  );
  const cachedPage = await timed('historyCached', () =>
    history.listThreads({ projectId: project.id }),
  );
  const snapshot = runtime.snapshot();
  const passed =
    inspectDuring.ms < 1000 &&
    readDuring.ms < 1000 &&
    inspectDuring.ms < listDuring.ms &&
    cachedPage.ms < 50 &&
    cachedPage.value.items.length === firstPage.value.items.length &&
    snapshot.starts === 1;
  evidence = {
    status: passed ? 'passed' : 'failed',
    checkpoint: 'CORE.2a',
    kind: 'real pinned CLI metadata connection; no model request, no thread started',
    platform: pin.platform,
    cliVersion: pin.lock.cliVersion,
    indexedThreads: index.threads,
    startMs: started.ms,
    listAloneMs: listAlone.ms,
    inspectAloneMs: inspectAlone.ms,
    listDuringMs: listDuring.ms,
    inspectDuringListMs: inspectDuring.ms,
    secondReadDuringListMs: readDuring.ms,
    historyFirstPageMs: firstPage.ms,
    historyCachedPageMs: cachedPage.ms,
    historyThreads: firstPage.value.items.length,
    metadataStarts: snapshot.starts,
    modelRequests: 0,
  };
  if (!passed) process.exitCode = 1;
} catch (error) {
  evidence = {
    status: 'failed',
    checkpoint: 'CORE.2a',
    code:
      error instanceof Error && /^[A-Z0-9_-]+$/.test(error.message)
        ? error.message
        : 'PROBE_FAILED',
    step,
    modelRequests: 0,
  };
  process.exitCode = 1;
} finally {
  await runtime.close();
}
writeFileSync(
  resolve(evidenceDir(root), 'CORE.2a-metadata-concurrency.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
