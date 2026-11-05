import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { runtimeEnvironment } from '../packages/codex-adapter/src/launch.ts';
import { StdioRpcClient, RpcFailure, isObject } from '../packages/codex-adapter/src/rpc.ts';
import { readConnection } from '../packages/codex-adapter/src/read-connection.ts';
import { ExecutionLedger, LedgerError } from '../packages/store/src/ledger.ts';
import { ForegroundExecution, executionArguments } from '../packages/runtime/src/execution.ts';
import { HistoryReconciliation } from '../packages/runtime/src/reconciliation.ts';
import { DatabaseSync } from 'node:sqlite';
import { evidenceDir } from './lib/evidence.mjs';
const root = resolve(import.meta.dirname, '..'),
  binary = verifiedCodex(root);
// Retry only the read-only phase of this controlled probe, never the original model request.
if (process.argv[2] === '--reconcile-existing') {
  const existing = realpathSync(process.argv[3] ?? '');
  assert.ok(basename(existing).startsWith('personal-agent-reconcile-'));
  const db = new DatabaseSync(join(existing, 'ledger.db'), { readOnly: true });
  const row = db.prepare('SELECT workspace_id,canonical_cwd FROM workspaces').get()!;
  assert.equal(row.canonical_cwd, join(existing, 'workspace'));
  const turns = Number(
    db.prepare("SELECT COUNT(*) AS n FROM execution_intents WHERE kind='turn_start'").get()!.n,
  );
  db.close();
  assert.equal(turns, 1);
  const owned = new ExecutionLedger(
    join(existing, 'ledger.db'),
    readFileSync(join(root, 'docs/design/contracts/schema.sql'), 'utf8'),
  );
  owned.startOwner(randomUUID(), true);
  try {
    const before = owned.runs(String(row.workspace_id))[0]!,
      marker = before
        .snapshot!.items.filter((i) => i.role === 'assistant' && i.kind === 'message')
        .at(-1)!
        .text.trim();
    assert.match(marker, /^M1_RECONCILED_[a-f0-9]{8}$/);
    assert.equal(before.status, 'outcome_unknown');
    const methods: string[] = [];
    await new HistoryReconciliation(owned, (read) =>
      readConnection(
        binary.executable,
        join(existing, 'codex-state'),
      )((port) =>
        read({
          request: async <T>(method: string, params: unknown) => {
            methods.push(method);
            return port.request<T>(method, params);
          },
        }),
      ),
    ).reconcile({ projectId: before.workspaceId, runId: before.runId });
    const after = owned.runs(before.workspaceId)[0]!;
    assert.equal(after.status, 'completed');
    assert.equal(after.taskStatus, 'needs_review');
    assert.equal(after.blocked, false);
    assert.equal(
      after
        .snapshot!.items.filter((i) => i.role === 'assistant' && i.kind === 'message')
        .at(-1)!
        .text.trim(),
      marker,
    );
    const proof = {
      status: 'passed',
      observedAt: new Date().toISOString(),
      kind: 'real_native_model_receipt_loss_and_read_only_reconciliation',
      platform: binary.platform,
      cliVersion: binary.lock.cliVersion,
      inferenceRequested: false,
      totalOriginalModelTurns: turns,
      recoveryOf: 'M1.3c-native-reconciliation-2026-11-02T17-07-49-575Z.json',
      correction:
        'Read-only history uses the original configured sqlite_home. Initial probe accidentally selected another empty native database. Same original Run; zero additional model requests.',
      runId: after.runId,
      threadId: after.threadId,
      turnId: after.turnId,
      marker,
      before: { runStatus: before.status, blocked: before.blocked, turnId: before.turnId },
      after: {
        runStatus: after.status,
        taskStatus: after.taskStatus,
        blocked: after.blocked,
        needsSnapshot: after.snapshot!.needsSnapshot,
        markerMatched: true,
      },
      reconciliationMethods: methods,
    };
    const output = join(evidenceDir(root), 'M1.3c-native-reconciliation.json');
    writeFileSync(output, JSON.stringify(proof, null, 2) + '\n');
    writeFileSync(
      output.replace(
        '.json',
        `-${proof.observedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`,
      ),
      JSON.stringify(proof, null, 2) + '\n',
    );
    console.log(JSON.stringify(proof, null, 2));
  } finally {
    owned.close();
  }
  process.exit(0);
}
const folder = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-reconcile-'))),
  cwd = join(folder, 'workspace');
mkdirSync(cwd);
const file = join(folder, 'ledger.db'),
  schema = readFileSync(join(root, 'docs/design/contracts/schema.sql'), 'utf8');
let store = new ExecutionLedger(file, schema);
store.startOwner(randomUUID(), true);
const project = store.registerWorkspace(cwd),
  marker = 'M1_RECONCILED_' + randomUUID().slice(0, 8),
  text = `Reply with exactly ${marker}. Do not use tools, write files, or make external requests.`;
let nativeTerminal!: () => void;
const terminal = new Promise<void>((done) => {
  nativeTerminal = done;
});
let discarded = 0,
  terminalStatus = '';
const runtime = new ForegroundExecution(store, {
  executable: binary.executable,
  stateDirectory: join(folder, 'codex-state'),
  timeoutMs: 90000,
  connect: (callbacks) => {
    const rpc = new StdioRpcClient({
      executable: binary.executable,
      args: executionArguments(join(folder, 'codex-state')),
      env: runtimeEnvironment(),
      requestTimeoutMs: 30000,
      ...callbacks,
      onNotification: (message) => {
        callbacks.onNotification?.(message);
        if (
          message.method === 'turn/completed' &&
          isObject(message.params) &&
          isObject(message.params.turn)
        ) {
          terminalStatus = String(message.params.turn.status);
          nativeTerminal();
        }
      },
    });
    const original = rpc.requestWithId.bind(rpc);
    rpc.requestWithId = async function <T>(
      id: string | number,
      method: string,
      params: unknown,
      timeout?: number,
    ): Promise<T> {
      const receipt = await original<T>(id, method, params, timeout);
      if (method === 'turn/start') {
        discarded++;
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            terminal,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new RpcFailure('INJECTED_RECEIPT_WAIT_TIMEOUT', true)),
                90000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        // Trusted diagnostic injection: the adapter receives this native RPC receipt but Runtime never does.
        throw new RpcFailure('INJECTED_TURN_RECEIPT_LOSS', true);
      }
      return receipt;
    };
    return rpc;
  },
});
let evidence: Record<string, unknown>;
try {
  const run = runtime.submit({ projectId: project.id, submissionKey: randomUUID(), text });
  await runtime.wait();
  const unknown = runtime.view({ projectId: project.id, runId: run.runId });
  assert.equal(discarded, 1);
  assert.equal(terminalStatus, 'completed');
  assert.equal(unknown.status, 'outcome_unknown');
  assert.equal(unknown.blocked, true);
  assert.equal(unknown.turnId, null);
  await runtime.close();
  store.close();
  store = new ExecutionLedger(file, schema);
  store.startOwner(randomUUID(), true);
  const methods: string[] = [];
  const reconciliation = new HistoryReconciliation(store, (read) =>
    readConnection(
      binary.executable,
      join(folder, 'codex-state'),
    )((port) =>
      read({
        request: async <T>(method: string, params: unknown) => {
          methods.push(method);
          return port.request<T>(method, params);
        },
      }),
    ),
  );
  await reconciliation.reconcile({ projectId: project.id, runId: run.runId });
  const final = store.runs(project.id)[0]!,
    assistant = final
      .snapshot!.items.filter((i) => i.role === 'assistant' && i.kind === 'message')
      .at(-1);
  assert.equal(final.status, 'completed');
  assert.equal(final.taskStatus, 'needs_review');
  assert.equal(final.blocked, false);
  assert.equal(assistant?.text.trim(), marker);
  assert.equal(final.snapshot!.needsSnapshot, false);
  assert.equal(runtime.diagnostics.clientTurnStarts, 1);
  evidence = {
    status: 'passed',
    observedAt: new Date().toISOString(),
    kind: 'real_native_model_receipt_loss_and_read_only_reconciliation',
    platform: binary.platform,
    cliVersion: binary.lock.cliVersion,
    inferenceRequested: true,
    injection:
      'Native turn/start response discarded at trusted adapter-to-Runtime boundary after native terminal notification. No stdio frame corruption; no automatic resend.',
    ownerRestart:
      'Real SQLite close/reopen in one CLI probe, not Electron OS-lock restart acceptance.',
    runId: final.runId,
    threadId: final.threadId,
    turnId: final.turnId,
    marker,
    discardedReceipts: discarded,
    nativeTerminalStatus: terminalStatus,
    clientThreadStarts: runtime.diagnostics.clientThreadStarts,
    clientTurnStarts: runtime.diagnostics.clientTurnStarts,
    before: { runStatus: unknown.status, blocked: unknown.blocked, turnId: unknown.turnId },
    after: {
      runStatus: final.status,
      taskStatus: final.taskStatus,
      blocked: final.blocked,
      needsSnapshot: final.snapshot!.needsSnapshot,
      markerMatched: true,
    },
    reconciliationMethods: methods,
  };
} catch (error) {
  evidence = {
    status: 'blocked',
    observedAt: new Date().toISOString(),
    kind: 'real_native_model_receipt_loss_and_read_only_reconciliation',
    inferenceRequested: runtime.diagnostics.clientTurnStarts > 0,
    code:
      error instanceof RpcFailure || error instanceof LedgerError
        ? error.code
        : 'PROBE_ASSERTION_FAILED',
    discardedReceipts: discarded,
    nativeTerminalStatus: terminalStatus,
    diagnostics: runtime.diagnostics,
  };
  process.exitCode = 1;
} finally {
  await runtime.close();
  store.close();
}
const output = join(evidenceDir(root), 'M1.3c-native-reconciliation.json');
writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(
  output.replace(
    '.json',
    `-${String(evidence.observedAt).replaceAll(':', '-').replaceAll('.', '-')}.json`,
  ),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
