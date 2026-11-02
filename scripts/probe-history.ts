import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { StdioRpcClient, RpcFailure, isObject } from '../packages/codex-adapter/src/rpc.ts';
import { launchArguments, runtimeEnvironment, resolveExecutable, verifyExecutable } from '../packages/codex-adapter/src/launch.ts';
import type { ThreadStartResponse } from '../packages/codex-adapter/src/generated/v2/ThreadStartResponse.ts';
import type { ThreadReadResponse } from '../packages/codex-adapter/src/generated/v2/ThreadReadResponse.ts';
import type { ThreadListResponse } from '../packages/codex-adapter/src/generated/v2/ThreadListResponse.ts';
import type { ThreadTurnsListResponse } from '../packages/codex-adapter/src/generated/v2/ThreadTurnsListResponse.ts';
import type { ThreadItemsListResponse } from '../packages/codex-adapter/src/generated/v2/ThreadItemsListResponse.ts';
import { HistoryBrowser } from '../packages/codex-adapter/src/history.ts';
import { readConnection } from '../packages/codex-adapter/src/read-connection.ts';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(join(root, 'codex-version.lock.json'), 'utf8')) as { executableSha256: string; cliVersion: string };
const executable = resolveExecutable('codex'); verifyExecutable(executable, lock.executableSha256);
await mkdir(join(root, '.local'), { recursive: true });
const temporary = await mkdtemp(join(root, '.local/history-probe-'));
const workspace = join(temporary, 'workspace');
const home = join(temporary, 'codex-home');
await mkdir(workspace); await mkdir(home, { mode: 0o700 });
// Local metadata fixture only: no inference and no personal auth/history copied into this isolated home.
const diagnostics: string[] = [];
const rpc = new StdioRpcClient({ executable, args: launchArguments(join(temporary, 'state')),
  env: { ...runtimeEnvironment(), CODEX_HOME: home }, requestTimeoutMs: 15_000,
  onRemoteError: error => {
    const message = isObject(error) && typeof error.message === 'string' ? error.message : '';
    diagnostics.push(/experimental|capabilit|opt.?in/i.test(message) ? 'capability_requirement'
      : /materializ|persist|rollout/i.test(message) ? 'history_materialization'
      : /not.*found|unknown thread/i.test(message) ? 'not_found'
      : /paginat/i.test(message) ? 'history_mode' : 'unclassified');
  } });
let phase = 'initialize';
const verifiedMethods: string[] = [];
const observations: Record<string, unknown> = {};
let evidence: Record<string, unknown>;
try {
  await rpc.request('initialize', { clientInfo: { name: 'personal_agent_history_probe', version: '0.1.0' }, capabilities: { experimentalApi: false } });
  verifiedMethods.push('initialize'); await rpc.notify('initialized'); verifiedMethods.push('initialized');
  phase = 'thread/start';
  const started = await rpc.request<ThreadStartResponse>(phase, { cwd: workspace, sandbox: 'read-only', approvalPolicy: 'on-request', ephemeral: false });
  verifiedMethods.push(phase);
  phase = 'thread/inject_items (synthetic history fixture)';
  await rpc.request('thread/inject_items', { threadId: started.thread.id, items: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic local history fixture; no model request.' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Stored test fixture, not a generated model response.' }] },
  ] });
  observations.syntheticItemsInjected = true;
  phase = 'thread/read';
  const read = await rpc.request<ThreadReadResponse>(phase, { threadId: started.thread.id, includeTurns: false });
  if (read.thread.id !== started.thread.id || read.thread.cwd !== workspace) throw new RpcFailure('HISTORY_SCOPE_MISMATCH');
  observations.historyMode = read.thread.historyMode;
  verifiedMethods.push(phase);
  phase = 'thread/list';
  const listed = await rpc.request<ThreadListResponse>(phase, { cwd: workspace, limit: 2, sourceKinds: ['appServer'], modelProviders: [] });
  if (!Array.isArray(listed.data) || listed.data.some(thread => thread.cwd !== workspace)) throw new RpcFailure('HISTORY_SCOPE_MISMATCH');
  verifiedMethods.push(phase);
  observations.listedThreads = listed.data.length;
  if (read.thread.historyMode !== 'paginated') throw new RpcFailure('FIXTURE_HISTORY_MODE_CHANGED');
  phase = 'thread/turns/list';
  const turns = await rpc.request<ThreadTurnsListResponse>(phase, { threadId: started.thread.id, limit: 2, itemsView: 'summary' });
  if (!Array.isArray(turns.data) || turns.data.length !== 0) throw new RpcFailure('UNEXPECTED_FIXTURE_HISTORY');
  verifiedMethods.push(phase);
  observations.pagedTurns = turns.data.length;
  phase = 'thread/items/list';
  const items = await rpc.request<ThreadItemsListResponse>(phase, { threadId: started.thread.id, limit: 2 });
  if (!Array.isArray(items.data) || items.data.length !== 0) throw new RpcFailure('UNEXPECTED_FIXTURE_HISTORY');
  verifiedMethods.push(phase);
  observations.pagedItems = items.data.length;
  await rpc.close();
  phase = 'read-only browser after App Server restart';
  const browser = new HistoryBrowser(readConnection(executable, join(temporary, 'state'), undefined, home));
  const project = await browser.registerDirectory(workspace);
  const browserPage = await browser.listThreads({ projectId: project.id });
  observations.browserThreadsAfterRestart = browserPage.items.length;
  evidence = { status: 'passed', observedAt: new Date().toISOString(), cliVersion: lock.cliVersion, kind: 'real_app_server_empty_history_probe',
    isolatedCodexHome: true, copiedCredentials: false, inferenceRequested: false, threadId: started.thread.id,
    verifiedMethods, observations,
    scope: 'Empty local fixture metadata and empty history pages only; does not verify model inference or populated history recovery.' };
} catch (error) {
  evidence = { status: 'blocked', observedAt: new Date().toISOString(), cliVersion: lock.cliVersion, kind: 'real_app_server_empty_history_probe',
    phase, verifiedMethods, observations, diagnostics, code: error instanceof RpcFailure ? error.code : 'HOST_ERROR', inferenceRequested: false };
  process.exitCode = 1;
} finally { await rpc.close(); await rm(temporary, { recursive: true, force: true }); }
await writeFile(join(root, 'docs/progress/evidence/M1.1b-native-history.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
