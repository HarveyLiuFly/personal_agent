import type { HostResult, ProjectView, ThreadSummary, TurnView, ItemView, Page, ProjectQuery, ThreadQuery, ItemQuery } from '../../../packages/contracts/src/views.ts';
import type { ContinueMessage, InteractionView, ReplyInteraction, VerificationView, RunQuery, RunSummary, RunView, SubmitMessage } from '../../../packages/contracts/src/views.ts';
import type {WorkspaceQuery,WorkspaceEntryQuery,WorkspaceDiffQuery,WorkspaceOverview,WorkspaceDirectory,WorkspacePreview,WorkspaceDiff} from '../../../packages/contracts/src/workspace.ts';
import type {TaskSummary,TaskCommand,OperationReceipt,StartTask,ActivityPage,TaskPlanCommand,TaskPlanView} from '../../../packages/contracts/src/tasks.ts';
import type {ResourceBudget} from '../../../packages/contracts/src/budget.ts';
import type {ScheduleCommand,ScheduleView,OccurrenceView} from '../../../packages/contracts/src/schedules.ts';
export interface ConnectionInfo {
  status: 'connected' | 'error';
  models?: number;
  defaultModel?: string;
  errorCode?: string;
}
export interface SmokeInfo { status: 'passed' | 'error'; finalText?: string; threadId?: string; turnId?: string; errorCode?: string }
export interface DesktopApi {
  readonly security: { readonly sandboxed: boolean; readonly isolated: boolean };
  inspect(): Promise<ConnectionInfo>;
  chooseProject(): Promise<HostResult<ProjectView | null>>;
  listThreads(query: ProjectQuery): Promise<HostResult<Page<ThreadSummary>>>;
  listTurns(query: ThreadQuery): Promise<HostResult<Page<TurnView>>>;
  listItems(query: ItemQuery): Promise<HostResult<Page<ItemView>>>;
  workspaceState(): Promise<HostResult<{ projects: ProjectView[]; canSubmit: boolean; canCode: boolean; canBrowseWorkspace:boolean;canManageTasks:boolean;backgroundEnabled:boolean; mode: 'readOnly' | 'workspaceWrite' }>>;
  listTasks(query:{projectId:string}):Promise<HostResult<TaskSummary[]>>;
  applyTaskCommand(command:TaskCommand):Promise<HostResult<OperationReceipt>>;
  startTask(input:StartTask):Promise<HostResult<RunSummary>>;
  listTaskActivity(query:{projectId:string;cursor?:number}):Promise<HostResult<ActivityPage>>;
  resourceBudget():Promise<HostResult<ResourceBudget>>;
  applyScheduleCommand(input:ScheduleCommand):Promise<HostResult<ScheduleView>>;
  listSchedules(query:{projectId:string}):Promise<HostResult<ScheduleView[]>>;
  listScheduleOccurrences(query:{projectId:string;scheduleId:string}):Promise<HostResult<OccurrenceView[]>>;
  applyTaskPlan(input:TaskPlanCommand):Promise<HostResult<TaskPlanView>>;
  listTaskPlans(query:{projectId:string}):Promise<HostResult<TaskPlanView[]>>;
  cancelTaskPlan(query:{projectId:string;planId:string;commandKey:string}):Promise<HostResult<TaskPlanView>>;
  getWorkspace(query:WorkspaceQuery):Promise<HostResult<WorkspaceOverview>>;
  listWorkspaceDirectory(query:WorkspaceEntryQuery):Promise<HostResult<WorkspaceDirectory>>;
  readWorkspaceFile(query:WorkspaceEntryQuery):Promise<HostResult<WorkspacePreview>>;
  getWorkspaceDiff(query:WorkspaceDiffQuery):Promise<HostResult<WorkspaceDiff>>;
  submitMessage(input: SubmitMessage): Promise<HostResult<RunSummary>>;
  continueRun(input:ContinueMessage):Promise<HostResult<RunSummary>>;
  listRuns(query: { projectId: string }): Promise<HostResult<RunSummary[]>>;
  getRun(query: RunQuery): Promise<HostResult<RunView>>;
  reconcileRun(query: RunQuery): Promise<HostResult<RunView>>;
  listInteractions(query: RunQuery): Promise<HostResult<InteractionView[]>>;
  replyInteraction(input: ReplyInteraction): Promise<HostResult<{ state: 'submitted' }>>;
  getVerification(query: RunQuery): Promise<HostResult<VerificationView>>;
  verifyRun(query: RunQuery): Promise<HostResult<VerificationView>>;
  interruptRun(query: RunQuery): Promise<HostResult<{ state: 'requested' }>>;
}
declare global { interface Window { personalAgent: DesktopApi } }
