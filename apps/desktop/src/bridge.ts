import type { MainChatInput, MainChatView } from '../../../packages/contracts/src/chat.ts';
import type {
  ConversationPage,
  ConversationQuery,
  ConversationSummary,
  ConversationTurns,
  ConversationTurnsQuery,
  ConversationUpdate,
} from '../../../packages/contracts/src/conversations.ts';
import type {
  ChatRouteView,
  ProposeMainChat,
  CommitChatRoute,
} from '../../../packages/contracts/src/routing.ts';
import type {
  GoalCommand,
  GoalCommandResult,
  GoalView,
  GoalNotificationView,
  GoalSourceEventView,
} from '../../../packages/contracts/src/goals.ts';
import type {
  MemoryClaimView,
  MemorySensitivity,
  MemoryTrust,
} from '../../../packages/store/src/memory.ts';
import type { MemoryForgetReceipt } from '../../../packages/runtime/src/memory-service.ts';
import type {
  OpenTerminal,
  TerminalView,
  TerminalInputReceipt,
  WriteTerminal,
} from '../../../packages/contracts/src/terminal.ts';
import type {
  WorktreeCommand,
  WorktreePage,
  WorktreeInspection,
} from '../../../packages/contracts/src/worktrees.ts';
import type {
  HostResult,
  ProjectView,
  ThreadSummary,
  TurnView,
  ItemView,
  Page,
  ProjectQuery,
  ThreadQuery,
  ItemQuery,
} from '../../../packages/contracts/src/views.ts';
import type {
  ContinueMessage,
  InteractionView,
  ReplyInteraction,
  VerificationView,
  RunQuery,
  RunSummary,
  RunView,
  SubmitMessage,
} from '../../../packages/contracts/src/views.ts';
import type {
  WorkspaceQuery,
  WorkspaceEntryQuery,
  WorkspaceDiffQuery,
  WorkspaceOverview,
  WorkspaceDirectory,
  WorkspacePreview,
  WorkspaceDiff,
} from '../../../packages/contracts/src/workspace.ts';
import type {
  TaskSummary,
  TaskCommand,
  OperationReceipt,
  StartTask,
  ActivityPage,
  TaskPlanCommand,
  TaskPlanView,
} from '../../../packages/contracts/src/tasks.ts';
import type { ResourceBudget } from '../../../packages/contracts/src/budget.ts';
import type {
  ScheduleCommand,
  ScheduleView,
  OccurrenceView,
} from '../../../packages/contracts/src/schedules.ts';
import type {
  BackupCommand,
  BackupCommandResult,
  BackupPage,
} from '../../../packages/contracts/src/backups.ts';
import type { ProjectSkillsView } from '../../../packages/contracts/src/skills.ts';
export interface ConnectionInfo {
  status: 'connected' | 'error';
  models?: number;
  defaultModel?: string;
  errorCode?: string;
  /** While the Host builds the private Codex state index (first start of a state directory). */
  index?: { state: 'indexing' | 'waiting'; threads: number };
}
export interface SmokeInfo {
  status: 'passed' | 'error';
  finalText?: string;
  threadId?: string;
  turnId?: string;
  errorCode?: string;
}
/** Change notice pushed by the Host. It carries no data; the Renderer re-reads what it shows. */
export interface HostEvent {
  seq: number;
  /** `history`: a project's cached Codex history page was refreshed in the background. */
  topic: 'store' | 'terminal' | 'history';
  projectId?: string;
}
export interface DesktopApi {
  getRunCheckpoint(
    input: RunQuery,
  ): Promise<HostResult<{ checkpointId: string | null; taskVersion?: number }>>;
  rolloverRun(input: {
    projectId: string;
    runId: string;
    checkpointId: string;
    submissionKey: string;
  }): Promise<HostResult<RunSummary>>;
  proposeMainChat(input: ProposeMainChat): Promise<HostResult<ChatRouteView>>;
  listChatRoutes(input: { projectId: string }): Promise<HostResult<ChatRouteView[]>>;
  commitChatRoute(input: CommitChatRoute): Promise<HostResult<ChatRouteView>>;
  correctChatRoute(input: {
    projectId: string;
    planId: string;
    taskId: string;
    messageId: string;
    focusRevision: number;
  }): Promise<HostResult<ChatRouteView>>;
  listGoals(input: { projectId: string }): Promise<HostResult<GoalView[]>>;
  applyGoalCommand(input: GoalCommand): Promise<HostResult<GoalCommandResult>>;
  listGoalNotifications(input: { goalId: string }): Promise<HostResult<GoalNotificationView[]>>;
  listGoalSources(): Promise<
    HostResult<
      Array<{ sourceId: string; bindingRef: string; enabled: boolean; eventTypes: string[] }>
    >
  >;
  listGoalSourceEvents(input: { sourceId: string }): Promise<HostResult<GoalSourceEventView[]>>;
  memoryState(): Promise<
    HostResult<{ privacyEpoch: number; policyEpoch: number; pendingCleanupIds?: string[] }>
  >;
  listMemory(input: {
    query: string;
    domain: 'personal' | 'task' | 'coding';
    taskId?: string;
  }): Promise<HostResult<MemoryClaimView[]>>;
  rememberMessage(input: {
    messageId: string;
    sensitivity?: MemorySensitivity;
    factKey: string;
    factText: string;
    quote: string;
    trust: MemoryTrust;
    supersedesClaimId?: string;
    expectedVersion?: number;
  }): Promise<HostResult<MemoryClaimView>>;
  forgetMemory(input: {
    sourceRefs: string[];
    expectedPrivacyEpoch: number;
  }): Promise<HostResult<MemoryForgetReceipt>>;
  retryMemoryCleanup(input: { cleanupId: string }): Promise<HostResult<MemoryForgetReceipt>>;
  readMainChat(input: { projectId: string }): Promise<HostResult<MainChatView>>;
  submitMainChat(input: MainChatInput): Promise<HostResult<MainChatView>>;
  listProjectSkills(query: { projectId: string }): Promise<HostResult<ProjectSkillsView>>;
  listBackups(): Promise<HostResult<BackupPage>>;
  applyBackupCommand(input: BackupCommand): Promise<HostResult<BackupCommandResult>>;
  readonly security: { readonly sandboxed: boolean; readonly isolated: boolean };
  inspect(): Promise<ConnectionInfo>;
  /** Subscribes to Host change notices; returns the unsubscribe function. */
  onEvent(listener: (event: HostEvent) => void): () => void;
  chooseProject(): Promise<HostResult<ProjectView | null>>;
  listThreads(query: ProjectQuery): Promise<HostResult<Page<ThreadSummary>>>;
  listTurns(query: ThreadQuery): Promise<HostResult<Page<TurnView>>>;
  listItems(query: ItemQuery): Promise<HostResult<Page<ItemView>>>;
  workspaceState(): Promise<
    HostResult<{
      projects: ProjectView[];
      canSubmit: boolean;
      canCode: boolean;
      canBrowseWorkspace: boolean;
      canBrowseSkills?: boolean;
      canManageTasks: boolean;
      backgroundEnabled: boolean;
      canUseTerminal: boolean;
      mode: 'readOnly' | 'workspaceWrite';
    }>
  >;
  /** Conversations of a project (pinned first, then most recently active), one page at a time. */
  listConversations(query: ConversationQuery): Promise<HostResult<ConversationPage>>;
  getConversation(query: {
    projectId: string;
    conversationId: string;
  }): Promise<HostResult<ConversationSummary>>;
  /** Turns of one conversation, newest first. */
  listConversationTurns(query: ConversationTurnsQuery): Promise<HostResult<ConversationTurns>>;
  updateConversation(input: ConversationUpdate): Promise<HostResult<ConversationSummary>>;
  listTasks(query: { projectId: string }): Promise<HostResult<TaskSummary[]>>;
  applyTaskCommand(command: TaskCommand): Promise<HostResult<OperationReceipt>>;
  startTask(input: StartTask): Promise<HostResult<RunSummary>>;
  listTaskActivity(query: {
    projectId: string;
    cursor?: number;
  }): Promise<HostResult<ActivityPage>>;
  resourceBudget(): Promise<HostResult<ResourceBudget>>;
  applyScheduleCommand(input: ScheduleCommand): Promise<HostResult<ScheduleView>>;
  listSchedules(query: { projectId: string }): Promise<HostResult<ScheduleView[]>>;
  listScheduleOccurrences(query: {
    projectId: string;
    scheduleId: string;
  }): Promise<HostResult<OccurrenceView[]>>;
  applyTaskPlan(input: TaskPlanCommand): Promise<HostResult<TaskPlanView>>;
  listTaskPlans(query: { projectId: string }): Promise<HostResult<TaskPlanView[]>>;
  cancelTaskPlan(query: {
    projectId: string;
    planId: string;
    commandKey: string;
  }): Promise<HostResult<TaskPlanView>>;
  openTerminal(query: OpenTerminal): Promise<HostResult<TerminalView>>;
  readTerminal(query: {
    projectId: string;
    afterSequence: number;
  }): Promise<HostResult<TerminalView>>;
  writeTerminal(query: WriteTerminal): Promise<HostResult<TerminalInputReceipt>>;
  resizeTerminal(query: {
    projectId: string;
    sessionId: string;
    cols: number;
    rows: number;
  }): Promise<HostResult<TerminalView>>;
  closeTerminal(query: {
    projectId: string;
    sessionId: string;
    commandKey: string;
  }): Promise<HostResult<TerminalView>>;
  reconcileTerminal(query: {
    projectId: string;
    sessionId: string;
  }): Promise<HostResult<TerminalView>>;
  listWorktrees(query: { projectId: string }): Promise<HostResult<WorktreePage>>;
  applyWorktreeCommand(input: WorktreeCommand): Promise<HostResult<WorktreePage>>;
  inspectWorktree(query: {
    projectId: string;
    workspaceId: string;
  }): Promise<HostResult<WorktreeInspection>>;
  useWorktree(query: { projectId: string; workspaceId: string }): Promise<HostResult<ProjectView>>;
  getWorkspace(query: WorkspaceQuery): Promise<HostResult<WorkspaceOverview>>;
  listWorkspaceDirectory(query: WorkspaceEntryQuery): Promise<HostResult<WorkspaceDirectory>>;
  readWorkspaceFile(query: WorkspaceEntryQuery): Promise<HostResult<WorkspacePreview>>;
  getWorkspaceDiff(query: WorkspaceDiffQuery): Promise<HostResult<WorkspaceDiff>>;
  submitMessage(input: SubmitMessage): Promise<HostResult<RunSummary>>;
  continueRun(input: ContinueMessage): Promise<HostResult<RunSummary>>;
  listRuns(query: { projectId: string }): Promise<HostResult<RunSummary[]>>;
  getRun(query: RunQuery): Promise<HostResult<RunView>>;
  reconcileRun(query: RunQuery): Promise<HostResult<RunView>>;
  listInteractions(query: RunQuery): Promise<HostResult<InteractionView[]>>;
  replyInteraction(input: ReplyInteraction): Promise<HostResult<{ state: 'submitted' }>>;
  getVerification(query: RunQuery): Promise<HostResult<VerificationView>>;
  verifyRun(query: RunQuery): Promise<HostResult<VerificationView>>;
  interruptRun(query: RunQuery): Promise<HostResult<{ state: 'requested' }>>;
}
declare global {
  interface Window {
    personalAgent: DesktopApi;
  }
}
