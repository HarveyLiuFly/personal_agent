import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ExecutionLedger, LedgerError } from '../packages/store/src/ledger.ts';
import { ForegroundExecution } from '../packages/runtime/src/execution.ts';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
const root = resolve(import.meta.dirname, '..'),
  binary = verifiedCodex(root),
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-native-budget-'))),
  cwd = join(folder, 'workspace');
mkdirSync(cwd);
writeFileSync(join(cwd, 'public-fixture.txt'), 'Owned read-only usage accounting fixture.\n');
const store = new ExecutionLedger(
  join(folder, 'ledger.db'),
  readFileSync(join(root, 'docs/design/contracts/schema.sql'), 'utf8'),
);
store.startOwner(randomUUID(), true);
const project = store.registerWorkspace(cwd, cwd),
  execution = new ForegroundExecution(store, {
    executable: binary.executable,
    stateDirectory: join(folder, 'codex-state'),
    mode: 'readOnly',
    timeoutMs: 120000,
  });
let evidence: Record<string, unknown>;
try {
  const run = execution.submit({
    projectId: project.id,
    submissionKey: randomUUID(),
    text: 'Reply exactly M2_BUDGET_NATIVE_OK. Do not use tools or modify files.',
  });
  await execution.wait();
  const final = execution.view({ projectId: project.id, runId: run.runId }),
    budget = store.resourceBudget(),
    text =
      final.snapshot?.items
        .filter((i) => i.role === 'assistant' && i.kind === 'message')
        .map((i) => i.text)
        .join('') ?? '',
    tools =
      final.snapshot?.items.filter((i) => ['command', 'files', 'tool'].includes(i.kind)).length ??
      0;
  const passed =
    final.status === 'completed' &&
    final.taskStatus === 'needs_review' &&
    text.trim() === 'M2_BUDGET_NATIVE_OK' &&
    budget.reportedTokens > 0 &&
    budget.reservedTokens === 0 &&
    budget.unknownHeldTokens === 0 &&
    budget.activeRuns === 0 &&
    tools === 0 &&
    execution.diagnostics.clientTurnStarts === 1 &&
    execution.diagnostics.nativePolicyVerified;
  evidence = {
    status: passed ? 'passed' : 'blocked',
    observedAt: new Date().toISOString(),
    kind: 'real_locked_app_server_read_only_model_and_reported_token_usage',
    platform: binary.platform,
    cliVersion: binary.lock.cliVersion,
    inferenceRequested: true,
    model: execution.diagnostics.selectedModel,
    attempts: 1,
    turnStarts: execution.diagnostics.clientTurnStarts,
    runStatus: final.status,
    taskStatus: final.taskStatus,
    expectedPublicReply: text.trim() === 'M2_BUDGET_NATIVE_OK',
    toolItems: tools,
    reportedTokens: budget.reportedTokens,
    reservedTokens: budget.reservedTokens,
    unknownHeldTokens: budget.unknownHeldTokens,
    activeRuns: budget.activeRuns,
    estimatedUsd: null,
    nativePolicyVerified: execution.diagnostics.nativePolicyVerified,
    privateProfile: 'isolated_owned_fixture',
    note: 'Observed provider-reported tokens, not subscription billing. No Task completion claimed.',
  };
  if (!passed) process.exitCode = 1;
} catch (error) {
  evidence = {
    status: 'blocked',
    observedAt: new Date().toISOString(),
    inferenceRequested: true,
    attempts: 1,
    code: error instanceof LedgerError ? error.code : 'NATIVE_BUDGET_PROBE_FAILED',
  };
  process.exitCode = 1;
} finally {
  await execution.close();
  store.close();
}
const output = join(root, 'docs/progress/evidence/M2.2c-native-budget.json');
writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(
  output.replace(
    '.json',
    `-${String(evidence.observedAt).replaceAll(':', '-').replaceAll('.', '-')}.json`,
  ),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
if (evidence.status === 'passed') rmSync(folder, { recursive: true, force: true });
