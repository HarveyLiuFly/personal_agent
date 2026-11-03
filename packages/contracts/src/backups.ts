export interface BackupView {
  id:string;state:'available'|'incomplete'|'invalid';createdAt:number|null;
  bytes:number|null;receipts:number|null;schemaRevision:number|null;
}
export interface BackupPage {items:BackupView[];limit:20;scope:'ledger_and_verification_receipts'}
export interface BackupVerification {id:string;verifiedAt:number;files:number;bytes:number;schemaRevision:number;activeRuns:number;pendingTerminals:number;pendingWorktreeOperations:number;runtimeEpoch:number;policyEpoch:number;privacyEpoch:number;tombstones:number}
export type BackupCommand = {kind:'create';commandKey:string}|{kind:'verify';backupId:string};
export interface BackupCommandResult {backup:BackupView;verification:BackupVerification}
