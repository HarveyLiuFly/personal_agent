import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { resolveVerifierNode } from '../packages/codex-adapter/src/launch.ts';
import { ExecutionLedger, LedgerError } from '../packages/store/src/ledger.ts';
import { ForegroundExecution } from '../packages/runtime/src/execution.ts';
import { RpcFailure } from '../packages/codex-adapter/src/rpc.ts';
const scenario = process.argv[2];
assert.ok(['deny', 'accept', 'interrupt'].includes(scenario ?? ''));
const root = resolve(import.meta.dirname, '..'),
  binary = verifiedCodex(root),
  node = resolveVerifierNode(root),
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-native-interaction-'))),
  cwd = join(folder, 'workspace'),
  zone = join(folder, 'approval-zone');
mkdirSync(cwd);
mkdirSync(zone);
const helper = join(cwd, scenario === 'interrupt' ? 'slow-helper.mjs' : 'approval-helper.mjs'),
  effect = join(scenario === 'interrupt' ? cwd : zone, 'effect.txt'),
  pidFile = join(cwd, 'helper-pid.json'),
  nonce = randomUUID();
const source =
  scenario === 'interrupt'
    ? `import {writeFileSync,renameSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile + '.tmp')},JSON.stringify({pid:process.pid,nonce:${JSON.stringify(nonce)}}));renameSync(${JSON.stringify(pidFile + '.tmp')},${JSON.stringify(pidFile)});setTimeout(()=>writeFileSync(${JSON.stringify(effect)},'late-effect'),15000);\n`
    : `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(effect)},${JSON.stringify(nonce)},{flag:'wx'});\n`;
writeFileSync(helper, source, { mode: 0o444 });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex'),
  helperHash = hash(source);
const command = `${node} ${helper}`,
  quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const allowedCommands = new Set([
  command,
  `/bin/zsh -lc ${quote(command)}`,
  `/bin/bash -lc ${quote(command)}`,
  `/bin/sh -c ${quote(command)}`,
]);
const store = new ExecutionLedger(
  join(folder, 'ledger.db'),
  readFileSync(join(root, 'docs/design/contracts/schema.sql'), 'utf8'),
);
store.startOwner(randomUUID(), true);
const project = store.registerWorkspace(cwd);
const runtime = new ForegroundExecution(store, {
  executable: binary.executable,
  stateDirectory: join(folder, 'codex-state'),
  mode: 'workspaceWrite',
  timeoutMs: 90000,
  interactionTimeoutMs: 30000,
  interruptTimeoutMs: 5000,
});
const decisions: Array<{
  kind: string;
  commandHash: string;
  whitelisted: boolean;
  decision: string;
}> = [];
let helperPid: number | undefined,
  interruptRequested = false,
  pidIdentityConfirmed = false;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const helperIdentity = (pid: number) => {
  try {
    return (
      execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === command
    );
  } catch {
    return false;
  }
};
let evidence: Record<string, unknown>;
try {
  const text =
    scenario === 'interrupt'
      ? `Run exactly this command in the selected workspace and wait for it. Do not modify any file or helper. Do not use network, Git or any other command. Command: ${command}`
      : `Run exactly this command in the selected workspace using exec_command with sandbox_permissions="require_escalated" so the Host asks for one-time approval. The frozen helper writes only the controlled test sentinel outside the workspace. Do not modify the helper, use network, Git, or run any other command. If approval is declined, do not retry or use another method; state denied and stop. Exact command: ${command}`;
  const run = runtime.submit({ projectId: project.id, text, submissionKey: randomUUID() }),
    query = { projectId: project.id, runId: run.runId },
    deadline = Date.now() + 105000;
  while (runtime.busy) {
    if (Date.now() > deadline) {
      await runtime.interrupt(query);
      throw new LedgerError('NATIVE_INTERACTION_DEADLINE');
    }
    for (const request of runtime.interactions(query).filter((r) => r.state === 'pending')) {
      const whitelisted =
        request.kind === 'command' &&
        request.canAccept &&
        allowedCommands.has(request.command ?? '') &&
        hash(readFileSync(helper)) === helperHash;
      const decision = scenario === 'accept' && whitelisted ? 'accept' : 'decline';
      runtime.reply({ ...query, requestId: request.requestId, decision });
      decisions.push({
        kind: request.kind,
        commandHash: hash(request.command ?? ''),
        whitelisted,
        decision,
      });
      if (!whitelisted)
        writeFileSync(
          join(folder, 'unrecognized-request.json'),
          JSON.stringify(
            { kind: request.kind, command: request.command, canAccept: request.canAccept },
            null,
            2,
          ),
        ); // Local controlled fixture only, never archived as a raw log.
    }
    if (scenario === 'interrupt' && !interruptRequested && existsSync(pidFile)) {
      const record = JSON.parse(readFileSync(pidFile, 'utf8'));
      assert.equal(record.nonce, nonce);
      assert.ok(Number.isSafeInteger(record.pid) && record.pid > 1);
      helperPid = Number(record.pid);
      assert.equal(hash(readFileSync(helper)), helperHash);
      pidIdentityConfirmed = helperIdentity(helperPid);
      assert.equal(pidIdentityConfirmed, true);
      assert.equal(alive(helperPid), true);
      interruptRequested = true;
      await runtime.interrupt(query);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  await runtime.wait();
  const view = runtime.view(query);
  assert.equal(hash(readFileSync(helper)), helperHash);
  if (scenario === 'interrupt') {
    assert.equal(interruptRequested, true);
    assert.equal(view.status, 'cancelled');
    assert.equal(view.taskStatus, 'cancelled');
    const stopDeadline = Date.now() + 3000;
    while (helperPid && alive(helperPid) && Date.now() < stopDeadline)
      await new Promise((done) => setTimeout(done, 50));
    assert.equal(alive(helperPid!), false);
    assert.equal(existsSync(effect), false);
  } else {
    assert.equal(view.status, 'completed');
    assert.equal(view.taskStatus, 'needs_review');
    assert.ok(decisions.length > 0);
    assert.ok(decisions.every((d) => d.whitelisted));
    if (scenario === 'deny') {
      assert.ok(decisions.every((d) => d.decision === 'decline'));
      assert.equal(existsSync(effect), false);
    } else {
      assert.equal(decisions.filter((d) => d.decision === 'accept').length, 1);
      assert.equal(readFileSync(effect, 'utf8'), nonce);
    }
  }
  evidence = {
    status: 'passed',
    observedAt: new Date().toISOString(),
    kind: 'real_model_native_' + scenario,
    scenario,
    platform: binary.platform,
    cliVersion: binary.lock.cliVersion,
    inferenceRequested: true,
    runId: view.runId,
    threadId: view.threadId,
    turnId: view.turnId,
    runStatus: view.status,
    taskStatus: view.taskStatus,
    verifiedMethods:
      scenario === 'interrupt' ? ['turn/interrupt'] : ['item/commandExecution/requestApproval'],
    decisions,
    expectedEffectPresent: existsSync(effect),
    helperHashUnchanged: true,
    interruptRequested,
    pidIdentityConfirmed,
    helperExited: helperPid ? !alive(helperPid) : null,
    diagnostics: runtime.diagnostics,
  };
} catch (error) {
  evidence = {
    status: 'blocked',
    observedAt: new Date().toISOString(),
    kind: 'real_model_native_' + scenario,
    scenario,
    platform: binary.platform,
    cliVersion: binary.lock.cliVersion,
    inferenceRequested: runtime.diagnostics.clientTurnStarts > 0,
    code:
      error instanceof LedgerError || error instanceof RpcFailure
        ? error.code
        : 'PROBE_ASSERTION_FAILED',
    decisions,
    interruptRequested,
    pidIdentityConfirmed,
    helperAlive: helperPid ? alive(helperPid) : null,
    effectPresent: existsSync(effect),
    diagnostics: runtime.diagnostics,
  };
  process.exitCode = 1;
} finally {
  await runtime.close();
  if (helperPid && alive(helperPid) && helperIdentity(helperPid)) {
    process.kill(helperPid, 'SIGTERM');
  }
  store.close();
}
const file = join(root, `docs/progress/evidence/M1.4a-native-${scenario}.json`);
writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(
  file.replace(
    '.json',
    `-${String(evidence.observedAt).replaceAll(':', '-').replaceAll('.', '-')}.json`,
  ),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
