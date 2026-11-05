import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { ForegroundExecution } from '../packages/runtime/src/execution.ts';
import { ExecutionLedger, LedgerError } from '../packages/store/src/ledger.ts';
import { HistoryBrowser } from '../packages/codex-adapter/src/history.ts';
import { readConnection } from '../packages/codex-adapter/src/read-connection.ts';
import { RpcFailure } from '../packages/codex-adapter/src/rpc.ts';
const root = resolve(import.meta.dirname, '..'),
  { executable, lock, platform } = verifiedCodex(root);
mkdirSync(resolve(root, '.local'), { recursive: true });
const temporary = mkdtempSync(resolve(root, '.local/M1-execution-')),
  workspace = resolve(temporary, 'workspace');
mkdirSync(workspace);
const file = resolve(temporary, 'execution/ledger.db'),
  state = resolve(temporary, 'codex-state');
const schema = readFileSync(resolve(root, 'docs/design/contracts/schema.sql'), 'utf8');
const expected = `M1_READY_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const evidenceFile = resolve(root, 'docs/progress/evidence/M1.1c-real-execution.json');
writeFileSync(
  evidenceFile,
  JSON.stringify(
    {
      status: 'running',
      observedAt: new Date().toISOString(),
      platform,
      scope: 'One read-only durable runtime turn; no automatic resend.',
    },
    null,
    2,
  ) + '\n',
);
const store = new ExecutionLedger(file, schema);
store.startOwner(randomUUID(), true);
const runtime = new ForegroundExecution(store, { executable, stateDirectory: state });
let evidence: Record<string, unknown>;
let runId: string | undefined;
try {
  const project = store.registerWorkspace(workspace);
  const run = runtime.submit({
    projectId: project.id,
    submissionKey: randomUUID(),
    text: `Protocol smoke only. Do not call tools, read files or access websites. Reply with exactly ${expected} and nothing else.`,
  });
  runId = run.runId;
  await runtime.wait();
  const result = runtime.view({ projectId: project.id, runId });
  const finalText = result.snapshot?.items
    .filter((item) => item.role === 'assistant' && item.status === 'complete')
    .map((item) => item.text)
    .join('')
    .trim();
  const tools = result.snapshot?.items.filter(
    (item) => !['message', 'reasoning', 'plan'].includes(item.kind),
  ).length;
  if (
    result.status !== 'completed' ||
    result.taskStatus !== 'needs_review' ||
    finalText !== expected ||
    tools !== 0 ||
    runtime.diagnostics.serverRequestsDenied !== 0 ||
    runtime.diagnostics.externalMcpServers !== 0
  )
    throw new LedgerError('REAL_EXECUTION_VALIDATION_FAILED');
  const browser = new HistoryBrowser(readConnection(executable, state));
  const grant = await browser.registerDirectory(workspace);
  const threads = await browser.listThreads({ projectId: grant.id });
  if (!threads.items.some((thread) => thread.id === result.threadId))
    throw new LedgerError('REAL_THREAD_NOT_LISTED');
  const turns = await browser.listTurns({ projectId: grant.id, threadId: result.threadId! });
  if (!turns.items.some((turn) => turn.id === result.turnId))
    throw new LedgerError('REAL_TURN_NOT_LISTED');
  const items = await browser.listItems({
    projectId: grant.id,
    threadId: result.threadId!,
    turnId: result.turnId!,
  });
  if (!items.items.some((item) => item.role === 'assistant' && item.text === expected))
    throw new LedgerError('REAL_HISTORY_CONTENT_MISMATCH');
  await runtime.close();
  store.close();
  const reopened = new ExecutionLedger(file, schema);
  reopened.startOwner(randomUUID(), true);
  const recovered = reopened.runs(project.id)[0]!;
  const restored =
    recovered.runId === runId &&
    recovered.status === 'completed' &&
    recovered.snapshot?.items.some(
      (item) => item.role === 'assistant' && item.text === expected,
    ) === true;
  reopened.close();
  if (!restored) throw new LedgerError('DURABLE_CACHE_REOPEN_FAILED');
  evidence = {
    status: 'passed',
    observedAt: new Date().toISOString(),
    kind: 'real_model_with_durable_execution_ledger_and_populated_history',
    cliVersion: lock.cliVersion,
    platform,
    model: runtime.diagnostics.selectedModel,
    schemaFingerprint: lock.schemaFingerprint,
    runId,
    threadId: result.threadId,
    turnId: result.turnId,
    finalText,
    expectedText: expected,
    toolItems: tools,
    taskStatus: result.taskStatus,
    diagnostics: runtime.diagnostics,
    durableSnapshotAfterReopen: restored,
    populatedNativeHistory: {
      threads: threads.items.length,
      turns: turns.items.length,
      items: items.items.length,
      finalContentMatched: true,
    },
    verifiedMethods: [
      'initialize',
      'initialized',
      'model/list',
      'mcpServerStatus/list',
      'thread/start',
      'turn/start',
      'thread/list',
      'thread/read',
      'thread/turns/list',
      'thread/items/list',
    ],
    scope:
      'One real read-only no-tool turn through the product runtime and ledger. Reopened local display cache plus scoped populated native history. No code editing/approval/stop/crash-reconciliation gate claimed.',
  };
} catch (error) {
  evidence = {
    status: 'blocked',
    observedAt: new Date().toISOString(),
    kind: 'real_model_with_durable_execution_ledger_and_populated_history',
    cliVersion: lock.cliVersion,
    platform,
    runId,
    diagnostics: runtime.diagnostics,
    code: error instanceof LedgerError || error instanceof RpcFailure ? error.code : 'HOST_ERROR',
    scope:
      'Do not automatically rerun this probe. Inspect the durable run before another submission.',
  };
  process.exitCode = 1;
} finally {
  await runtime.close();
  try {
    store.close();
  } catch {}
}
writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(
  evidenceFile.replace(
    '.json',
    `-${String(evidence.observedAt).replaceAll(':', '-').replaceAll('.', '-')}.json`,
  ),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
