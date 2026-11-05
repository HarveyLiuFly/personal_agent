import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import { ForegroundExecution } from '../packages/runtime/src/execution.ts';
import { routeRoleProfile } from '../packages/runtime/src/route-profile.ts';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
const root = resolve('.'),
  marker = join(root, '.local/M3-native-chat-state.json');
mkdirSync(join(root, '.local'), { recursive: true });
if (existsSync(marker)) throw Error('NATIVE_PROBE_ALREADY_RECORDED_NO_AUTOMATIC_RESEND');
const state = realpathSync(mkdtempSync(join(root, '.local/m3-native-chat-'))),
  cwd = join(state, 'workspace');
mkdirSync(cwd);
writeFileSync(marker, JSON.stringify({ state }) + '\n', { flag: 'wx', mode: 0o600 });
const store = new ExecutionLedger(
  join(state, 'ledger.db'),
  readFileSync(join(root, 'docs/design/contracts/schema.sql'), 'utf8'),
);
store.startOwner('m3-native-chat', true);
const project = store.registerWorkspace(cwd, cwd),
  text =
    '请用一句自然的中文解释为什么 2+2=4。只回答这个问题，不要返回 JSON、路由提案或创建任务，不要调用工具。',
  origin = store.prepareMainRoute({
    projectId: project.id,
    messageId: 'public-chat-question',
    text,
    focusRevision: 0,
  });
const execution = new ForegroundExecution(store, {
  executable: verifiedCodex(root).executable,
  stateDirectory: join(state, 'codex-state'),
  timeoutMs: 120000,
});
let evidence: Record<string, unknown> = {
  status: 'blocked',
  kind: 'native_dot_chat_role_natural_answer',
  inferenceRequested: false,
};
try {
  evidence.inferenceRequested = true;
  const submitted = execution.submitRole(
    { projectId: project.id, text, submissionKey: 'public-dot-chat-answer' },
    (token) => routeRoleProfile(store, { role: 'dot-chat', token, planId: origin.route.id }),
    'fixed-native-chat-profile-v1',
  );
  await execution.wait();
  const run = store.runs(project.id, { runId: submitted.runId })[0]!,
    answer =
      run.snapshot?.items
        .filter(
          (i) =>
            i.turnId === run.turnId &&
            i.kind === 'message' &&
            i.role === 'assistant' &&
            i.status === 'complete',
        )
        .at(-1)?.text ?? '',
    manifest = store.contextManifestReceipt(run.runId),
    naturalAnswer =
      /4|四/.test(answer) &&
      /[\u4e00-\u9fff]/.test(answer) &&
      !answer.trim().startsWith('{') &&
      !answer.includes('CREATE_TASK');
  if (
    run.status !== 'completed' ||
    !naturalAnswer ||
    manifest?.role !== 'dot-chat' ||
    !manifest.moduleHashes['chat-role'] ||
    manifest.moduleHashes['proposal-role']
  )
    throw Error('NATIVE_CHAT_ROLE_ANSWER_MISMATCH');
  evidence = {
    status: 'passed',
    kind: 'native_dot_chat_role_natural_answer',
    provider: 'original_supported_codex_login',
    publicQuestion: 'Explain 2+2=4 in one Chinese sentence.',
    answer: answer.slice(0, 500),
    runStatus: run.status,
    inferenceRequested: true,
    actualModelRequests: 1,
    model: execution.diagnostics.selectedModel,
    nativePolicyVerified: execution.diagnostics.nativePolicyVerified,
    contextRole: manifest.role,
    chatModuleSelected: true,
    proposalModuleExcluded: true,
    tools: 'none',
    ephemeral: true,
    clientThreadStarts: execution.diagnostics.clientThreadStarts,
    clientTurnStarts: execution.diagnostics.clientTurnStarts,
    businessTasksCreated: store.tasks(project.id).length,
    reportedTokens: store.resourceBudget().reportedTokens,
    automaticResends: 0,
    routeProposal:
      'Host-recorded public source only; no Router inference or action commit in this role-specific acceptance.',
  };
} catch (error) {
  evidence.code = error instanceof Error ? error.message : 'HOST_ERROR';
  evidence.diagnosticCode = execution.diagnostics.failureCode;
  evidence.clientTurnStarts = execution.diagnostics.clientTurnStarts;
} finally {
  await execution.close();
  store.close();
}
evidence.observedAt = new Date().toISOString();
writeFileSync(
  join(root, 'docs/progress/evidence/M3.1b-native-chat.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
if (evidence.status !== 'passed') process.exitCode = 1;
