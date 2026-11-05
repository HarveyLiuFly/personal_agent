import type { TaskSummary } from './tasks.ts';
import type { RunView } from './views.ts';

/** How much a conversation may do: read only, write the workspace asking when needed, or all. */
export type PermissionMode = 'readOnly' | 'auto' | 'fullAccess';

/** One conversation: a task bound to one Codex thread. Each of its Runs is one turn. */
export interface ConversationSummary {
  projectId: string;
  conversationId: string;
  title: string;
  status: TaskSummary['status'];
  version: number;
  /** Execution mode of the next turn (until CORE.3 derives it from `permissionMode`). */
  mode: 'readOnly' | 'workspaceWrite';
  permissionMode: PermissionMode;
  /** Chosen model and reasoning effort; null uses the defaults. */
  model: string | null;
  effort: string | null;
  pinned: boolean;
  archived: boolean;
  /** The last turn ended after the user last opened this conversation. */
  unread: boolean;
  /** Waiting for the user: an approval, an answer, or a check of an unknown send. */
  attention: 'approval' | 'input' | 'unknown' | null;
  activeRunId: string | null;
  latestRunId: string | null;
  threadId: string | null;
  turns: number;
  blocked: boolean;
  /** The conversation this one was started from ("从这里新开"), if any. */
  forkedFrom: string | null;
  updatedAt: number;
}
export interface ConversationArchive {
  projectId: string;
  conversationId: string;
  archived: boolean;
}
export interface ConversationQuery {
  projectId: string;
  /** Opaque handle from the previous page. */
  cursor?: string;
  /** List archived conversations instead of current ones. */
  archived?: boolean;
  /** Case-insensitive title filter. */
  query?: string;
}
export interface ConversationPage {
  /** Pinned conversations, on the first page only. */
  pinned: ConversationSummary[];
  /** Other conversations, most recently active first. */
  items: ConversationSummary[];
  nextCursor: string | null;
}
export interface ConversationTurnsQuery {
  projectId: string;
  conversationId: string;
  cursor?: string;
}
/** Turns of one conversation, newest first; `nextCursor` reads older ones. */
export interface ConversationTurns {
  items: RunView[];
  nextCursor: string | null;
}
export interface ConversationUpdate {
  projectId: string;
  conversationId: string;
  pinned?: boolean;
  /** Marks the conversation as read now. */
  read?: true;
}
