import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync,truncateSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {prepareRehearsalDatabase} from '../packages/backup/src/rehearsal-database.ts';
import type {RehearsalWatermarks} from '../packages/backup/src/rehearsal-database.ts';

const schema=readFileSync('docs/design/contracts/schema.sql','utf8');
/** Real SQLite/FS, explicitly synthetic Run/lease/approval rows. Never starts an Owner, process or model. */
function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-rehearsal-db-'))),file=join(root,'candidate.db'),db=new DatabaseSync(file);t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});db.exec(schema);
  db.exec(`
    INSERT INTO profiles VALUES ('local-profile','Public Fixture',1);
    INSERT INTO runtime_owners VALUES ('local-profile',2,'synthetic-old-owner','main','ready',1);
    INSERT INTO dots VALUES ('local-dot','local-profile','Public Dot',3,4);
    INSERT INTO projects VALUES ('project','local-dot','/public/synthetic','Fixture');
    INSERT INTO workspaces VALUES ('workspace','project','local-dot','/public/synthetic','main','ready',5);
    INSERT INTO workspace_identities VALUES ('workspace','1','2');
    INSERT INTO tasks(task_id,dot_id,workspace_id,title,status,dispatch_blocked,version,write_fence,created_at_ms,updated_at_ms) VALUES ('task','local-dot','workspace','Synthetic active task','running',0,2,3,1,1);
    INSERT INTO tasks(task_id,dot_id,workspace_id,title,status,created_at_ms,updated_at_ms) VALUES ('other-task','local-dot','workspace','Synthetic queued task','queued',1,1);
    INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES ('run','task','local-dot','synthetic-key','codex','running',2,3,2,3,4,'synthetic-not-executed',9999999999999,1);
    INSERT INTO workspace_write_leases VALUES ('workspace','run',5,9999999999999);
    INSERT INTO conversations VALUES ('conversation','local-dot');
    INSERT INTO messages VALUES ('message','conversation','local-dot','user','Public synthetic request','hash','decided',1,NULL);
    INSERT INTO router_decisions VALUES ('decision','message','synthetic-fixture','[]','{}',1);
    INSERT INTO operations VALUES ('worktree-op','decision',0,'task','CREATE_WORKTREE','executing',2,'{}','hash',NULL);
    INSERT INTO operations VALUES ('terminal-op','decision',1,'task','OPEN_TERMINAL','executing',2,'{}','hash',NULL);
    INSERT INTO operations VALUES ('queued-op','decision',2,'other-task','synthetic','pending',1,'{}','hash',NULL);
    INSERT INTO worktree_operations VALUES ('worktree-op','local-dot','project','workspace',NULL,'create','dispatching',5,2,987650001,'{}','hash',NULL,NULL,1);
    INSERT INTO project_operation_leases VALUES ('project','worktree-op',2,5);
    INSERT INTO terminal_sessions VALUES ('terminal','terminal-op','local-dot','workspace','running',2,5,987650002,987650003,80,24,1,NULL,NULL,1);
    INSERT INTO workspace_terminal_leases VALUES ('workspace','terminal',2,5);
    INSERT INTO terminal_inputs VALUES ('terminal',1,'hash',8,'sending');
    INSERT INTO execution_intents VALUES ('prepared','run','prepared-key','thread_start',NULL,NULL,'prepared','hash',NULL,NULL,NULL,1);
    INSERT INTO execution_intents VALUES ('sending','run','sending-key','turn_start','thread',NULL,'sending','hash',1,'rpc-send',NULL,1);
    INSERT INTO execution_intents VALUES ('accepted','run','accepted-key','thread_resume','thread',NULL,'accepted','hash',1,'rpc-accepted',NULL,1);
    INSERT INTO runtime_requests VALUES ('pending-request','run',2,1,'rpc-pending','thread','turn','command','pending','{}',NULL,9999999999999);
    INSERT INTO runtime_requests VALUES ('responding-request','run',2,1,'rpc-responding','thread','turn','files','responding','{}','hash',9999999999999);
    INSERT INTO pending_interactions VALUES ('interaction','local-dot','message','task','approval','pending',2,'[]',9999999999999);
    INSERT INTO actions(action_id,task_id,run_id,action_key,capability,canonical_payload_json,payload_hash,task_version,task_fence,policy_epoch,status) VALUES ('approved-action','task','run','action-key','synthetic','{}','hash',2,3,3,'approved');
    INSERT INTO approval_receipts VALUES ('approval','approved-action','hash','synthetic-user',9999999999999,1,'granted');
    UPDATE actions SET approval_receipt_id='approval' WHERE action_id='approved-action';
    INSERT INTO actions(action_id,task_id,run_id,action_key,capability,canonical_payload_json,payload_hash,task_version,task_fence,policy_epoch,status) VALUES ('dispatched-action','task','run','dispatched-key','synthetic','{}','hash',2,3,3,'dispatched');
    INSERT INTO actions(action_id,task_id,run_id,action_key,capability,canonical_payload_json,payload_hash,task_version,task_fence,policy_epoch,status) VALUES ('reserved-action','task','run','reserved-key','synthetic','{}','hash',2,3,3,'reserved');
    INSERT INTO mandates VALUES ('mandate','task',NULL,3,'[]','synthetic-user','active',9999999999999);
    INSERT INTO sources VALUES ('source','local-dot','scheduler','synthetic-source','{}',1);
    INSERT INTO incoming_triggers VALUES ('trigger','source','local-dot','synthetic-event',NULL,'synthetic-actor','synthetic-proof','synthetic-payload','hash',1,1);
    INSERT INTO subscriptions VALUES ('subscription','task','source','local-dot','synthetic-thread','wake','[]','active');
    INSERT INTO trigger_deliveries VALUES ('delivery','trigger','task','local-dot','wake','claimed',NULL);
    INSERT INTO schedules VALUES ('schedule','task',1,'once','{}','UTC','active','coalesce','coalesce',1,9999999999999,NULL);
    INSERT INTO schedules VALUES ('paused-schedule','other-task',1,'once','{}','UTC','paused','skip','skip',1,NULL,NULL);
    INSERT INTO schedule_occurrences VALUES ('occurrence','schedule',1,1,'trigger','waiting_host');
    INSERT INTO outbox_events(outbox_id,dedupe_key,event_type,aggregate_ref,payload_json,state,claim_epoch,lease_until_ms,attempts,next_attempt_at_ms) VALUES ('outbox','outbox-key','synthetic','task','{}','claimed',1,9999999999999,0,9999999999999);
    INSERT INTO thread_bindings VALUES ('binding','task','codex','synthetic-thread',1,4,'active',NULL);
    INSERT INTO computer_sessions VALUES ('computer','task','run','browser','ready','agent',2,3,'{}',NULL,'synthetic-driver');
    INSERT INTO goals VALUES ('goal','local-dot','Synthetic goal','not executed','active',1,1,'{}','[]',NULL);
    INSERT INTO budget_buckets VALUES ('budget','local-dot',NULL,'tokens',1,2,100,10,0);
    INSERT INTO budget_reservations VALUES ('reservation','budget','run',10,'active',NULL,NULL);
    INSERT INTO run_usage VALUES ('run','thread',0,5,0,0,NULL,1);
    INSERT INTO thread_usage VALUES ('thread','local-dot',5,'run',1,1);
    INSERT INTO artifacts VALUES ('private-artifact','local-dot','task','hash','private.json','published','private',4,1,NULL);
    INSERT INTO artifacts VALUES ('visible-artifact','local-dot','other-task','hash','public.json','published','private',4,1,NULL);
  `);
  const current:RehearsalWatermarks={profileId:'local-profile',dotId:'local-dot',runtimeEpoch:8,policyEpoch:9,privacyEpoch:10,tombstones:[]};
  const one=(sql:string)=>{const row=db.prepare(sql).get();assert.ok(row);return{...row};};
  return{root,file,db,current,one};
}
function dump(db:DatabaseSync){return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>[row.name,db.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all()]);}

test('rehearsal merges latest and absent-source tombstones, advances barriers and does not mutate input',t=>{
  const f=fixture(t);f.db.exec("INSERT INTO privacy_tombstones VALUES ('local-dot','shared-source',14,100);");
  f.current.tombstones=[{sourceRef:'shared-source',privacyEpoch:12,deletedAtMs:200},{sourceRef:'task:task',privacyEpoch:10,deletedAtMs:300},{sourceRef:'source-not-in-backup',privacyEpoch:11,deletedAtMs:400}];
  const before=structuredClone(f.current),result=prepareRehearsalDatabase(f.file,f.current,'public-rehearsal');
  assert.deepEqual(f.current,before);assert.deepEqual(result,{runtimeEpoch:9,policyEpoch:10,privacyEpoch:15,tombstones:3,unknownRuns:1,pausedSchedules:2,revokedApprovals:2,retainedLeases:3,quarantinedArtifacts:1});
  assert.equal(f.one('SELECT state FROM runtime_owners').state,'stopped');assert.equal(f.one('SELECT runtime_epoch FROM runtime_owners').runtime_epoch,9);
  assert.deepEqual(f.one("SELECT privacy_epoch,deleted_at_ms FROM privacy_tombstones WHERE source_ref='shared-source'"),{privacy_epoch:14,deleted_at_ms:200});
  assert.equal(f.one("SELECT state FROM artifacts WHERE artifact_id='private-artifact'").state,'deleted');assert.equal(f.one("SELECT state FROM artifacts WHERE artifact_id='visible-artifact'").state,'published');
  assert.equal(f.one('SELECT count(*) AS n FROM recovery_quarantine').n,1);assert.equal(f.one('SELECT rehearsal_id FROM recovery_quarantine').rehearsal_id,'public-rehearsal');assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('uncertain operations and all original leases/PIDs remain evidence, with increased Task and Workspace fences',t=>{
  const f=fixture(t),leases=['workspace_write_leases','project_operation_leases','workspace_terminal_leases'].map(name=>f.db.prepare('SELECT * FROM '+name).all());
  prepareRehearsalDatabase(f.file,f.current,'retained-evidence');
  assert.deepEqual(['workspace_write_leases','project_operation_leases','workspace_terminal_leases'].map(name=>f.db.prepare('SELECT * FROM '+name).all()),leases);
  assert.equal(f.one('SELECT status FROM task_runs').status,'outcome_unknown');assert.equal(f.one("SELECT status FROM tasks WHERE task_id='task'").status,'outcome_unknown');assert.equal(f.one("SELECT dispatch_blocked FROM tasks WHERE task_id='other-task'").dispatch_blocked,1);assert.equal(f.one("SELECT status FROM tasks WHERE task_id='other-task'").status,'paused');assert.equal(f.one("SELECT write_fence FROM tasks WHERE task_id='task'").write_fence,4);assert.equal(f.one('SELECT write_fence FROM workspaces').write_fence,6);
  assert.deepEqual(f.one('SELECT state,supervisor_pid FROM worktree_operations'),{state:'outcome_unknown',supervisor_pid:987650001});assert.deepEqual(f.one('SELECT state,supervisor_pid,pty_pid,last_input_sequence FROM terminal_sessions'),{state:'outcome_unknown',supervisor_pid:987650002,pty_pid:987650003,last_input_sequence:1});assert.equal(f.one('SELECT state FROM terminal_inputs').state,'outcome_unknown');assert.equal(f.one('SELECT state FROM budget_reservations').state,'held_unknown');assert.equal(f.one('SELECT reserved_units FROM budget_buckets').reserved_units,10);assert.equal(f.one('SELECT baseline_known FROM thread_usage').baseline_known,0);
});
test('old grants, schedules, deliveries and queued effects cannot become dispatchable',t=>{
  const f=fixture(t);prepareRehearsalDatabase(f.file,f.current,'no-replay');
  assert.deepEqual(f.one('SELECT state,uses_remaining FROM approval_receipts'),{state:'revoked',uses_remaining:0});assert.equal(f.one('SELECT state FROM mandates').state,'revoked');assert.equal(f.one("SELECT status FROM actions WHERE action_id='approved-action'").status,'rejected');assert.equal(f.one("SELECT status FROM actions WHERE action_id='dispatched-action'").status,'outcome_unknown');assert.equal(f.one("SELECT status FROM actions WHERE action_id='reserved-action'").status,'outcome_unknown');
  assert.equal(f.one("SELECT state FROM execution_intents WHERE intent_id='prepared'").state,'rejected');assert.equal(f.one("SELECT state FROM execution_intents WHERE intent_id='sending'").state,'outcome_unknown');assert.equal(f.one("SELECT state FROM execution_intents WHERE intent_id='accepted'").state,'accepted');assert.equal(f.one("SELECT state FROM runtime_requests WHERE request_id='pending-request'").state,'cancelled');assert.equal(f.one("SELECT state FROM runtime_requests WHERE request_id='responding-request'").state,'outcome_unknown');assert.equal(f.one('SELECT state FROM pending_interactions').state,'cancelled');
  assert.equal(f.one('SELECT enabled FROM sources').enabled,0);assert.equal(f.one('SELECT state FROM subscriptions').state,'paused');assert.deepEqual(f.one("SELECT state,version,next_fire_at_ms FROM schedules WHERE schedule_id='schedule'"),{state:'paused',version:2,next_fire_at_ms:null});assert.equal(f.one('SELECT state FROM schedule_occurrences').state,'cancelled');assert.equal(f.one('SELECT state FROM trigger_deliveries').state,'ignored');assert.equal(f.one('SELECT state FROM outbox_events').state,'dead_letter');assert.equal(f.one("SELECT state FROM operations WHERE operation_id='queued-op'").state,'cancelled');assert.equal(f.one("SELECT state FROM operations WHERE operation_id='worktree-op'").state,'outcome_unknown');assert.equal(f.one('SELECT state FROM thread_bindings').state,'invalidated');assert.deepEqual(f.one('SELECT state,control_owner,control_epoch FROM computer_sessions'),{state:'revoking',control_owner:'none',control_epoch:3});assert.equal(f.one('SELECT status FROM goals').status,'paused');
});
test('any transactional failure rolls back watermarks, merged tombstones, all state and quarantine marker',t=>{
  const f=fixture(t);f.current.tombstones=[{sourceRef:'new-deletion',privacyEpoch:12,deletedAtMs:123}];f.db.exec("CREATE TRIGGER controlled_rehearsal_failure BEFORE UPDATE ON mandates BEGIN SELECT RAISE(ABORT,'CONTROLLED_REHEARSAL_FAILURE'); END;");const before=dump(f.db);assert.throws(()=>prepareRehearsalDatabase(f.file,f.current,'must-rollback'),/REHEARSAL_DATABASE_PREPARATION_FAILED/);assert.deepEqual(dump(f.db),before);assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='recovery_quarantine'").get(),undefined);assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('unknown corrupt state is rejected conservatively without changing it or leaving a marker',t=>{
  const f=fixture(t);f.db.exec("PRAGMA ignore_check_constraints=ON;UPDATE task_runs SET status='future-unrecognized';PRAGMA ignore_check_constraints=OFF;");assert.throws(()=>prepareRehearsalDatabase(f.file,f.current,'unknown-schema-state'),/INVALID_REHEARSAL_DATABASE/);assert.equal(f.one('SELECT status FROM task_runs').status,'future-unrecognized');assert.equal(f.one('SELECT runtime_epoch FROM runtime_owners').runtime_epoch,2);assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='recovery_quarantine'").get(),undefined);
});
test('terminal historical Run results are retained and a quarantine cannot be prepared a second time',t=>{
  const f=fixture(t);f.db.exec("UPDATE task_runs SET status='completed';UPDATE tasks SET status='completed' WHERE task_id='task';");const first=prepareRehearsalDatabase(f.file,f.current,'one-preparation');assert.equal(first.unknownRuns,0);assert.equal(f.one('SELECT status FROM task_runs').status,'completed');assert.equal(f.one("SELECT status FROM tasks WHERE task_id='task'").status,'completed');const before=dump(f.db);assert.throws(()=>prepareRehearsalDatabase(f.file,f.current,'second-preparation'),/REHEARSAL_ALREADY_QUARANTINED/);assert.deepEqual(dump(f.db),before);
});
test('wrong Profile/Dot, unsupported revision and nonfinite or exhausted watermarks are rejected',t=>{
  const f=fixture(t),before=dump(f.db);for(const current of [{...f.current,profileId:'foreign'},{...f.current,dotId:'foreign'},{...f.current,runtimeEpoch:Infinity},{...f.current,privacyEpoch:Number.MAX_SAFE_INTEGER},{...f.current,tombstones:[{sourceRef:'new',privacyEpoch:-1,deletedAtMs:1}]}])assert.throws(()=>prepareRehearsalDatabase(f.file,current,'refused'));assert.deepEqual(dump(f.db),before);
  f.db.exec("INSERT INTO profiles VALUES ('other-profile','Foreign',1);");assert.throws(()=>prepareRehearsalDatabase(f.file,f.current,'wrong-scope'),/REHEARSAL_SCOPE_MISMATCH/);f.db.exec("DELETE FROM profiles WHERE profile_id='other-profile';UPDATE schema_metadata SET schema_revision=99;");assert.throws(()=>prepareRehearsalDatabase(f.file,f.current,'wrong-revision'),/REHEARSAL_SCHEMA_UNSUPPORTED/);assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='recovery_quarantine'").get(),undefined);
});
test('missing, linked and oversized candidate files are rejected before a new database can be created',t=>{
  const f=fixture(t),missing=join(f.root,'missing.db');assert.throws(()=>prepareRehearsalDatabase(missing,f.current,'missing'));assert.equal(existsSync(missing),false);const link=join(f.root,'link.db');symlinkSync(f.file,link);assert.throws(()=>prepareRehearsalDatabase(link,f.current,'link'));const large=join(f.root,'large.db');writeFileSync(large,'public');truncateSync(large,128*1024*1024+1);assert.throws(()=>prepareRehearsalDatabase(large,f.current,'large'),/INVALID_REHEARSAL_DATABASE/);assert.equal(f.one('SELECT runtime_epoch FROM runtime_owners').runtime_epoch,2);
});
