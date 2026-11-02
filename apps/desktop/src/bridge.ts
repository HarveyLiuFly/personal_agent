import type { HostResult, ProjectView, ThreadSummary, TurnView, ItemView, Page, ProjectQuery, ThreadQuery, ItemQuery } from '../../../packages/contracts/src/views.ts';
import type { InteractionView, ReplyInteraction, RunQuery, RunSummary, RunView, SubmitMessage } from '../../../packages/contracts/src/views.ts';
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
  workspaceState(): Promise<HostResult<{ projects: ProjectView[]; canSubmit: boolean; mode: 'readOnly' | 'workspaceWrite' }>>;
  submitMessage(input: SubmitMessage): Promise<HostResult<RunSummary>>;
  listRuns(query: { projectId: string }): Promise<HostResult<RunSummary[]>>;
  getRun(query: RunQuery): Promise<HostResult<RunView>>;
  listInteractions(query: RunQuery): Promise<HostResult<InteractionView[]>>;
  replyInteraction(input: ReplyInteraction): Promise<HostResult<{ state: 'submitted' }>>;
  interruptRun(query: RunQuery): Promise<HostResult<{ state: 'requested' }>>;
}
declare global { interface Window { personalAgent: DesktopApi } }
