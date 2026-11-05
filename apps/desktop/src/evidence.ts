import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Where desktop smokes and probes write their per-run evidence: PERSONAL_AGENT_EVIDENCE_DIR,
 * else .local/evidence. Per-run output stays local; checkpoints commit one sanitized summary.
 */
export function evidenceDir(root: string): string {
  const directory = process.env.PERSONAL_AGENT_EVIDENCE_DIR
    ? resolve(process.env.PERSONAL_AGENT_EVIDENCE_DIR)
    : join(root, '.local/evidence');
  mkdirSync(join(directory, 'screenshots'), { recursive: true });
  return directory;
}
