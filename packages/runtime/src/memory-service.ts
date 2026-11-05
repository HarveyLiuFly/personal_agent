import { randomUUID } from 'node:crypto';
import type { MemoryForgetResult } from '../../store/src/memory.ts';
export interface MemoryServiceHost {
  /** Must perform the authoritative Ledger transaction before any cleanup side effect. */
  forget: (input: { sourceRefs: string[]; expectedPrivacyEpoch: number }) => MemoryForgetResult;
  /** RPC interrupt acknowledgement alone is insufficient: confirm actual execution stopped. */
  revokeRuns: (runIds: string[]) => Promise<{ stoppedRunIds: string[]; unknownRunIds: string[] }>;
  /** Host validates storage roots/keys and confirms actual local removal. */
  purgeArtifacts: (keys: string[]) => Promise<{ purgedKeys: string[] }>;
  /** Host removes its owned connector/source payloads and in-memory cached copies. */
  purgeSourcePayloads: (refs: string[]) => Promise<{ purgedRefs: string[] }>;
  compact: () =>
    | { databaseCompacted: true; sqliteWalTruncated: true; externalCopies: 'not_controlled' }
    | Promise<{
        databaseCompacted: true;
        sqliteWalTruncated: true;
        externalCopies: 'not_controlled';
      }>;
  cleanupId?: (logical: MemoryForgetResult) => string;
}
export type MemoryCleanupCode =
  | 'COMPLETE'
  | 'EXECUTION_STOP_UNCONFIRMED'
  | 'ARTIFACT_PURGE_INCOMPLETE'
  | 'SOURCE_PURGE_INCOMPLETE'
  | 'DATABASE_COMPACTION_INCOMPLETE';
export interface MemoryForgetReceipt {
  cleanupId: string;
  logical: MemoryForgetResult;
  cleanup: {
    code: MemoryCleanupCode;
    executionStopped: boolean;
    artifactsPurged: boolean;
    sourcePayloadsPurged: boolean;
    databaseCompacted: boolean;
    sqliteWalTruncated: boolean;
    localPhysicalCleanupComplete: boolean;
    externalCopies: 'not_controlled';
  };
}
interface Pending {
  logical: MemoryForgetResult;
  receipt: MemoryForgetReceipt;
  busy?: Promise<MemoryForgetReceipt>;
}
const exact = (expected: string[], actual: unknown): boolean =>
  Array.isArray(actual) &&
  actual.every((v) => typeof v === 'string') &&
  actual.length === new Set(actual).size &&
  actual.length === expected.length &&
  expected.every((v) => actual.includes(v));
/** Host-only cleanup coordinator. It never promises deletion from providers, backups or OS snapshots. */
export class MemoryService {
  private host: MemoryServiceHost;
  private pending = new Map<string, Pending>();
  constructor(host: MemoryServiceHost) {
    this.host = host;
  }
  async forget(input: {
    sourceRefs: string[];
    expectedPrivacyEpoch: number;
  }): Promise<MemoryForgetReceipt> {
    // Ledger owns validation, authorization, privacy epochs and durable logical revocation.
    const logical = structuredClone(this.host.forget(input)),
      cleanupId = this.host.cleanupId?.(logical) ?? randomUUID(),
      receipt: MemoryForgetReceipt = {
        cleanupId,
        logical: structuredClone(logical),
        cleanup: {
          code: 'EXECUTION_STOP_UNCONFIRMED',
          executionStopped: false,
          artifactsPurged: false,
          sourcePayloadsPurged: false,
          databaseCompacted: false,
          sqliteWalTruncated: false,
          localPhysicalCleanupComplete: false,
          externalCopies: 'not_controlled',
        },
      };
    this.pending.set(cleanupId, { logical, receipt });
    return this.retryCleanup(cleanupId);
  }
  /** Host rehydrates a committed cleanup intent, never a Renderer-provided source list. */
  restoreCleanup(cleanupId: string, logical: MemoryForgetResult): void {
    if (this.pending.has(cleanupId)) return;
    const receipt: MemoryForgetReceipt = {
      cleanupId,
      logical: structuredClone(logical),
      cleanup: {
        code: 'EXECUTION_STOP_UNCONFIRMED',
        executionStopped: false,
        artifactsPurged: false,
        sourcePayloadsPurged: false,
        databaseCompacted: false,
        sqliteWalTruncated: false,
        localPhysicalCleanupComplete: false,
        externalCopies: 'not_controlled',
      },
    };
    this.pending.set(cleanupId, { logical: structuredClone(logical), receipt });
  }
  /** Retry does not increment epochs or repeat logical forget. Tickets are Host-local, not Renderer DTOs. */
  async retryCleanup(cleanupId: string): Promise<MemoryForgetReceipt> {
    const pending = this.pending.get(cleanupId);
    if (!pending) throw Error('MEMORY_CLEANUP_NOT_FOUND');
    if (pending.busy) return structuredClone(await pending.busy);
    pending.busy = this.clean(pending);
    try {
      return structuredClone(await pending.busy);
    } finally {
      delete pending.busy;
    }
  }
  private async clean(pending: Pending): Promise<MemoryForgetReceipt> {
    const state = pending.receipt.cleanup,
      logical = pending.logical;
    if (state.localPhysicalCleanupComplete) return pending.receipt;
    if (!state.executionStopped) {
      try {
        const result = await this.host.revokeRuns([...new Set(logical.blockedRunIds)]);
        if (
          !result ||
          !exact([...new Set(logical.blockedRunIds)], result.stoppedRunIds) ||
          !Array.isArray(result.unknownRunIds) ||
          result.unknownRunIds.length
        )
          throw Error();
        state.executionStopped = true;
      } catch {
        state.code = 'EXECUTION_STOP_UNCONFIRMED';
        return pending.receipt;
      }
    }
    if (!state.artifactsPurged) {
      try {
        const keys = [...new Set(logical.artifactKeys)],
          result = await this.host.purgeArtifacts(keys);
        if (!result || !exact(keys, result.purgedKeys)) throw Error();
        state.artifactsPurged = true;
      } catch {
        state.code = 'ARTIFACT_PURGE_INCOMPLETE';
        return pending.receipt;
      }
    }
    if (!state.sourcePayloadsPurged) {
      try {
        const refs = [...new Set(logical.affectedRefs)],
          result = await this.host.purgeSourcePayloads(refs);
        if (!result || !exact(refs, result.purgedRefs)) throw Error();
        state.sourcePayloadsPurged = true;
      } catch {
        state.code = 'SOURCE_PURGE_INCOMPLETE';
        return pending.receipt;
      }
    }
    try {
      const result = await this.host.compact();
      if (
        result.databaseCompacted !== true ||
        result.sqliteWalTruncated !== true ||
        result.externalCopies !== 'not_controlled'
      )
        throw Error();
      state.databaseCompacted = true;
      state.sqliteWalTruncated = true;
      state.localPhysicalCleanupComplete = true;
      state.code = 'COMPLETE';
    } catch {
      state.code = 'DATABASE_COMPACTION_INCOMPLETE';
    }
    return pending.receipt;
  }
}
