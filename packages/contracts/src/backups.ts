export interface BackupView {
  id:string;state:'available'|'incomplete'|'invalid';createdAt:number|null;
  bytes:number|null;receipts:number|null;schemaRevision:number|null;
}
export interface RehearsalSummary {runtimeEpoch:number;policyEpoch:number;privacyEpoch:number;tombstones:number;unknownRuns:number;pausedSchedules:number;revokedApprovals:number;retainedLeases:number;quarantinedArtifacts:number}
export interface RehearsalView {id:string;backupId:string|null;state:'saved'|'incomplete'|'invalid';createdAt:number|null;bytes:number|null;summary:RehearsalSummary|null;activationBlocked:boolean}
export interface BackupPage {items:BackupView[];limit:20;scope:'ledger_and_verification_receipts';rehearsals?:RehearsalView[]}
export interface BackupVerification {id:string;verifiedAt:number;files:number;bytes:number;schemaRevision:number;activeRuns:number;pendingTerminals:number;pendingWorktreeOperations:number;runtimeEpoch:number;policyEpoch:number;privacyEpoch:number;tombstones:number}
export type BackupCommand = {kind:'create';commandKey:string}|{kind:'verify';backupId:string}|{kind:'rehearse';backupId:string;commandKey:string};
export interface BackupCommandResult {backup:BackupView;verification:BackupVerification;rehearsal?:RehearsalView}
