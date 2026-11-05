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
  /** Set on a fresh user send: a single read-only CHAT proposal is answered without confirmation. */
  autoAnswer?: boolean;
}
/**
 * A proposal that is exactly one pending CHAT step with no dependencies: the user's send already
 * authorizes answering it. Every other plan waits for explicit confirmation.
 */
export function answersDirectly(route: ChatRouteView): boolean {
  return (
    route.state === 'proposed' &&
    route.plan?.operations.length === 1 &&
    route.plan.operations[0]?.kind === 'CHAT' &&
    route.plan.operations[0].dependsOn.length === 0 &&
    route.steps.length === 1 &&
    route.steps[0]?.operation.kind === 'CHAT' &&
    route.steps[0].state === 'pending'
  );
}
export type ProposeMainChat = Omit<MainChatInput, 'pendingInteractionId'>;
export interface CommitChatRoute {
  projectId: string;
  planId: string;
  expectedVersion: number;
}
