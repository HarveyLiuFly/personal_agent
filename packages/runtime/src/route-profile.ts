import type { ExecutionLedger, RunToken } from '../../store/src/ledger.ts';
import type { ExecutionRoleProfile } from './execution.ts';
import { routeOutputSchema } from './routing.ts';

/** Fixed Host profile; sourced user text never becomes developer instructions or a tool grant. */
export function routeRoleProfile(
  store: ExecutionLedger,
  input: { role: 'dot-router' | 'dot-chat'; token: RunToken; planId: string },
): ExecutionRoleProfile {
  const run = store.runForHost(input.token.runId),
    messageId = store.routeView(run.workspaceId, input.planId).messageId;
  store.prepareRoleTask(input.token, input.role);
  store.linkContextMessage(input.token.runId, messageId);
  const bundle = store.contextForRun(input.token.runId, {
    role: input.role === 'dot-chat' ? 'dot-chat' : 'dot-orchestrator',
    mode: 'read-only',
    sourceRefs: [
      'task:' + run.taskId,
      'message:' + messageId,
      'route:' + input.planId,
      ...(input.role === 'dot-chat' ? store.automaticMemoryRefs(run.taskId, 'personal') : []),
    ],
    maximumInputUnits: 16000,
    framingReserveUnits: 2048,
    capabilities: { model_inference: true, workspace_read: false, workspace_write: false },
  });
  return {
    role: input.role,
    developerInstructions: bundle.developerInstructions,
    userContext: bundle.userContext,
    contextRefs: bundle.selectedSources.map(({ ref, revision }) => ({ ref, revision })),
    contextHash: bundle.manifest.contentHash,
    ephemeral: true,
    tools: 'none',
    ...(input.role === 'dot-router' ? { outputSchema: routeOutputSchema } : {}),
  };
}
