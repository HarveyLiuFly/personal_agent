import type {ProjectView} from './views.ts';
export type WorktreeCommand={kind:'create';projectId:string;commandKey:string;name:string}|{kind:'remove';projectId:string;commandKey:string;workspaceId:string;expectedVersion:number;inspectionId:string}|{kind:'reconcile';projectId:string;operationId:string};
export interface ManagedWorktreeView extends ProjectView {sourceWorkspaceId:string;branch:string;baseCommit:string;version:number;state:'ready'|'removed'|'invalid'}
export interface WorktreeOperationView {operationId:string;kind:'create'|'remove';state:'prepared'|'dispatching'|'completed'|'failed'|'outcome_unknown';workspaceId:string|null;name:string;branch:string;errorCode:string|null;createdAt:number}
export interface WorktreePage {worktrees:ManagedWorktreeView[];operations:WorktreeOperationView[];canCreate:boolean}
export interface WorktreeInspection {inspectionId:string;workspaceId:string;version:number;canRemove:boolean;reasons:string[];trackedChanges:number;untracked:number;ignored:number;unmergedCommits:boolean;pendingTasks:number}
/** Trusted Host payload, never a Renderer input. */
export interface GitIdentity {directory:string;device:string;inode:string}
export interface GitWorkspaceSnapshot {directory:string;rootIdentity:GitIdentity;head:string;gitDir:string;commonDir:string;gitIdentity:GitIdentity;commonIdentity:GitIdentity}
export interface WorktreePayload {name:string;targetId:string;targetDirectory:string;branch:string;baseCommit:string;executionDirectory:string;source:GitWorkspaceSnapshot;target?:GitWorkspaceSnapshot;inspectionHash?:string;recoveryDirectory?:string}
export interface WorktreeDispatch {operationId:string;kind:'create'|'remove';state:WorktreeOperationView['state'];payload:WorktreePayload;runtimeEpoch:number;sourceFence:number;supervisorPid:number|null}
