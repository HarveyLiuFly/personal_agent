// Where smokes and probes write their per-run evidence: PERSONAL_AGENT_EVIDENCE_DIR, else .local/evidence.
// Per-run output stays local; each checkpoint commits one sanitized summary under docs/progress/evidence.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function evidenceDir(root) {
  const directory = process.env.PERSONAL_AGENT_EVIDENCE_DIR
    ? resolve(process.env.PERSONAL_AGENT_EVIDENCE_DIR)
    : join(root, '.local/evidence');
  mkdirSync(join(directory, 'screenshots'), { recursive: true });
  return directory;
}
