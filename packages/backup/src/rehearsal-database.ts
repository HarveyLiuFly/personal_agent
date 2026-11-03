import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {LedgerError} from '../../store/src/ledger.ts';
import {applyMemoryTombstones} from '../../store/src/memory.ts';

export interface RehearsalWatermarks {
  profileId:string;dotId:string;runtimeEpoch:number;policyEpoch:number;privacyEpoch:number;
  tombstones:Array<{sourceRef:string;privacyEpoch:number;deletedAtMs:number}>;
}
export interface RehearsalDatabaseSummary {
  runtimeEpoch:number;policyEpoch:number;privacyEpoch:number;tombstones:number;
  unknownRuns:number;pausedSchedules:number;revokedApprovals:number;retainedLeases:number;quarantinedArtifacts:number;
}
function fail(code:string):never{throw new LedgerError(code);}
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<Number.MAX_SAFE_INTEGER;
const nonnegative=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<Number.MAX_SAFE_INTEGER;
const reference=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\x00-\x1f]/.test(v);
/**
 * Destructive preparation of a caller-owned NEW candidate copy only; never pass the live ledger.
 * No Owner or executor is constructed. The quarantine table is a permanent execution-open barrier.
 * This reapplies the current deletion closure before the copy can become readable or executable.
 */
export function prepareRehearsalDatabase(file:string,current:RehearsalWatermarks,rehearsalId:string):RehearsalDatabaseSummary {
  if(!current||current.profileId!=='local-profile'||current.dotId!=='local-dot'||!positive(current.runtimeEpoch)||!positive(current.policyEpoch)||!positive(current.privacyEpoch)||!Array.isArray(current.tombstones)||current.tombstones.length>10000||!reference(rehearsalId)||rehearsalId.length>200)fail('INVALID_REHEARSAL_WATERMARKS');
  for(const t of current.tombstones)if(!t||!reference(t.sourceRef)||!positive(t.privacyEpoch)||!nonnegative(t.deletedAtMs))fail('INVALID_REHEARSAL_WATERMARKS');
  if(typeof file!=='string'||!isAbsolute(file))fail('INVALID_REHEARSAL_DATABASE');
  let fd:number|undefined,db:DatabaseSync|undefined,inTransaction=false;
  try{
    fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const identity=fstatSync(fd);
    if(!identity.isFile()||identity.size<100||identity.size>128*1024*1024||realpathSync(file)!==file)fail('INVALID_REHEARSAL_DATABASE');
    const sameFile=()=>{const info=lstatSync(file);if(info.isSymbolicLink()||info.dev!==identity.dev||info.ino!==identity.ino)fail('REHEARSAL_DATABASE_CHANGED');};
    sameFile();db=new DatabaseSync(file);db.exec('PRAGMA secure_delete=ON; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');inTransaction=true;
    const connection=db;
    if(connection.prepare('PRAGMA quick_check').get()?.quick_check!=='ok'||connection.prepare('PRAGMA foreign_key_check').all().length)fail('INVALID_REHEARSAL_DATABASE');
    if(connection.prepare("SELECT name FROM sqlite_master WHERE name='recovery_quarantine'").get())fail('REHEARSAL_ALREADY_QUARANTINED');
    if(connection.prepare('SELECT schema_revision FROM schema_metadata WHERE singleton=1').get()?.schema_revision!==6)fail('REHEARSAL_SCHEMA_UNSUPPORTED');
    const profiles=connection.prepare('SELECT profile_id FROM profiles').all(),dots=connection.prepare('SELECT profile_id,dot_id,policy_epoch,privacy_epoch FROM dots').all(),owners=connection.prepare('SELECT profile_id,runtime_epoch FROM runtime_owners').all();
    if(profiles.length!==1||profiles[0]!.profile_id!==current.profileId||dots.length!==1||dots[0]!.dot_id!==current.dotId||dots[0]!.profile_id!==current.profileId||owners.length!==1||owners[0]!.profile_id!==current.profileId)fail('REHEARSAL_SCOPE_MISMATCH');
    const next=(...values:unknown[])=>{if(values.some(v=>!nonnegative(v)))fail('REHEARSAL_WATERMARK_OVERFLOW');const maximum=Math.max(...values as number[]);if(maximum>=Number.MAX_SAFE_INTEGER-1)fail('REHEARSAL_WATERMARK_OVERFLOW');return maximum+1;};
    const count=(sql:string)=>Number(connection.prepare(sql).get()!.n);
    // Check numeric fences before incrementing: SQLite INTEGER alone does not guarantee JS safe integers.
    for(const [table,columns]of [['tasks',['version','write_fence']],['workspaces',['write_fence']],['goals',['version','plan_version']],['schedules',['version']],['computer_sessions',['control_epoch']],['outbox_events',['claim_epoch']]] as const){
      for(const column of columns){const value=connection.prepare(`SELECT coalesce(max(${column}),0) AS n FROM ${table}`).get()!.n;if(!nonnegative(value)||Number(value)>=Number.MAX_SAFE_INTEGER-1)fail('REHEARSAL_WATERMARK_OVERFLOW');}
    }
    const runtimeEpoch=next(Number(owners[0]!.runtime_epoch),current.runtimeEpoch),policyEpoch=next(Number(dots[0]!.policy_epoch),current.policyEpoch);
    for(const t of current.tombstones)connection.prepare('INSERT INTO privacy_tombstones(dot_id,source_ref,privacy_epoch,deleted_at_ms) VALUES (?,?,?,?) ON CONFLICT(dot_id,source_ref) DO UPDATE SET privacy_epoch=max(privacy_tombstones.privacy_epoch,excluded.privacy_epoch),deleted_at_ms=max(privacy_tombstones.deleted_at_ms,excluded.deleted_at_ms)').run(current.dotId,t.sourceRef,t.privacyEpoch,t.deletedAtMs);
    const privacyEpoch=next(Number(dots[0]!.privacy_epoch),current.privacyEpoch,count('SELECT coalesce(max(privacy_epoch),0) AS n FROM privacy_tombstones'));
    connection.exec('CREATE TABLE recovery_quarantine (singleton INTEGER PRIMARY KEY CHECK(singleton=1),rehearsal_id TEXT NOT NULL,created_at_ms INTEGER NOT NULL);');
    connection.prepare('INSERT INTO recovery_quarantine VALUES (1,?,?)').run(rehearsalId,Date.now());
    connection.prepare("UPDATE runtime_owners SET runtime_epoch=?,instance_id=?,state='stopped',updated_at_ms=? WHERE profile_id=?").run(runtimeEpoch,'rehearsal:'+rehearsalId,Date.now(),current.profileId);
    connection.prepare('UPDATE dots SET policy_epoch=?,privacy_epoch=? WHERE dot_id=?').run(policyEpoch,privacyEpoch,current.dotId);

    // Terminal states are preserved as evidence. All uncertain execution remains uncertain and blocked.
    connection.exec("UPDATE task_runs SET status='outcome_unknown' WHERE status NOT IN ('completed','failed','cancelled');");
    connection.exec("UPDATE tasks SET dispatch_blocked=1,version=version+1,write_fence=write_fence+1,status=CASE WHEN EXISTS(SELECT 1 FROM task_runs r WHERE r.task_id=tasks.task_id AND r.status='outcome_unknown') THEN 'outcome_unknown' WHEN status IN ('created','queued','running','waiting_input','waiting_approval','waiting_trigger') THEN 'paused' ELSE status END;");
    connection.exec('UPDATE workspaces SET write_fence=write_fence+1;');
    connection.exec("UPDATE execution_intents SET state='rejected',response_ref='recovery_rehearsal_not_sent' WHERE state='prepared'; UPDATE execution_intents SET state='outcome_unknown' WHERE state='sending';");
    connection.exec("UPDATE runtime_requests SET state=CASE WHEN state='responding' THEN 'outcome_unknown' ELSE 'cancelled' END WHERE state IN ('pending','responding'); UPDATE pending_interactions SET state='cancelled' WHERE state='pending';");
    const revokedApprovals=count("SELECT count(*) AS n FROM approval_receipts WHERE state='granted'")+count("SELECT count(*) AS n FROM mandates WHERE state='active'");
    connection.exec("UPDATE approval_receipts SET state='revoked',uses_remaining=0 WHERE state='granted'; UPDATE mandates SET state='revoked' WHERE state='active';");
    connection.exec("UPDATE actions SET status=CASE WHEN status IN ('reserved','dispatched') THEN 'outcome_unknown' ELSE 'rejected' END WHERE status IN ('prepared','awaiting_approval','approved','reserved','dispatched');");
    connection.exec("UPDATE sources SET enabled=0; UPDATE subscriptions SET state='paused' WHERE state='active'; UPDATE schedules SET state='paused',version=version+1,next_fire_at_ms=NULL WHERE state IN ('active','paused'); UPDATE schedule_occurrences SET state='cancelled' WHERE state IN ('pending','waiting_host','enqueued'); UPDATE trigger_deliveries SET state='ignored',reason_code='RECOVERY_REHEARSAL_QUARANTINE' WHERE state IN ('pending','claimed');");
    connection.exec("UPDATE outbox_events SET state='dead_letter',claim_epoch=claim_epoch+1,lease_until_ms=0,next_attempt_at_ms=NULL WHERE state IN ('pending','claimed');");
    connection.exec("UPDATE operations SET state=CASE WHEN state='executing' THEN 'outcome_unknown' ELSE 'cancelled' END WHERE state IN ('pending','blocked','executing');");
    connection.exec("UPDATE worktree_operations SET state='outcome_unknown',error_code='RECOVERY_REHEARSAL_UNKNOWN' WHERE state IN ('prepared','dispatching'); UPDATE terminal_sessions SET state='outcome_unknown',error_code='RECOVERY_REHEARSAL_UNKNOWN' WHERE state IN ('prepared','starting','running','stopping'); UPDATE terminal_inputs SET state='outcome_unknown' WHERE state='sending'; UPDATE operations SET state='outcome_unknown' WHERE operation_id IN (SELECT operation_id FROM worktree_operations WHERE state='outcome_unknown' UNION SELECT operation_id FROM terminal_sessions WHERE state='outcome_unknown');");
    connection.exec("UPDATE thread_bindings SET state='invalidated',rollover_reason='recovery_rehearsal_quarantine' WHERE state='active'; UPDATE goals SET status='paused',version=version+1,plan_version=plan_version+1 WHERE status='active'; UPDATE computer_sessions SET state='revoking',control_owner='none',control_epoch=control_epoch+1 WHERE state NOT IN ('closed','failed');");
    connection.exec("UPDATE budget_reservations SET state='held_unknown' WHERE state='active'; UPDATE run_usage SET finalized=1 WHERE run_id IN (SELECT run_id FROM task_runs WHERE status='outcome_unknown'); UPDATE thread_usage SET baseline_known=0;");
    const quarantinedArtifacts=Number(connection.prepare("UPDATE artifacts SET state='deleted' WHERE state='published' AND task_id IS NOT NULL AND EXISTS(SELECT 1 FROM privacy_tombstones p WHERE p.dot_id=artifacts.dot_id AND p.source_ref IN (artifacts.task_id,'task:'||artifacts.task_id))").run().changes);
    applyMemoryTombstones(connection,current.dotId,fail);
    const summary:RehearsalDatabaseSummary={runtimeEpoch,policyEpoch,privacyEpoch,tombstones:count('SELECT count(*) AS n FROM privacy_tombstones'),unknownRuns:count("SELECT count(*) AS n FROM task_runs WHERE status='outcome_unknown'"),pausedSchedules:count("SELECT count(*) AS n FROM schedules WHERE state='paused'"),revokedApprovals,retainedLeases:count('SELECT count(*) AS n FROM workspace_write_leases')+count('SELECT count(*) AS n FROM project_operation_leases')+count('SELECT count(*) AS n FROM workspace_terminal_leases'),quarantinedArtifacts};
    const preparedBytes=Number(connection.prepare('PRAGMA page_count').get()!.page_count)*Number(connection.prepare('PRAGMA page_size').get()!.page_size);
    if(!Number.isSafeInteger(preparedBytes)||preparedBytes>128*1024*1024)fail('REHEARSAL_DATABASE_TOO_LARGE');
    sameFile();if(connection.prepare('PRAGMA foreign_key_check').all().length||connection.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')fail('INVALID_REHEARSAL_DATABASE');connection.exec('COMMIT');inTransaction=false;connection.exec('PRAGMA wal_checkpoint(TRUNCATE);VACUUM;');return summary;
  }catch(error){if(inTransaction)try{db?.exec('ROLLBACK');}catch{}throw error instanceof LedgerError?error:new LedgerError('REHEARSAL_DATABASE_PREPARATION_FAILED');}
  finally{try{db?.close();}finally{if(fd!==undefined)closeSync(fd);}}
}
