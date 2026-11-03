/** Normative design DTOs. These are contracts, not a running application. */
export type Id<K extends string> = string & { readonly __kind: K };
export type TaskId = Id<"task">;
export type RunId = Id<"run">;
export type TriggerId = Id<"incoming-trigger">;
export type ScheduleId = Id<"schedule">;
export type OccurrenceId = Id<"schedule-occurrence">;
export type OperationId = Id<"operation">;
export type MessageId = Id<"message">;
export type MillisecondsUTC = number;

export const taskStatuses = [
  "created", "queued", "running", "waiting_input", "waiting_approval",
  "waiting_trigger", "paused", "needs_review", "completed", "failed",
  "cancelled", "outcome_unknown"
] as const;
export type TaskStatus = typeof taskStatuses[number];

export const runStatuses = [
  "preparing", "submitting", "running", "waiting_input", "waiting_approval",
  "completed", "failed", "cancelled", "outcome_unknown"
] as const;
export type RunStatus = typeof runStatuses[number];

export const actionStatuses = [
  "prepared", "awaiting_approval", "approved", "reserved", "dispatched",
  "succeeded", "failed", "outcome_unknown", "rejected", "cancelled"
] as const;
export type ActionStatus = typeof actionStatuses[number];

/** These transitions also require the guards specified in the design document. */
export const taskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  created: ["queued", "cancelled"],
  queued: ["running", "waiting_trigger", "paused", "cancelled"],
  running: ["waiting_input", "waiting_approval", "waiting_trigger", "paused", "needs_review", "completed", "failed", "cancelled", "outcome_unknown"],
  waiting_input: ["queued", "running", "paused", "cancelled", "outcome_unknown"],
  waiting_approval: ["queued", "running", "paused", "cancelled", "outcome_unknown"],
  waiting_trigger: ["queued", "paused", "cancelled"],
  paused: ["queued", "cancelled"],
  needs_review: ["queued", "completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
  outcome_unknown: ["needs_review", "waiting_input", "completed", "failed"]
};

export type ExecutorKind = "codex" | "dsh-experimental";
export type AgentRole = "coding" | "plan" | "research" | "browser" | "computer"
  | "dot-orchestrator" | "goal-reviewer" | "memory-extractor" | "memory-consolidator";
export type ExecutionMode = "read-only" | "execution" | "review" | "checkpoint-resume" | "human-takeover-resume";
export type RouteAction = "CHAT" | "CREATE_TASK" | "CONTINUE_TASK" | "UPDATE_TASK"
  | "QUERY_TASK" | "PAUSE_TASK" | "CANCEL_TASK" | "CREATE_GOAL" | "CLARIFY";

export interface RouteOperation {
  operationId: OperationId; // Assigned and persisted by the Host, not trusted from the model.
  operationIndex: number;
  action: RouteAction;
  targetTaskId?: TaskId;
  expectedTaskVersion?: number;
  inputHash: string;
  dependsOnOperationIds: OperationId[];
  input: Readonly<Record<string, unknown>>;
}
export interface RoutePlan {
  decisionId: string;
  messageId: MessageId;
  routerRevision: string;
  candidateTaskIds: TaskId[];
  operations: RouteOperation[];
}

export interface IncomingTrigger {
  triggerId: TriggerId;
  sourceId: string;
  sourceEventId: string;
  sourceThreadRef?: string;
  dotId: string;
  actorRef: string;
  verificationRef: string; // Bound by the trusted Source Adapter.
  payloadRef: string;
  payloadSha256: string;
  occurredAtMs: MillisecondsUTC;
  receivedAtMs: MillisecondsUTC;
}
export interface Subscription {
  subscriptionId: string;
  taskId: TaskId;
  sourceId: string;
  sourceThreadRef: string;
  purpose: "context_only" | "wake" | "actionable";
  eventTypes: string[];
}
export interface Schedule {
  scheduleId: ScheduleId;
  taskId: TaskId;
  version: number;
  kind: "once" | "cron";
  timezone: string;
  spec: Readonly<Record<string, unknown>>;
  misfirePolicy: "skip" | "coalesce" | "bounded_catch_up";
  overlapPolicy: "skip" | "coalesce";
  maxCatchUp: number;
}
export interface ScheduleOccurrence {
  occurrenceId: OccurrenceId;
  scheduleId: ScheduleId;
  scheduleVersion: number;
  scheduledAtMs: MillisecondsUTC;
  triggerId?: TriggerId;
}

export interface ExecutionGrant {
  taskId: TaskId;
  runId: RunId;
  taskVersion: number;
  taskFence: number;
  runtimeEpoch: number;
  policyEpoch: number;
  privacyEpoch: number;
  workspaceFence?: number;
  controlEpoch?: number;
  capabilitiesHash: string;
  expiresAtMs: MillisecondsUTC;
}
export interface ContextRef {
  sourceRef: string;
  sourceRevision: string;
  trust: "explicit_user" | "verified_connector" | "agent_inference" | "untrusted_external";
  sensitivity: string;
  privacyEpoch: number;
}
export interface TaskContextBundle {
  taskId: TaskId;
  taskVersion: number;
  goalPlanVersion?: number;
  privacyEpoch: number;
  checkpointId?: string;
  constraints: Readonly<Record<string, unknown>>;
  completionCriteria: string[];
  recentMessageIds: MessageId[];
  evidence: ContextRef[];
  artifactIds: string[];
  tokenBudget: number;
}
export interface PromptManifest {
  manifestId: string;
  runId: RunId;
  role: AgentRole;
  mode: ExecutionMode;
  moduleHashes: Readonly<Record<string, string>>;
  toolSnapshotHash: string;
  policyEpoch: number;
  privacyEpoch: number;
  contextRefs: ContextRef[];
}

export interface ExecutionIntent {
  intentId: string;
  runId: RunId;
  intentKey: string;
  kind: "thread_start" | "thread_resume" | "turn_start" | "turn_steer" | "turn_interrupt";
  executionThreadId?: string;
  executionTurnId?: string;
  state: "prepared" | "sending" | "accepted" | "rejected" | "outcome_unknown" | "reconciled";
  inputHash: string;
  connectionEpoch?: number;
  rpcRequestId?: string;
}
export interface ExecutionRequest {
  executor: ExecutorKind;
  grant: ExecutionGrant;
  context: TaskContextBundle;
  promptManifestId: string;
  workspaceId?: string;
  sandboxProfile: "readOnly" | "workspaceWrite";
}
export interface AgentExecutionGateway {
  prepare(request: ExecutionRequest): Promise<ExecutionIntent>;
  submit(intentId: string): Promise<ExecutionIntent>;
  reconcile(intentId: string): Promise<ExecutionIntent>;
  interrupt(runId: RunId): Promise<{ state: "requested" | "acknowledged" | "unknown" }>;
}
export interface TaskEvent {
  eventId: string;
  taskId: TaskId;
  runId?: RunId;
  sequence: number;
  taskVersion: number;
  eventType: string;
  correlationId?: string;
  causationId?: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAtMs: MillisecondsUTC;
}

export type ComputerAction =
  | { type: "click" | "double_click" | "move"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "drag"; points: ReadonlyArray<{ x: number; y: number }> }
  | { type: "keypress"; keys: string[] }
  | { type: "type"; text: string }
  | { type: "wait"; milliseconds: number };
export interface ComputerActionEnvelope {
  actionId: string;
  sessionId: string;
  sourceFrameId: string;
  expectedControlEpoch: number;
  grant: ExecutionGrant;
  action: ComputerAction;
  approvalReceiptRef?: string;
}
export interface ActionProposal {
  actionId: string;
  actionKey: string;
  grant: ExecutionGrant;
  capability: string;
  accountRef: string;
  destination: string;
  canonicalPayloadHash: string;
  amountMinorUnits?: string;
  currency?: string;
  targetVersion?: string;
  expiresAtMs: MillisecondsUTC;
}
export interface ActionReceipt {
  actionId: string;
  status: "succeeded" | "failed" | "outcome_unknown";
  providerObjectId?: string;
  evidenceRef: string;
}
export interface VerificationSpec {
  specId: string;
  taskId: TaskId;
  revision: number;
  kind: "code" | "document" | "external_action";
  baselineCommit?: string;
  commandArgv: string[];
  requiredTargets: string[];
  minimumExecutedTests?: number;
  allowTestModifications: boolean;
  verifierHash: string;
  requiredEvidence: string[];
}
