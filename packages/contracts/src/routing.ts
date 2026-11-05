import type { MainChatInput } from './chat.ts';
import type { OperationReceipt } from './tasks.ts';
export const routeKinds = [
  'CHAT',
  'CREATE_TASK',
  'CONTINUE_TASK',
  'UPDATE_TASK',
  'QUERY_TASK',
  'PAUSE_TASK',
  'CANCEL_TASK',
  'CREATE_GOAL',
  'CLARIFY',
] as const;
export interface RouteOperation {
  kind: (typeof routeKinds)[number];
  taskId: string | null;
  text: string | null;
  title: string | null;
  dependsOn: number[];
}
export interface RoutePlan {
  operations: RouteOperation[];
  focusTaskId: string | null;
  question: string | null;
}
export interface RouteStep {
  index: number;
  state: 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
  operation: RouteOperation;
  operationId?: string;
  taskId?: string;
  runId?: string;
  errorCode?: string;
  result?: string;
  receipt?: OperationReceipt;
}
export interface ChatRouteView {
  id: string;
  messageId: string;
  projectId: string;
  state:
    | 'prepared'
    | 'proposing'
    | 'proposed'
    | 'committing'
    | 'completed'
    | 'failed'
    | 'outcome_unknown'
    | 'corrected';
  routingRunId: string | null;
  version: number;
  steps: RouteStep[];
  plan: RoutePlan | null;
  errorCode?: string;
  createdAt: number;
}
export type ProposeMainChat = Omit<MainChatInput, 'pendingInteractionId'>;
export interface CommitChatRoute {
  projectId: string;
  planId: string;
  expectedVersion: number;
}
