import { LedgerError } from '../../store/src/ledger.ts';
import type { ExecutionLedger } from '../../store/src/ledger.ts';
import type { MemorySensitivity } from '../../store/src/memory.ts';
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
export function rememberUserMessage(store: ExecutionLedger, input: unknown) {
  if (
    !object(input) ||
    !['messageId', 'factKey', 'factText', 'quote', 'trust'].every((k) => Object.hasOwn(input, k)) ||
    Object.keys(input).some(
      (k) =>
        ![
          'messageId',
          'factKey',
          'factText',
          'quote',
          'trust',
          'sensitivity',
          'supersedesClaimId',
          'expectedVersion',
        ].includes(k),
    ) ||
    !identifier(input.messageId) ||
    typeof input.factKey !== 'string' ||
    typeof input.factText !== 'string' ||
    typeof input.quote !== 'string' ||
    !['explicit_user', 'agent_inference'].includes(String(input.trust)) ||
    (input.sensitivity !== undefined &&
      !['public', 'private', 'sensitive'].includes(String(input.sensitivity)))
  )
    throw new LedgerError('INVALID_MEMORY_COMMAND');
  const revision = Object.hasOwn(input, 'supersedesClaimId'),
    version = Object.hasOwn(input, 'expectedVersion');
  if (
    revision !== version ||
    (revision &&
      (!identifier(input.supersedesClaimId) ||
        /[\s/\\]/.test(input.supersedesClaimId) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        Number(input.expectedVersion) < 1 ||
        input.trust !== 'explicit_user'))
  )
    throw new LedgerError('INVALID_MEMORY_REVISION');
  if (revision) {
    const original = store
      .searchMemory({ query: input.factKey, includeDisputed: true, limit: 100 })
      .find((claim) => claim.claimId === input.supersedesClaimId);
    if (original?.revisionSourceRefs.includes('message:' + input.messageId))
      throw new LedgerError('MEMORY_REVISION_SOURCE_REQUIRED');
  }
  const entry = store.captureMemoryMessage(
    input.messageId,
    (input.sensitivity ?? 'private') as MemorySensitivity,
  );
  return store.commitMemory({
    entryId: entry.entryId,
    expectedPrivacyEpoch: entry.privacyEpoch,
    expectedPolicyEpoch: entry.policyEpoch,
    factKey: input.factKey,
    factText: input.factText,
    quote: input.quote,
    trust: input.trust as 'explicit_user' | 'agent_inference',
    ...(revision
      ? {
          supersedesClaimId: input.supersedesClaimId as string,
          expectedVersion: input.expectedVersion as number,
        }
      : {}),
  });
}
export function listUserMemory(store: ExecutionLedger, input: unknown) {
  if (
    !object(input) ||
    Object.keys(input).some((k) => !['query', 'domain', 'taskId'].includes(k)) ||
    typeof input.query !== 'string' ||
    !['personal', 'task', 'coding'].includes(String(input.domain)) ||
    (input.taskId !== undefined && !identifier(input.taskId))
  )
    throw new LedgerError('INVALID_MEMORY_QUERY');
  const found = store.searchMemory({
    query: input.query,
    domain: input.domain as 'personal' | 'task' | 'coding',
    includeDisputed: true,
    limit: 100,
  });
  return input.taskId
    ? found.filter((c) => c.factKey.startsWith('task:' + input.taskId + ':'))
    : found;
}
