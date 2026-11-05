/** Renderer projections only. These are neither raw RPC envelopes nor domain execution receipts. */
export interface ItemView {
  id: string;
  turnId: string;
  kind: 'message' | 'command' | 'files' | 'plan' | 'tool' | 'agent' | 'reasoning' | 'unknown';
  role: 'user' | 'assistant' | 'system';
  label: string;
  text: string;
  status: 'streaming' | 'complete' | 'unknown';
  /** Native tool result, separate from receipt of the final record. Absent in older snapshots. */
  toolStatus?: 'inProgress' | 'completed' | 'failed' | 'declined' | 'interrupted' | 'unknown';
  exitCode?: number;
  durationMs?: number;
  truncated: boolean;
}
export interface TurnView {
  id: string;
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted' | 'unknown';
}
export interface ThreadView {
  threadId: string;
  epoch: number;
  sequence: number;
  needsSnapshot: boolean;
  truncated: boolean;
  unsupportedItems: boolean;
  turns: TurnView[];
  items: ItemView[];
}
export interface ProjectView {
  id: string;
  name: string;
  directory: string;
}
export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
  status: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  mode: 'paginated' | 'legacy';
  truncated: boolean;
}
export type HostResult<T> = { ok: true; value: T } | { ok: false; errorCode: string };
export interface ProjectQuery {
  projectId: string;
  cursor?: string;
}
export interface ThreadQuery extends ProjectQuery {
  threadId: string;
}
export interface ItemQuery extends ThreadQuery {
  turnId: string;
}
export interface RunQuery {
  projectId: string;
  runId: string;
}
export interface CodeTaskSpec {
  profile: 'node-test';
  target: string;
  allowedPaths: string[];
}
export interface SubmitMessage {
  projectId: string;
  text: string;
  submissionKey: string;
  code?: CodeTaskSpec;
}
export interface ContinueMessage extends RunQuery {
  text: string;
  submissionKey: string;
}
export interface RunSummary {
  runId: string;
  taskId: string;
  title: string;
  status: string;
  taskStatus: string;
  threadId: string | null;
  turnId: string | null;
  blocked: boolean;
  mode: 'readOnly' | 'workspaceWrite';
  errorCode?: string;
}
export interface RunView extends RunSummary {
  snapshot: ThreadView | null;
}
export interface InputQuestion {
  id: string;
  header: string;
  question: string;
  options: string[];
}
export interface InteractionView {
  requestId: string;
  kind: 'command' | 'files' | 'input';
  state: string;
  title: string;
  detail: string;
  canAccept: boolean;
  questions: InputQuestion[];
  command?: string;
}
export interface ReplyInteraction extends RunQuery {
  requestId: string;
  decision: 'accept' | 'decline';
  answers?: Record<string, string>;
}
export interface VerificationView {
  target: string | null;
  allowedPaths: string[];
  requiredCases: number;
  baselineCommit: string | null;
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
  receipt: {
    verificationId: string;
    status: string;
    code: string;
    discovered: number;
    executed: number;
    skipped: number;
    exitCode: number | null;
    observedAt: string;
  } | null;
}
