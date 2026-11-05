import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionLedger } from '../packages/store/src/ledger.ts';
import type { RunToken } from '../packages/store/src/ledger.ts';
import { ForegroundExecution } from '../packages/runtime/src/execution.ts';
import type { ExecutionRoleProfile } from '../packages/runtime/src/execution.ts';
import { MemoryService } from '../packages/runtime/src/memory-service.ts';
import { LocalPrivacyCleanup } from '../packages/runtime/src/local-cleanup.ts';
import { BackupService } from '../packages/backup/src/service.ts';
import { verifiedCodex } from '../packages/codex-adapter/src/binary.ts';
import { evidenceDir } from './lib/evidence.mjs';

const root = resolve('.'),
  evidencePath = join(evidenceDir(root), 'M3.4-native-privacy.json'),
  firstMarkerPath = join(root, '.local/M3-native-privacy-state.json'),
  secondAttempt = process.argv.slice(2).join(' ') === '--attempt2-after-no-send';
if (process.argv.length > 2 && !secondAttempt) throw Error('INVALID_NATIVE_PROBE_ARGUMENTS');
mkdirSync(join(root, '.local'), { recursive: true });
// An explicitly invoked replacement attempt is allowed only after proving that
// the archived first attempt never prepared any transport Intent. Its Run and
// marker are retained; an Unknown can never enter this branch.
if (secondAttempt) {
  const previous = JSON.parse(readFileSync(firstMarkerPath, 'utf8'));
  if (
    previous.stage !== 'blocked' ||
    previous.code !== 'BACKUP_ARTIFACT_UNSUPPORTED' ||
    previous.secondRequestMayHaveBeenSent !== false ||
    typeof previous.state !== 'string'
  )
    throw Error('NO_SEND_RECOVERY_NOT_PROVEN');
  const check = new DatabaseSync(join(previous.state, 'execution/ledger.db'), { readOnly: true });
  try {
    if (
      Number(check.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n) !== 0 ||
      Number(
        check.prepare("SELECT count(*) AS n FROM task_runs WHERE status='failed'").get()!.n,
      ) !== 1 ||
      Number(check.prepare('SELECT count(*) AS n FROM task_runs').get()!.n) !== 1
    )
      throw Error('NO_SEND_RECOVERY_NOT_PROVEN');
  } finally {
    check.close();
  }
  const archive = join(evidenceDir(root), 'M3.4-native-privacy-attempt1.json');
  if (!existsSync(archive)) {
    const failedEvidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    failedEvidence.readOnlyFailureAudit = {
      runStatus: 'failed',
      executionIntents: 0,
      threadStarts: 0,
      turnStarts: 0,
      modelRequests: 0,
      originalRunUnchanged: true,
    };
    writeFileSync(archive, JSON.stringify(failedEvidence, null, 2) + '\n', { flag: 'wx' });
  }
}
const markerPath = secondAttempt
  ? join(root, '.local/M3-native-privacy-attempt2-state.json')
  : firstMarkerPath;
if (existsSync(markerPath)) throw Error('NATIVE_PROBE_ALREADY_RECORDED_NO_AUTOMATIC_RESEND');
const state = realpathSync(mkdtempSync(join(root, '.local/m3-native-privacy-'))),
  cwd = join(state, 'workspace'),
  database = join(state, 'execution/ledger.db'),
  verification = join(state, 'verification'),
  canary = 'PUBLIC_SYNTHETIC_ERASURE_' + randomUUID();
mkdirSync(cwd);
mkdirSync(join(verification, 'artifacts'), { recursive: true, mode: 0o700 });
const marker: Record<string, unknown> = {
  state,
  stage: 'prepared',
  firstRequestMayHaveBeenSent: false,
  secondRequestMayHaveBeenSent: false,
};
writeFileSync(markerPath, JSON.stringify(marker) + '\n', { flag: 'wx', mode: 0o600 });
const stamp = (stage: string, extra: Record<string, unknown> = {}) => {
  Object.assign(marker, { stage, ...extra });
  writeFileSync(markerPath, JSON.stringify(marker) + '\n', { mode: 0o600 });
};
const store = new ExecutionLedger(
  database,
  readFileSync(join(root, 'docs/design/contracts/schema.sql'), 'utf8'),
);
store.startOwner('m3-native-privacy-owner', true);
const project = store.registerWorkspace(cwd),
  cli = verifiedCodex(root).executable,
  execution = new ForegroundExecution(store, {
    executable: cli,
    stateDirectory: join(state, 'codex-state'),
    timeoutMs: 180000,
  }),
  cleanup = new LocalPrivacyCleanup({ storageRoot: state, database, verification });
let phase = 'persist-user-memory',
  evidence: Record<string, unknown> = {
    status: 'blocked',
    kind: 'native_privacy_revoke_then_fresh_ephemeral_role',
    syntheticData: 'public_generated_canary_and_seeded_artifact',
    provider: 'original_supported_codex_login',
    firstRequestMayHaveBeenSent: false,
    secondRequestMayHaveBeenSent: false,
    providerRetention: 'not_controlled',
    automaticResends: 0,
  };
const safeCode = (error: unknown): string => {
  const value =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : '';
  return /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : 'HOST_ERROR';
};
const scan = (directory: string): { files: number; matches: number } => {
  let files = 0,
    matches = 0;
  const walk = (path: string, depth: number) => {
    if (depth > 16) throw Error('BYTE_SCAN_DEPTH_EXCEEDED');
    const info = lstatSync(path);
    if (info.isSymbolicLink() || realpathSync(path) !== path)
      throw Error('BYTE_SCAN_SCOPE_CHANGED');
    if (info.isDirectory()) {
      const names = readdirSync(path);
      if (names.length > 20000) throw Error('BYTE_SCAN_FILE_LIMIT');
      for (const name of names) walk(join(path, name), depth + 1);
    } else if (info.isFile()) {
      if (info.size > 128 * 1024 * 1024) throw Error('BYTE_SCAN_FILE_TOO_LARGE');
      files++;
      if (readFileSync(path).includes(Buffer.from(canary))) matches++;
    } else throw Error('BYTE_SCAN_UNSUPPORTED_FILE');
  };
  walk(directory, 0);
  return { files, matches };
};
const memory = new MemoryService({
  forget: (input) => store.forgetMemory(input),
  revokeRuns: async (ids) => {
    const result = await execution.revokeForPrivacy(ids);
    return { stoppedRunIds: result.closedRunIds, unknownRunIds: result.unresolvedRunIds };
  },
  purgeArtifacts: async (keys) => {
    const result = cleanup.purgeArtifacts(keys);
    store.confirmArtifactPurge(result.purgedKeys);
    return result;
  },
  purgeSourcePayloads: async (refs) => {
    cleanup.purgeSnapshots();
    return { purgedRefs: refs };
  },
  compact: () => store.compactMemory(),
  cleanupId: (logical) => 'privacy:' + logical.privacyEpoch,
});
try {
  const messageId = 'public-native-memory-origin';
  store.prepareMainRoute({
    projectId: project.id,
    messageId,
    text: '/remember personal:temporaryCanary = ' + canary,
    focusRevision: 0,
  });
  const entry = store.captureMemoryMessage(messageId),
    claim = store.commitMemory({
      entryId: entry.entryId,
      expectedPrivacyEpoch: entry.privacyEpoch,
      expectedPolicyEpoch: entry.policyEpoch,
      factKey: 'personal:temporaryCanary',
      factText: canary,
      quote: canary,
      trust: 'explicit_user',
    });
  let firstManifestBound = false,
    secondManifestBound = false;
  const profile = (token: RunToken, remember: boolean): ExecutionRoleProfile => {
    store.prepareRoleTask(token, 'dot-chat');
    const run = store.runForHost(token.runId),
      sourceRefs = ['task:' + run.taskId];
    if (remember) {
      store.linkContextMessage(token.runId, messageId);
      sourceRefs.push('message:' + messageId, 'claim:' + claim.claimId);
    }
    const bundle = store.contextForRun(token.runId, {
      role: 'dot-orchestrator',
      mode: 'read-only',
      sourceRefs,
      maximumInputUnits: 16000,
      framingReserveUnits: 2048,
      capabilities: { model_inference: true, workspace_read: false, workspace_write: false },
    });
    if (remember) {
      if (
        !bundle.userContext.includes(canary) ||
        !bundle.selectedSources.some((s) => s.ref === 'claim:' + claim.claimId)
      )
        throw Error('CANARY_CONTEXT_NOT_BOUND');
      firstManifestBound = true;
    } else {
      if (
        bundle.userContext.includes(canary) ||
        bundle.selectedSources.some(
          (s) => s.ref.startsWith('claim:') || s.ref === 'message:' + messageId,
        )
      )
        throw Error('FORGOTTEN_CONTEXT_REINTRODUCED');
      secondManifestBound = true;
    }
    return {
      role: 'dot-chat',
      developerInstructions: bundle.developerInstructions,
      userContext: bundle.userContext,
      contextRefs: bundle.selectedSources.map(({ ref, revision }) => ({ ref, revision })),
      contextHash: bundle.manifest.contentHash,
      ephemeral: true,
      tools: 'none',
    };
  };
  const backups = new BackupService(store, {
    directory: join(state, 'backups'),
    verificationDirectory: join(verification, 'artifacts'),
  });
  backups.command({ kind: 'create', commandKey: 'public-native-before-erasure' });
  phase = 'first-native-submit';
  stamp(phase, { firstRequestMayHaveBeenSent: true });
  evidence.firstRequestMayHaveBeenSent = true;
  const first = execution.submitRole(
    {
      projectId: project.id,
      text: 'Do not disclose or quote personal memory. Produce a long harmless list of 400 numbered public astronomy facts. Do not use tools.',
      submissionKey: 'm3-privacy-first-original-key',
    },
    (token) => profile(token, true),
    'm3-native-privacy-first-profile',
  );
  stamp('first-admitted', { firstRunId: first.runId });
  // A public synthetic Artifact exercises actual owned file deletion. It is
  // deliberately not a verification receipt or a completed business task.
  const artifactId = randomUUID(),
    artifactKey = artifactId + '.json',
    artifactContent = JSON.stringify({ publicSyntheticPrivacyCanary: canary }) + '\n',
    artifactHash = createHash('sha256').update(artifactContent).digest('hex');
  writeFileSync(join(verification, 'artifacts', artifactKey), artifactContent, {
    flag: 'wx',
    mode: 0o600,
  });
  const seed = new DatabaseSync(database);
  try {
    seed
      .prepare("INSERT INTO artifacts VALUES (?,?,?,?,?,'published','private',?,?,NULL)")
      .run(
        artifactId,
        store.dotId,
        first.taskId,
        artifactHash,
        artifactKey,
        entry.privacyEpoch,
        Buffer.byteLength(artifactContent),
      );
  } finally {
    seed.close();
  }
  phase = 'wait-first-accepted';
  const deadline = Date.now() + 120000;
  let accepted = store.runForHost(first.runId);
  while (!accepted.turnId) {
    if (Date.now() > deadline) throw Error('FIRST_NATIVE_ACCEPTANCE_TIMEOUT');
    if (['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(accepted.status))
      throw Error('FIRST_NATIVE_NOT_ACTIVE_AT_FORGET');
    await new Promise((resolve) => setTimeout(resolve, 5));
    accepted = store.runForHost(first.runId);
  }
  if (
    !execution.busy ||
    accepted.status !== 'running' ||
    !execution.diagnostics.nativePolicyVerified
  )
    throw Error('FIRST_NATIVE_NOT_ACTIVE_AT_FORGET');
  const firstThread = accepted.threadId;
  if (!firstThread) throw Error('FIRST_THREAD_NOT_BOUND');
  const firstPolicyVerified = execution.diagnostics.nativePolicyVerified,
    firstModel = execution.diagnostics.selectedModel;
  stamp('first-accepted', { firstTurnAccepted: true });
  phase = 'forget-during-accepted-turn';
  const receipt = await memory.forget({
    sourceRefs: [entry.sourceRef],
    expectedPrivacyEpoch: entry.privacyEpoch,
  });
  stamp('forgotten', {
    privacyEpoch: receipt.logical.privacyEpoch,
    cleanupCode: receipt.cleanup.code,
  });
  if (
    !firstManifestBound ||
    !receipt.logical.blockedRunIds.includes(first.runId) ||
    !receipt.cleanup.localPhysicalCleanupComplete
  )
    throw Error('NATIVE_PRIVACY_CLEANUP_INCOMPLETE');
  store.completeMemoryCleanup(receipt.logical.privacyEpoch);
  store.compactMemory();
  const old = store.runForHost(first.runId),
    held = store.resourceBudget().unknownHeldTokens;
  if (old.status !== 'outcome_unknown' || !store.executorClosureRecorded(first.runId) || held <= 0)
    throw Error('OLD_NATIVE_OUTCOME_OR_COST_NOT_UNKNOWN');
  if (store.searchMemory({ query: canary }).length) throw Error('FORGOTTEN_CLAIM_STILL_VISIBLE');
  const erased = scan(state);
  if (erased.matches !== 0) throw Error('LOCAL_CANARY_BYTES_REMAIN');
  evidence = {
    ...evidence,
    firstModel,
    firstTurnAccepted: true,
    firstNativePolicyVerified: firstPolicyVerified,
    forgottenWhileRunStatus: accepted.status,
    firstRoleContextContainedClaim: firstManifestBound,
    oldRunStatus: old.status,
    oldRunExecutorClosed: true,
    oldUnknownHeldTokens: held,
    privacyEpochAdvanced: receipt.logical.privacyEpoch > entry.privacyEpoch,
    cleanup: receipt.cleanup,
    firstByteScan: { files: erased.files, canaryMatches: erased.matches },
    ownedNativeStatePurged: true,
  };
  phase = 'fresh-native-submit';
  stamp(phase, { secondRequestMayHaveBeenSent: true });
  evidence.secondRequestMayHaveBeenSent = true;
  const fresh = execution.submitRole(
    {
      projectId: project.id,
      text: 'This is a fresh memory erasure check. Reply exactly CLEAN if the current supplied context contains no personal memory value, otherwise exactly LEAK. Do not use tools, quote data or infer old conversations.',
      submissionKey: 'm3-privacy-fresh-distinct-key',
    },
    (token) => profile(token, false),
    'm3-native-privacy-fresh-profile',
  );
  stamp('fresh-admitted', { freshRunId: fresh.runId });
  await execution.wait();
  const current = store.runForHost(fresh.runId),
    view = execution.view({ projectId: project.id, runId: fresh.runId }),
    reply = view.snapshot?.items
      .filter((item) => item.role === 'assistant')
      .map((item) => item.text)
      .join('')
      .trim();
  if (
    current.status !== 'completed' ||
    reply !== 'CLEAN' ||
    !secondManifestBound ||
    !current.threadId ||
    current.threadId === firstThread ||
    !execution.diagnostics.nativePolicyVerified
  )
    throw Error('FRESH_NATIVE_ERASURE_CHECK_FAILED');
  if (store.runForHost(first.runId).status !== 'outcome_unknown')
    throw Error('OLD_NATIVE_UNKNOWN_WAS_REWRITTEN');
  const counts = new DatabaseSync(database, { readOnly: true });
  let firstTurns: number, runCount: number;
  try {
    firstTurns = Number(
      counts
        .prepare("SELECT count(*) AS n FROM execution_intents WHERE run_id=? AND kind='turn_start'")
        .get(first.runId)!.n,
    );
    runCount = Number(counts.prepare('SELECT count(*) AS n FROM task_runs').get()!.n);
  } finally {
    counts.close();
  }
  if (firstTurns !== 1 || runCount !== 2) throw Error('NATIVE_REQUEST_REPLAY_DETECTED');
  await execution.close();
  cleanup.purgeSnapshots();
  store.compactMemory();
  const finalScan = scan(state);
  if (finalScan.matches !== 0) throw Error('FINAL_LOCAL_CANARY_BYTES_REMAIN');
  evidence = {
    ...evidence,
    status: 'passed',
    phase: 'complete',
    model: execution.diagnostics.selectedModel,
    freshRunStatus: current.status,
    freshRoleContextExcludedClaims: secondManifestBound,
    freshThreadDifferent: true,
    freshReply: 'CLEAN',
    freshNativePolicyVerified: execution.diagnostics.nativePolicyVerified,
    actualModelRequests: runCount,
    oldRunTurnStarts: firstTurns,
    finalByteScan: { files: finalScan.files, canaryMatches: finalScan.matches },
    reportedTokens: store.resourceBudget().reportedTokens,
    unknownHeldTokens: store.resourceBudget().unknownHeldTokens,
    tools: 'none',
    ephemeral: true,
  };
  stamp('complete', { status: 'passed' });
} catch (error) {
  const code = safeCode(error);
  evidence = {
    ...evidence,
    status: 'blocked',
    phase,
    code,
    diagnosticCode: execution.diagnostics.failureCode || undefined,
  };
  stamp('blocked', { phase, code });
} finally {
  await execution.close();
  store.close();
}
evidence.observedAt = new Date().toISOString();
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
if (evidence.status !== 'passed') process.exitCode = 1;
