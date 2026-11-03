import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {calendarBaseline,nextCron,previousCron,scheduleTime,validateCron} from '../../runtime/src/calendar.ts';
import type {ScheduleConfig,ScheduleView,OccurrenceView} from '../../contracts/src/schedules.ts';
type Row=Record<string,string|number|null>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ScheduledTask {taskId:string;projectId:string;version:number;status:string;blocked:boolean;active:boolean;authority:unknown;inputHash:string;mode:string}
export interface SchedulerHost {task:(projectId:string,taskId:string)=>ScheduledTask;event:(taskId:string,type:string,payload:unknown)=>void;transition:(taskId:string,status:'queued'|'waiting_trigger')=>void}
interface StoredSpec {contractVersion:1|2;config:ScheduleConfig;authority:unknown;inputHash:string;calendar:ReturnType<typeof calendarBaseline>;purpose:'queue_only'|'execute_readonly_once'}
export const scheduledRunKey=(triggerId:string)=>'scheduled-run:'+hash(triggerId);
/** Private collaborator. Every mutation is called inside the same ledger's Owner-checked transaction. */
export class SchedulerLedger {
 private db:DatabaseSync;private dotId:string;private fail:(code:string)=>never;private host:SchedulerHost;
 constructor(db:DatabaseSync,dotId:string,fail:(code:string)=>never,host:SchedulerHost){this.db=db;this.dotId=dotId;this.fail=fail;this.host=host;}
 private one(sql:string,...args:SQLInputValue[]){return this.db.prepare(sql).get(...args) as Row|undefined;}
 private all(sql:string,...args:SQLInputValue[]){return this.db.prepare(sql).all(...args) as Row[];}
 private exec(sql:string,...args:SQLInputValue[]){return this.db.prepare(sql).run(...args);}
 config(input:unknown):ScheduleConfig {
  if(!input||typeof input!=='object'||Array.isArray(input))return this.fail('INVALID_SCHEDULE_CONFIG');const c=input as ScheduleConfig;
  const fields=['kind','timezone',c.kind==='once'?'atMs':'expression','misfirePolicy','overlapPolicy','maxCatchUp',...('expiresAtMs'in c?['expiresAtMs']:[]),...('dispatchMode'in c?['dispatchMode']:[])];
  if(!['once','cron'].includes(c.kind)||Object.keys(c).length!==fields.length||!fields.every(k=>Object.hasOwn(c,k))||!['skip','coalesce','bounded_catch_up'].includes(c.misfirePolicy)||!['skip','coalesce'].includes(c.overlapPolicy)||!Number.isSafeInteger(c.maxCatchUp)||c.maxCatchUp<1||c.maxCatchUp>10)return this.fail('INVALID_SCHEDULE_CONFIG');
  const normalized=validateCron({expression:c.kind==='once'?'* * * * *':c.expression!,timezone:c.timezone});
  if(c.kind==='once'){scheduleTime(c.atMs);if(c.expiresAtMs===undefined||c.expiresAtMs<=c.atMs!||c.expiresAtMs-c.atMs!>86400000||c.maxCatchUp!==1)return this.fail('INVALID_ONCE_DEADLINE');}
  if(c.expiresAtMs!==undefined)scheduleTime(c.expiresAtMs);
  if(c.dispatchMode!==undefined&&!['queue_only','execute_readonly_once'].includes(c.dispatchMode)||c.dispatchMode==='execute_readonly_once'&&c.kind!=='once')return this.fail('SCHEDULE_EXECUTION_MODE_UNAVAILABLE');
  return{kind:c.kind,timezone:c.timezone,...(c.kind==='once'?{atMs:c.atMs!}:{expression:normalized.expression}),misfirePolicy:c.misfirePolicy,overlapPolicy:c.overlapPolicy,maxCatchUp:c.maxCatchUp,...(c.expiresAtMs===undefined?{}:{expiresAtMs:c.expiresAtMs}),...(c.dispatchMode===undefined?{}:{dispatchMode:c.dispatchMode})};
 }
 private row(projectId:string,scheduleId:string):Row {
  return this.one("SELECT s.*,t.workspace_id FROM schedules s JOIN tasks t USING(task_id) WHERE schedule_id=? AND t.workspace_id=? AND t.dot_id=? AND NOT EXISTS(SELECT 1 FROM privacy_tombstones p WHERE p.dot_id=t.dot_id AND p.source_ref IN (t.task_id,'task:'||t.task_id))",scheduleId,projectId,this.dotId)??this.fail('SCHEDULE_NOT_IN_PROJECT');
 }
 view(projectId:string,scheduleId:string):ScheduleView {
  const row=this.row(projectId,scheduleId),spec=JSON.parse(String(row.spec_json)) as StoredSpec,supported=spec?.contractVersion===1||spec?.contractVersion===2,claimed=this.one("SELECT run_id FROM task_events WHERE task_id=? AND event_type='scheduled_run_claimed' AND json_extract(payload_json,'$.scheduleId')=? AND json_extract(payload_json,'$.scheduleVersion')=? ORDER BY sequence DESC LIMIT 1",row.task_id!,scheduleId,row.version!),stopped=this.one("SELECT d.delivery_id FROM trigger_deliveries d JOIN schedule_occurrences o USING(trigger_id) WHERE o.schedule_id=? AND o.schedule_version=? AND d.reason_code LIKE 'AUTO_SKIPPED_%' LIMIT 1",scheduleId,row.version!);
  return{scheduleId,projectId,taskId:String(row.task_id),version:Number(row.version),state:row.state as ScheduleView['state'],config:supported?spec.config:null,requiresReplacement:!supported,nextFireAtMs:row.next_fire_at_ms===null?null:Number(row.next_fire_at_ms),dispatchState:spec?.purpose!=='execute_readonly_once'?'not_requested':claimed?'dispatched':stopped||row.state!=='active'?'stopped':'waiting',runId:claimed?.run_id as string|null??null};
 }
 list(projectId:string):ScheduleView[] {
  return this.all("SELECT s.schedule_id FROM schedules s JOIN tasks t USING(task_id) WHERE t.workspace_id=? AND t.dot_id=? AND NOT EXISTS(SELECT 1 FROM privacy_tombstones p WHERE p.dot_id=t.dot_id AND p.source_ref IN (t.task_id,'task:'||t.task_id)) ORDER BY s.rowid DESC LIMIT 100",projectId,this.dotId).map(r=>this.view(projectId,String(r.schedule_id)));
 }
 occurrences(projectId:string,scheduleId:string):OccurrenceView[] {
  this.row(projectId,scheduleId);return this.all('SELECT o.*,d.state AS delivery_state FROM schedule_occurrences o LEFT JOIN trigger_deliveries d ON d.trigger_id=o.trigger_id AND d.delivery_kind=\'wake\' WHERE schedule_id=? ORDER BY scheduled_at_ms DESC,o.rowid DESC LIMIT 100',scheduleId).map(r=>({occurrenceId:String(r.occurrence_id),scheduleId,version:Number(r.schedule_version),scheduledAtMs:Number(r.scheduled_at_ms),state:r.state as OccurrenceView['state'],triggerId:r.trigger_id as string|null,deliveryState:r.delivery_state as string|null}));
 }
 private next(c:ScheduleConfig,after:number):number|null {
  if(c.kind==='once')return null;
  try{return nextCron({expression:c.expression!,timezone:c.timezone},after);}catch(error){if(error instanceof Error&&error.message==='CRON_NO_OCCURRENCE')return null;throw error;}
 }
 create(projectId:string,taskId:string,expectedVersion:number,scheduleId:string,config:ScheduleConfig,now:number):ScheduleView {
  const task=this.host.task(projectId,taskId);if(task.version!==expectedVersion)return this.fail('TASK_VERSION_CONFLICT');if(task.status!=='queued'||task.blocked||task.active)return this.fail('TASK_NOT_SCHEDULABLE');
  if(this.one("SELECT schedule_id FROM schedules WHERE task_id=? AND state IN ('active','paused')",taskId))return this.fail('TASK_SCHEDULE_EXISTS');
  if(Number(this.one("SELECT COUNT(*) AS n FROM schedules s JOIN tasks t USING(task_id) WHERE t.dot_id=? AND s.state IN ('active','paused')",this.dotId)!.n)>=100)return this.fail('SCHEDULE_LIMIT');
  const next=config.kind==='once'?config.atMs!:this.next(config,now);if(next===null||next<=now||config.expiresAtMs!==undefined&&next>=config.expiresAtMs)return this.fail('SCHEDULE_HAS_NO_VALID_OCCURRENCE');
  if(config.dispatchMode==='execute_readonly_once'&&task.mode!=='readOnly')return this.fail('SCHEDULE_EXECUTION_MODE_UNAVAILABLE');
  const spec:StoredSpec={contractVersion:2,config,authority:task.authority,inputHash:task.inputHash,calendar:calendarBaseline(),purpose:config.dispatchMode??'queue_only'};
  this.exec("INSERT INTO schedules VALUES (?,?,1,?,?,?,'active',?,?,?,?,?)",scheduleId,taskId,config.kind,JSON.stringify(spec),config.timezone,config.misfirePolicy,config.overlapPolicy,config.maxCatchUp,next,config.expiresAtMs??null);
  this.host.transition(taskId,'waiting_trigger');this.host.event(taskId,'schedule_created',{scheduleId,version:1,nextFireAtMs:next,purpose:spec.purpose});return this.view(projectId,scheduleId);
 }
 private revoke(row:Row,state:'paused'|'cancelled'|'fulfilled',reason:string){
  this.exec('UPDATE schedules SET state=?,version=version+1,next_fire_at_ms=NULL WHERE schedule_id=?',state,row.schedule_id!);
  this.exec("UPDATE trigger_deliveries SET state='ignored',reason_code=? WHERE state IN ('pending','claimed') AND trigger_id IN (SELECT trigger_id FROM schedule_occurrences WHERE schedule_id=?)",reason,row.schedule_id!);
  this.exec("UPDATE schedule_occurrences SET state='cancelled' WHERE schedule_id=? AND (state IN ('pending','waiting_host') OR trigger_id IN (SELECT trigger_id FROM trigger_deliveries WHERE state='ignored' AND reason_code=?))",row.schedule_id!,reason);
  this.host.event(String(row.task_id),'schedule_stopped',{scheduleId:row.schedule_id,version:Number(row.version)+1,state,reason});
 }
 stopTask(taskId:string,state:'paused'|'cancelled'){
  for(const row of this.all("SELECT * FROM schedules WHERE task_id=? AND (state='active' OR (?='cancelled' AND state='paused'))",taskId,state))this.revoke(row,state,'TASK_'+state.toUpperCase());
 }
 control(projectId:string,scheduleId:string,expectedVersion:number,kind:'pause'|'cancel'|'resume'|'replace',config:ScheduleConfig|undefined,now:number):ScheduleView {
  const row=this.row(projectId,scheduleId);if(row.version!==expectedVersion)return this.fail('SCHEDULE_VERSION_CONFLICT');
  if(kind==='pause'||kind==='cancel'){if(!['active','paused'].includes(String(row.state)))return this.fail('SCHEDULE_NOT_EDITABLE');this.revoke(row,kind==='pause'?'paused':'cancelled','SCHEDULE_'+kind.toUpperCase());return this.view(projectId,scheduleId);}
  if(kind==='resume'&&row.state!=='paused'||kind==='replace'&&!['active','paused'].includes(String(row.state)))return this.fail('SCHEDULE_NOT_EDITABLE');
  const task=this.host.task(projectId,String(row.task_id));if(task.status!=='waiting_trigger'||task.blocked||task.active)return this.fail('TASK_NOT_SCHEDULABLE');
  const previous=JSON.parse(String(row.spec_json)) as StoredSpec;if(!config&&previous?.contractVersion!==1&&previous?.contractVersion!==2)return this.fail('SCHEDULE_CONTRACT_UNSUPPORTED');
  const c=config??previous.config,next=c.kind==='once'?c.atMs!:this.next(c,now);
  if(next===null||c.expiresAtMs!==undefined&&now>=c.expiresAtMs)return this.fail('SCHEDULE_HAS_NO_VALID_OCCURRENCE');
  if(kind==='replace'&&next<=now)return this.fail('SCHEDULE_HAS_NO_VALID_OCCURRENCE');
  if(c.dispatchMode==='execute_readonly_once'&&task.mode!=='readOnly')return this.fail('SCHEDULE_EXECUTION_MODE_UNAVAILABLE');
  this.revoke(row,'paused','SCHEDULE_VERSION_CHANGED');const spec:StoredSpec={contractVersion:2,config:c,authority:task.authority,inputHash:task.inputHash,calendar:calendarBaseline(),purpose:c.dispatchMode??'queue_only'};
  this.exec("UPDATE schedules SET kind=?,spec_json=?,timezone=?,state='active',misfire_policy=?,overlap_policy=?,max_catch_up=?,next_fire_at_ms=?,expires_at_ms=? WHERE schedule_id=?",c.kind,JSON.stringify(spec),c.timezone,c.misfirePolicy,c.overlapPolicy,c.maxCatchUp,next,c.expiresAtMs??null,scheduleId);
  this.host.event(task.taskId,'schedule_updated',{scheduleId,version:expectedVersion+1,nextFireAtMs:next});return this.view(projectId,scheduleId);
 }
 private occurrence(row:Row,at:number,state:'waiting_host'|'skipped'):string {
  const occurrenceId='occurrence:'+hash([row.schedule_id,row.version,at]);this.exec('INSERT OR IGNORE INTO schedule_occurrences VALUES (?,?,?,?,NULL,?)',occurrenceId,row.schedule_id!,row.version!,at,state);return occurrenceId;
 }
 private completeIdle(scheduleId:string){
  this.exec("UPDATE schedules SET state='fulfilled' WHERE schedule_id=? AND state='active' AND next_fire_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM schedule_occurrences o WHERE o.schedule_id=schedules.schedule_id AND o.state='waiting_host') AND NOT EXISTS(SELECT 1 FROM trigger_deliveries d JOIN schedule_occurrences o ON o.trigger_id=d.trigger_id WHERE o.schedule_id=schedules.schedule_id AND (d.state IN ('pending','claimed') OR (json_extract(schedules.spec_json,'$.purpose')='execute_readonly_once' AND d.state='acknowledged' AND (d.reason_code IS NULL OR d.reason_code LIKE 'AUTO_WAIT_%'))))",scheduleId);
 }
 private valid(row:Row):ScheduledTask {
  const task=this.host.task(String(row.workspace_id),String(row.task_id)),spec=JSON.parse(String(row.spec_json)) as StoredSpec;
  if(!spec||spec.contractVersion!==1&&spec.contractVersion!==2||!spec.calendar)return this.fail('SCHEDULE_CONTRACT_UNSUPPORTED');
  if(hash(spec.calendar)!==hash(calendarBaseline()))return this.fail('CALENDAR_BASELINE_CHANGED');
  if(spec.purpose!=='queue_only'&&(spec.contractVersion!==2||spec.purpose!=='execute_readonly_once'||spec.config.kind!=='once'||spec.config.dispatchMode!=='execute_readonly_once'||task.mode!=='readOnly')||hash(task.authority)!==hash(spec.authority)||task.inputHash!==spec.inputHash)return this.fail('SCHEDULE_AUTHORIZATION_CHANGED');return task;
 }
 private enqueue(row:Row,occurrenceId:string,now:number){
  const sourceId='internal-scheduler:'+this.dotId,binding='profile-internal-clock-v1:'+this.dotId;
  this.exec("INSERT OR IGNORE INTO sources VALUES (?,?,'scheduler',?,'{}',1)",sourceId,this.dotId,binding);
  const source=this.one('SELECT * FROM sources WHERE source_id=?',sourceId)!;if(source.dot_id!==this.dotId||source.kind!=='scheduler'||source.identity_binding_ref!==binding||source.enabled!==1)return this.fail('SCHEDULER_SOURCE_UNTRUSTED');
  const occurrence=this.one('SELECT * FROM schedule_occurrences WHERE occurrence_id=?',occurrenceId)!;if(occurrence.trigger_id)return;
  const triggerId='schedule-trigger:'+hash(occurrenceId),payload={scheduleId:row.schedule_id,version:row.version,scheduledAtMs:occurrence.scheduled_at_ms,taskId:row.task_id};
  this.exec('INSERT INTO incoming_triggers VALUES (?,?,?,?,?,?,?,?,?,?,?)',triggerId,sourceId,this.dotId,occurrenceId,row.schedule_id!,'internal-clock','scheduler-contract:'+hash(JSON.parse(String(row.spec_json))),occurrenceId,hash(payload),occurrence.scheduled_at_ms!,now);
  this.exec("INSERT INTO trigger_deliveries VALUES (?,?,?,?,'wake','pending',NULL)",randomUUID(),triggerId,row.task_id!,this.dotId);
  this.exec("UPDATE schedule_occurrences SET state='enqueued',trigger_id=? WHERE occurrence_id=?",triggerId,occurrenceId);
  this.host.event(String(row.task_id),'schedule_wake_enqueued',{occurrenceId,triggerId,scheduleId:row.schedule_id,version:row.version,scheduledAtMs:occurrence.scheduled_at_ms});
 }
 due(now:number):string[] {
  return this.all("SELECT s.schedule_id FROM schedules s JOIN tasks t USING(task_id) WHERE t.dot_id=? AND s.state='active' AND (s.next_fire_at_ms<=? OR EXISTS(SELECT 1 FROM schedule_occurrences o WHERE o.schedule_id=s.schedule_id AND o.state='waiting_host') OR s.expires_at_ms<=?) ORDER BY COALESCE(s.next_fire_at_ms,0),s.rowid LIMIT 20",this.dotId,now,now).map(r=>String(r.schedule_id));
 }
 tick(scheduleId:string,now:number):number {
  const row=this.one("SELECT s.*,t.workspace_id FROM schedules s JOIN tasks t USING(task_id) WHERE s.schedule_id=? AND t.dot_id=? AND s.state='active'",scheduleId,this.dotId);if(!row)return 0;
  let task:ScheduledTask;try{task=this.valid(row);}catch(error){if(error instanceof Error&&/^(TASK_AUTHORIZATION_CHANGED|GOAL_NOT_ACTIVE|PROJECT_UNAVAILABLE|PROJECT_IDENTITY_CHANGED|SCHEDULE_AUTHORIZATION_CHANGED|CALENDAR_BASELINE_CHANGED|SCHEDULE_CONTRACT_UNSUPPORTED)$/.test(error.message)){this.revoke(row,'paused',error.message);return 0;}throw error;}
  if(['completed','cancelled'].includes(task.status)){this.revoke(row,'cancelled','TASK_TERMINAL');return 0;}
  if(row.expires_at_ms!==null&&now>=Number(row.expires_at_ms)){if(row.kind==='once'&&row.next_fire_at_ms!==null&&Number(row.next_fire_at_ms)<=now)this.occurrence(row,Number(row.next_fire_at_ms),'skipped');this.revoke(row,'fulfilled','SCHEDULE_EXPIRED');return 0;}
  const spec=JSON.parse(String(row.spec_json)) as StoredSpec,c=spec.config,ready=task.status==='waiting_trigger'&&!task.active&&!task.blocked&&!this.one("SELECT delivery_id FROM trigger_deliveries WHERE task_id=? AND delivery_kind='wake' AND state IN ('pending','claimed')",task.taskId);
  let next=row.next_fire_at_ms===null?null:Number(row.next_fire_at_ms),processed=0;
  if(next!==null&&next<=now){
   let selected=next;
   if(c.kind==='cron'&&c.misfirePolicy!=='bounded_catch_up')selected=previousCron({expression:c.expression!,timezone:c.timezone},now);
   if(selected>next){this.occurrence(row,next,'skipped');this.host.event(task.taskId,'schedule_misfire_compacted',{scheduleId,version:row.version,skippedFromMs:next,skippedBeforeMs:selected,reason:c.misfirePolicy});}
   for(let n=0;n<c.maxCatchUp&&selected<=now;n++){
    const late=now-selected>=60000,candidate=this.occurrence(row,selected,c.misfirePolicy==='skip'&&late?'skipped':'waiting_host');processed++;
    if(!(c.misfirePolicy==='skip'&&late)){
     if(ready&&processed===1){this.exec("UPDATE schedule_occurrences SET state='skipped' WHERE schedule_id=? AND schedule_version=? AND state='waiting_host' AND occurrence_id<>?",scheduleId,row.version!,candidate);this.enqueue(row,candidate,now);}
     else if(c.overlapPolicy==='skip')this.exec("UPDATE schedule_occurrences SET state='skipped' WHERE occurrence_id=? AND state='waiting_host'",candidate);
     else this.exec("UPDATE schedule_occurrences SET state='skipped' WHERE schedule_id=? AND schedule_version=? AND state='waiting_host' AND occurrence_id<>?",scheduleId,row.version!,candidate);
    }
    next=this.next(c,selected);if(c.misfirePolicy!=='bounded_catch_up'||next===null||next>now)break;selected=next;
   }
   this.exec('UPDATE schedules SET next_fire_at_ms=? WHERE schedule_id=?',next,scheduleId);
  }
  if(ready&&!processed){const held=this.one("SELECT occurrence_id FROM schedule_occurrences WHERE schedule_id=? AND schedule_version=? AND state='waiting_host' ORDER BY scheduled_at_ms DESC LIMIT 1",scheduleId,row.version!);if(held)this.enqueue(row,String(held.occurrence_id),now);}
  this.completeIdle(scheduleId);
  return processed;
 }
 deliver(now:number):number {
  let delivered=0;
  for(const row of this.all("SELECT d.delivery_id,d.trigger_id,d.task_id AS delivery_task_id,src.source_id AS actual_source,src.identity_binding_ref AS actual_binding,src.enabled AS source_enabled,o.occurrence_id,o.schedule_version,s.*,t.workspace_id FROM trigger_deliveries d JOIN incoming_triggers i USING(trigger_id) JOIN sources src ON src.source_id=i.source_id JOIN schedule_occurrences o ON o.trigger_id=i.trigger_id JOIN schedules s USING(schedule_id) JOIN tasks t ON t.task_id=s.task_id WHERE d.dot_id=? AND d.state='pending' AND d.delivery_kind='wake' AND src.kind='scheduler' ORDER BY i.received_at_ms,d.rowid LIMIT 20",this.dotId)){
   let reason:string|undefined,task:ScheduledTask|undefined;
   if(row.actual_source!=='internal-scheduler:'+this.dotId||row.actual_binding!=='profile-internal-clock-v1:'+this.dotId||row.source_enabled!==1||row.delivery_task_id!==row.task_id)reason='SCHEDULER_SOURCE_UNTRUSTED';
   else if(row.schedule_version!==row.version||!['active','fulfilled'].includes(String(row.state))||row.expires_at_ms!==null&&now>=Number(row.expires_at_ms))reason='SCHEDULE_REVOKED';
   else try{task=this.valid(row);}catch(error){if(error instanceof Error&&/^(TASK_AUTHORIZATION_CHANGED|GOAL_NOT_ACTIVE|PROJECT_UNAVAILABLE|PROJECT_IDENTITY_CHANGED|SCHEDULE_AUTHORIZATION_CHANGED|CALENDAR_BASELINE_CHANGED|SCHEDULE_CONTRACT_UNSUPPORTED)$/.test(error.message))reason=error.message;else throw error;}
   if(reason){this.exec("UPDATE trigger_deliveries SET state='ignored',reason_code=? WHERE delivery_id=?",reason,row.delivery_id!);this.exec("UPDATE schedule_occurrences SET state='cancelled' WHERE occurrence_id=?",row.occurrence_id!);this.completeIdle(String(row.schedule_id));continue;}
   if(task!.status!=='waiting_trigger'||task!.blocked||task!.active)continue;
   this.host.transition(task!.taskId,'queued');this.exec("UPDATE trigger_deliveries SET state='acknowledged' WHERE delivery_id=?",row.delivery_id!);this.host.event(task!.taskId,'schedule_wake_applied',{scheduleId:row.schedule_id,occurrenceId:row.occurrence_id,triggerId:row.trigger_id,purpose:'queue_only'});this.completeIdle(String(row.schedule_id));delivered++;
  }return delivered;
 }
 autoCandidates():Array<{projectId:string;triggerId:string}> {
  return this.all("SELECT d.trigger_id,t.workspace_id FROM trigger_deliveries d JOIN schedule_occurrences o USING(trigger_id) JOIN schedules s USING(schedule_id) JOIN tasks t ON t.task_id=s.task_id WHERE d.dot_id=? AND d.state='acknowledged' AND d.delivery_kind='wake' AND s.state='active' AND s.version=o.schedule_version AND json_extract(s.spec_json,'$.purpose')='execute_readonly_once' AND (d.reason_code IS NULL OR d.reason_code LIKE 'AUTO_WAIT_%') AND NOT EXISTS(SELECT 1 FROM task_events e WHERE e.task_id=s.task_id AND e.event_type='scheduled_run_claimed' AND json_extract(e.payload_json,'$.triggerId')=d.trigger_id) ORDER BY d.rowid LIMIT 100",this.dotId).map(row=>({projectId:String(row.workspace_id),triggerId:String(row.trigger_id)}));
 }
 private dispatchRow(projectId:string,triggerId:string):Row {
  return this.one("SELECT s.*,t.workspace_id,d.task_id AS delivery_task_id,d.state AS delivery_state,d.reason_code,d.delivery_id,o.schedule_version,o.scheduled_at_ms,o.occurrence_id,i.source_id,i.verification_ref,src.identity_binding_ref,src.enabled AS source_enabled FROM trigger_deliveries d JOIN incoming_triggers i USING(trigger_id) JOIN sources src USING(source_id) JOIN schedule_occurrences o USING(trigger_id) JOIN schedules s USING(schedule_id) JOIN tasks t ON t.task_id=s.task_id WHERE d.trigger_id=? AND d.dot_id=? AND t.workspace_id=? AND d.delivery_kind='wake'",triggerId,this.dotId,projectId)??this.fail('SCHEDULE_TRIGGER_NOT_IN_PROJECT');
 }
 admission(projectId:string,triggerId:string,now:number){
  const row=this.dispatchRow(projectId,triggerId),task=this.valid(row),spec=JSON.parse(String(row.spec_json)) as StoredSpec;
  if(spec.purpose!=='execute_readonly_once'||spec.contractVersion!==2||row.delivery_task_id!==task.taskId||row.delivery_state!=='acknowledged'||row.schedule_version!==row.version||row.state!=='active'||row.reason_code!==null&&!String(row.reason_code).startsWith('AUTO_WAIT_'))return this.fail('SCHEDULE_DISPATCH_REVOKED');
  if(row.source_id!=='internal-scheduler:'+this.dotId||row.identity_binding_ref!=='profile-internal-clock-v1:'+this.dotId||row.source_enabled!==1||row.verification_ref!=='scheduler-contract:'+hash(spec))return this.fail('SCHEDULER_SOURCE_UNTRUSTED');
  if(row.expires_at_ms===null||now>=Number(row.expires_at_ms)||now<Number(row.scheduled_at_ms))return this.fail('SCHEDULE_DISPATCH_EXPIRED');
  const receipt=this.one("SELECT task_version FROM task_events WHERE task_id=? AND event_type='schedule_wake_applied' AND json_extract(payload_json,'$.triggerId')=?",task.taskId,triggerId)??this.fail('SCHEDULE_WAKE_UNCONFIRMED');
  if(task.version!==receipt.task_version)return this.fail('TASK_VERSION_CONFLICT');if(task.status!=='queued'||task.active||task.blocked)return this.fail('TASK_NOT_DISPATCHABLE');
  return{taskId:task.taskId,expectedVersion:Number(receipt.task_version),submissionKey:scheduledRunKey(triggerId),scheduleId:String(row.schedule_id),scheduleVersion:Number(row.version),occurrenceId:String(row.occurrence_id),inputHash:task.inputHash};
 }
 claimed(projectId:string,triggerId:string){const row=this.dispatchRow(projectId,triggerId);this.exec("UPDATE trigger_deliveries SET reason_code='AUTO_DISPATCHED' WHERE delivery_id=?",row.delivery_id!);this.completeIdle(String(row.schedule_id));}
 dispatchWait(projectId:string,triggerId:string,code:string){
  if(!/^[A-Z0-9_]{1,100}$/.test(code))return this.fail('INVALID_DIAGNOSTIC');const row=this.dispatchRow(projectId,triggerId);
  if(this.one("SELECT event_id FROM task_events WHERE task_id=? AND event_type='scheduled_run_claimed' AND json_extract(payload_json,'$.triggerId')=?",row.task_id!,triggerId))return;
  const temporary=['RUNTIME_BUSY','TOKEN_BUDGET_EXHAUSTED','COST_ESTIMATE_UNAVAILABLE','WORKSPACE_BUSY','WORKSPACE_TERMINAL_ACTIVE'].includes(code),reason=(temporary?'AUTO_WAIT_':'AUTO_SKIPPED_')+code;
  if(row.reason_code===reason)return;this.exec('UPDATE trigger_deliveries SET reason_code=? WHERE delivery_id=?',reason,row.delivery_id!);this.host.event(String(row.task_id),temporary?'schedule_dispatch_waiting':'schedule_dispatch_stopped',{scheduleId:row.schedule_id,triggerId,code});this.completeIdle(String(row.schedule_id));
 }
}
