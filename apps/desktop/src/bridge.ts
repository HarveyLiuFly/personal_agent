import type { HostResult, ProjectView, ThreadSummary, TurnView, ItemView, Page, ProjectQuery, ThreadQuery, ItemQuery } from '../../../packages/contracts/src/views.ts';
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
  runSmoke(): Promise<SmokeInfo>;
  chooseProject(): Promise<HostResult<ProjectView | null>>;
  listThreads(query: ProjectQuery): Promise<HostResult<Page<ThreadSummary>>>;
  listTurns(query: ThreadQuery): Promise<HostResult<Page<TurnView>>>;
  listItems(query: ItemQuery): Promise<HostResult<Page<ItemView>>>;
}
declare global { interface Window { personalAgent: DesktopApi } }
