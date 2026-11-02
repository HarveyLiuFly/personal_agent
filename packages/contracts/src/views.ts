/** Renderer projections only. These are neither raw RPC envelopes nor domain execution receipts. */
export interface ItemView {
  id: string;
  turnId: string;
  kind: 'message' | 'command' | 'files' | 'plan' | 'tool' | 'agent' | 'reasoning' | 'unknown';
  role: 'user' | 'assistant' | 'system';
  label: string;
  text: string;
  status: 'streaming' | 'complete' | 'unknown';
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
