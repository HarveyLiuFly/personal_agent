import type { TaskSummary } from './tasks.ts';
export interface MainChatInput {
  projectId: string;
  messageId: string;
  text: string;
  focusRevision: number;
  taskId?: string;
  pendingInteractionId?: string;
}
export interface MainChatEntry {
  messageId: string;
  text: string;
  createdAt: number;
  kind: 'query' | 'clarify' | 'note';
  reason: string;
  task: TaskSummary | null;
  pendingInteractionId: string | null;
  truncated: boolean;
}
export interface MainChatPending {
  id: string;
  messageId: string;
  expiresAt: number;
  choices: Array<{ taskId: string; title: string; version: number }>;
}
export interface MainChatView {
  projectId: string;
  conversationId: string | null;
  focus: { task: TaskSummary; revision: number } | null;
  focusRevision: number;
  tasks: TaskSummary[];
  messages: MainChatEntry[];
  pending: MainChatPending[];
  truncated: boolean;
}
