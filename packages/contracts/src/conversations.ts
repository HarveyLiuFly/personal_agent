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
/** Per-conversation choices; omitted fields keep (or default) their value. */
export interface ConversationChoices {
  permissionMode?: PermissionMode;
  /** Model ID from the catalog; null uses the catalog default. */
  model?: string | null;
  /** Reasoning effort the model supports; null uses the default (low). */
  effort?: string | null;
}
/** A model the user can pick, from the Codex catalog. */
export interface ModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  efforts: string[];
  defaultEffort: string | null;
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
export interface ConversationUpdate extends ConversationChoices {
  projectId: string;
  conversationId: string;
  pinned?: boolean;
  /** Marks the conversation as read now. */
  read?: true;
}
/** One run of the project's check command, shown as a step of a conversation. */
export interface ProjectCheckView {
  checkId: string;
  label: string;
  status: 'passed' | 'failed' | 'timeout' | 'error';
  exitCode: number | null;
  durationMs: number;
  /** The end of the command's output. */
  output: string;
  outputTruncated: boolean;
  /** The turn the check ran after. */
  afterRunId: string | null;
  automatic: boolean;
  at: number;
}
/** A project's check command setting, with the presets to choose from. */
export interface ProjectCheckSetting {
  config: { argv: string[]; label: string; autoRun: boolean } | null;
  presets: Array<{ id: string; label: string; argv: string[] }>;
}
