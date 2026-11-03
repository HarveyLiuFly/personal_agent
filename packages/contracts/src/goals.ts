import type {CodeTaskSpec} from './views.ts';
export interface GoalNotificationPolicy {enabled:boolean;dailyLimit:number;quietStartMinute:number;quietEndMinute:number}
export interface GoalView {goalId:string;projectId:string;title:string;objective:string;criteria:string[];status:'active'|'paused'|'completed'|'cancelled';version:number;planVersion:number;deadlineAtMs:number|null;taskIds:string[];requiresPlan:boolean;notificationPolicy:GoalNotificationPolicy;budgetTokens:number|null}
export interface GoalPlanTask {key:string;text:string;code?:CodeTaskSpec;dispatch?:'queue_only'|'execute_once';dependsOn:string[];schedule?:unknown;subscription?:{sourceId:string;threadRef:string;purpose:'context_only'|'wake'|'actionable';eventTypes:string[];expiresAtMs:number}}
export type GoalCommand=
 |{kind:'create';commandKey:string;projectId:string;title:string;objective:string;criteria:string[];deadlineAtMs?:number;notificationPolicy?:GoalNotificationPolicy;budgetTokens?:number}
 |{kind:'revise';commandKey:string;goalId:string;expectedVersion:number;objective:string;criteria:string[];deadlineAtMs?:number;budgetTokens?:number}
 |{kind:'pause'|'cancel'|'resume';commandKey:string;goalId:string;expectedVersion:number}
 |{kind:'plan';commandKey:string;goalId:string;expectedVersion:number;expectedPlanVersion:number;tasks:GoalPlanTask[]}
 |{kind:'complete';commandKey:string;goalId:string;expectedVersion:number;verificationIds:string[]};
export interface GoalDispatchCandidate {projectId:string;taskId:string;expectedVersion:number;submissionKey:string}
export interface GoalCommandResult {goal:GoalView;taskIds:string[];affectedRunIds:string[];operationId:string;duplicate:boolean}
export interface TrustedSourceConfig {sourceId:string;bindingRef:string;allowedActors:string[];selfActor:string;eventTypes:string[];maxAgeMs:number}
export interface TrustedSourceEnvelope {bindingRef:string;verificationRef:string;actorRef:string;events:Array<{id:string;threadRef:string;eventType:string;occurredAtMs:number;payloadRef:string;payloadSha256:string}>;cursor:unknown}
export interface SourceIngestion {accepted:number;duplicates:number;ignored:number;deliveries:number;triggerIds:string[]}
export interface GoalNotificationView {operationId:string;goalId:string;kind:string;summary:string;state:'pending'|'sending'|'delivered'|'failed'|'cancelled'|'unknown';createdAt:number;providerRef:string|null;redacted:boolean}
export interface GoalNotificationClaim {operationId:string;goalId:string;dispatchKey:string;claimId:string;runtimeEpoch:number;kind:string;summary:string}

export interface GoalSourceEventView {triggerId:string;sourceId:string;eventId:string;threadRef:string;eventType:string;actorRef:string;verificationRef:string;payloadRef:string;payloadSha256:string;occurredAtMs:number;receivedAtMs:number}
