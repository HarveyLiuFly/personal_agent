import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';

type Row=Record<string,string|number|null>;
export type MemoryTrust='explicit_user'|'verified_connector'|'agent_inference'|'untrusted_external';
export type MemorySensitivity='public'|'private'|'sensitive';
export interface MemoryHost {transaction:<T>(body:()=>T)=>T;owner:()=>void}
export interface MemoryEntrySnapshot {entryId:string;sourceRef:string;sourceRevision:string;contentHash:string;privacyEpoch:number;policyEpoch:number;trust:'agent_inference'|'untrusted_external'}
export interface MemoryClaimInput {entryId:string;expectedPrivacyEpoch:number;expectedPolicyEpoch:number;factKey:string;factText:string;quote:string;trust:MemoryTrust;supersedesClaimId?:string;expectedVersion?:number;validFromMs?:number;validUntilMs?:number}
export interface MemoryClaimView {claimId:string;factKey:string;factText:string;status:string;trust:MemoryTrust;version:number;privacyEpoch:number;validFromMs:number|null;validUntilMs:number|null;revisionSourceRefs:string[];evidence:Array<{entryId:string;sourceRef:string;sourceRevision:string;quoteHash:string}>}
export interface MemoryContextClaim extends MemoryClaimView {domain:'personal'|'task'|'coding';sensitivity:MemorySensitivity;taskId?:string}
export interface MemoryForgetResult {privacyEpoch:number;policyEpoch:number;affectedRefs:string[];blockedRunIds:string[];artifactKeys:string[];scrubbedEntries:number;scrubbedClaims:number;databaseCompactionRequired:boolean;externalCopies:'not_controlled'}
interface SourceRevision {kind:'user_message'|'external';revision:string;messageHash?:string;sourceId?:string;identityHash?:string;cursorHash?:string}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const encoded=(value:unknown)=>hash(JSON.stringify(value));
const controls=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const text=(value:unknown,max=200):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!controls.test(value);
const identifier=(value:unknown):value is string=>text(value)&&!/[\s/\\]/.test(value);
const sensitivities=['public','private','sensitive'];
const one=(db:DatabaseSync,sql:string,...args:SQLInputValue[])=>db.prepare(sql).get(...args) as Row|undefined;
const all=(db:DatabaseSync,sql:string,...args:SQLInputValue[])=>db.prepare(sql).all(...args) as Row[];
const run=(db:DatabaseSync,sql:string,...args:SQLInputValue[])=>db.prepare(sql).run(...args);
const refParts=(ref:string)=>{const at=ref.indexOf(':');return{kind:ref.slice(0,at),id:ref.slice(at+1)};};
const tables:Record<string,{table:string;key:string;dot?:string}>={message:{table:'messages',key:'message_id',dot:'dot_id'},entry:{table:'memory_entries',key:'entry_id',dot:'dot_id'},claim:{table:'memory_claims',key:'claim_id',dot:'dot_id'},task:{table:'tasks',key:'task_id',dot:'dot_id'},goal:{table:'goals',key:'goal_id',dot:'dot_id'},source:{table:'sources',key:'source_id',dot:'dot_id'},artifact:{table:'artifacts',key:'artifact_id',dot:'dot_id'},episode:{table:'episodes',key:'episode_id'},checkpoint:{table:'task_checkpoints',key:'checkpoint_id'},manifest:{table:'prompt_manifests',key:'manifest_id'},thread:{table:'thread_bindings',key:'binding_id'},notification:{table:'operations',key:'operation_id'},operation:{table:'operations',key:'operation_id'},decision:{table:'router_decisions',key:'decision_id'}};
function rowFor(db:DatabaseSync,ref:string):Row|undefined {const p=refParts(ref),table=tables[p.kind];if(!table)return;return one(db,`SELECT * FROM ${table.table} WHERE ${table.key}=?`,p.id)??(p.kind==='manifest'?one(db,'SELECT * FROM prompt_manifests WHERE run_id=?',p.id):p.kind==='thread'?one(db,'SELECT * FROM thread_bindings WHERE execution_thread_id=?',p.id):undefined);}
function rowDot(db:DatabaseSync,ref:string,row:Row):string|undefined {
 const p=refParts(ref);if(tables[p.kind]?.dot)return String(row.dot_id);
 if(p.kind==='episode')return one(db,'SELECT dot_id FROM conversations WHERE conversation_id=?',row.conversation_id!)?.dot_id as string|undefined;
 if(p.kind==='manifest')return one(db,'SELECT dot_id FROM task_runs WHERE run_id=?',row.run_id!)?.dot_id as string|undefined;
 if(p.kind==='decision')return one(db,'SELECT dot_id FROM messages WHERE message_id=?',row.message_id!)?.dot_id as string|undefined;
 if(p.kind==='notification'||p.kind==='operation')return one(db,'SELECT m.dot_id FROM router_decisions d JOIN messages m USING(message_id) WHERE d.decision_id=?',row.decision_id!)?.dot_id as string|undefined;
 if(['checkpoint','thread'].includes(p.kind))return one(db,'SELECT dot_id FROM tasks WHERE task_id=?',row.task_id!)?.dot_id as string|undefined;
 return undefined;
}
function revoked(db:DatabaseSync,dotId:string,ref:string):boolean {return Boolean(one(db,'SELECT source_ref FROM privacy_tombstones WHERE dot_id=? AND source_ref=?',dotId,ref));}

/** Reapply protected deletion records to an exclusively held candidate/live transaction.
 * Does not create an Owner or erase a process/lease fact. Physical files are the
 * Host's responsibility; returned keys are never interpreted as filesystem paths.
 */
export function applyMemoryTombstones(db:DatabaseSync,dotId:string,fail:(code:string)=>never):MemoryForgetResult {
 if(!db.isTransaction)return fail('MEMORY_TRANSACTION_REQUIRED');
 const epochs=one(db,'SELECT policy_epoch,privacy_epoch FROM dots WHERE dot_id=?',dotId)??fail('MEMORY_DOT_UNAVAILABLE');
 const initial=all(db,'SELECT source_ref FROM privacy_tombstones WHERE dot_id=?',dotId).map(r=>String(r.source_ref));
 if(initial.length>10000)return fail('MEMORY_DERIVATION_LIMIT');
 const affected=new Set(initial),queue=[...initial];
 const add=(ref:string)=>{if(!affected.has(ref)){if(affected.size>=10000)fail('MEMORY_DERIVATION_LIMIT');affected.add(ref);queue.push(ref);}};
 for(const ref of initial)for(const [table,key,kind] of [['tasks','task_id','task'],['messages','message_id','message']] as const)if(one(db,`SELECT ${key} FROM ${table} WHERE ${key}=? AND dot_id=?`,ref,dotId))add(kind+':'+ref);
 for(let index=0;index<queue.length;index++){
  const ref=queue[index]!,p=refParts(ref),row=rowFor(db,ref);if(row&&rowDot(db,ref,row)!==dotId)continue;
  for(const edge of all(db,'SELECT derived_ref FROM derivation_edges WHERE dot_id=? AND source_ref=?',dotId,ref))add(String(edge.derived_ref));
  for(const entry of all(db,'SELECT entry_id FROM memory_entries WHERE dot_id=? AND source_ref=?',dotId,ref))add('entry:'+entry.entry_id);
  if(p.kind==='message'){
   for(const e of all(db,'SELECT e.episode_id FROM episode_message_links e JOIN episodes p USING(episode_id) JOIN conversations c USING(conversation_id) WHERE e.message_id=? AND c.dot_id=?',p.id,dotId))add('episode:'+e.episode_id);
   for(const c of all(db,'SELECT c.claim_id FROM claim_evidence e JOIN memory_claims c USING(claim_id) WHERE e.source_message_id=? AND c.dot_id=?',p.id,dotId))add('claim:'+c.claim_id);
   for(const t of all(db,'SELECT task_id FROM message_task_links WHERE message_id=? AND dot_id=?',p.id,dotId))add('task:'+t.task_id);
   for(const decision of all(db,'SELECT decision_id FROM router_decisions WHERE message_id=?',p.id))add('decision:'+decision.decision_id);
  }
  if(p.kind==='entry'){if(row){add(String(row.source_ref));try{const revision=JSON.parse(String(row.source_revision));if(revision.kind==='external'&&typeof revision.sourceId==='string')add('source:'+revision.sourceId);}catch{}}for(const c of all(db,'SELECT c.claim_id FROM claim_evidence e JOIN memory_claims c USING(claim_id) WHERE e.entry_id=? AND c.dot_id=?',p.id,dotId))add('claim:'+c.claim_id);}
  if(p.kind==='source')for(const e of all(db,"SELECT entry_id FROM memory_entries WHERE dot_id=? AND json_valid(source_revision) AND json_extract(source_revision,'$.kind')='external' AND json_extract(source_revision,'$.sourceId')=?",dotId,p.id))add('entry:'+e.entry_id);
  if(p.kind==='claim'){for(const c of all(db,'SELECT claim_id FROM memory_claims WHERE supersedes_claim_id=? AND dot_id=?',p.id,dotId))add('claim:'+c.claim_id);for(const e of all(db,'SELECT entry_id FROM claim_evidence WHERE claim_id=? AND entry_id IS NOT NULL',p.id))add('entry:'+e.entry_id);}
  if(p.kind==='task'&&row){
   // Desktop commands keep their own audit Message rather than a message_task_link.
   for(const op of all(db,'SELECT operation_id FROM operations WHERE task_id=? UNION SELECT operation_id FROM task_runs WHERE task_id=? AND dot_id=? AND operation_id IS NOT NULL',p.id,p.id,dotId))add('operation:'+op.operation_id);
   for(const m of all(db,'SELECT message_id FROM message_task_links WHERE task_id=? AND dot_id=?',p.id,dotId))add('message:'+m.message_id);
   for(const e of all(db,'SELECT checkpoint_id FROM task_checkpoints WHERE task_id=?',p.id))add('checkpoint:'+e.checkpoint_id);
   for(const m of all(db,'SELECT m.manifest_id FROM prompt_manifests m JOIN task_runs r USING(run_id) WHERE r.task_id=? AND r.dot_id=?',p.id,dotId))add('manifest:'+m.manifest_id);
   for(const a of all(db,'SELECT artifact_id FROM artifacts WHERE task_id=? AND dot_id=?',p.id,dotId))add('artifact:'+a.artifact_id);
   for(const b of all(db,'SELECT binding_id FROM thread_bindings WHERE task_id=?',p.id))add('thread:'+b.binding_id);
   if(row.goal_id)add('goal:'+row.goal_id);
  }
  if(p.kind==='goal'&&row){for(const t of all(db,'SELECT task_id FROM tasks WHERE goal_id=? AND dot_id=?',p.id,dotId))add('task:'+t.task_id);for(const op of all(db,"SELECT o.operation_id FROM operations o JOIN router_decisions d USING(decision_id) JOIN messages m USING(message_id) WHERE m.dot_id=? AND (json_extract(o.input_json,'$.goalId')=? OR CASE WHEN json_valid(o.result_ref) THEN json_extract(o.result_ref,'$.goal.goalId') END=?)",dotId,p.id,p.id))add('operation:'+op.operation_id);}
  if(p.kind==='manifest'&&row){if(p.id!==row.manifest_id)add('manifest:'+row.manifest_id);if(row.rendered_artifact_id)add('artifact:'+row.rendered_artifact_id);const task=one(db,'SELECT task_id FROM task_runs WHERE run_id=? AND dot_id=?',row.run_id!,dotId);if(task)add('task:'+task.task_id);}
  if(p.kind==='thread'&&row&&p.id!==row.binding_id)add('thread:'+row.binding_id);
  if(['checkpoint','thread'].includes(p.kind)&&row)add('task:'+row.task_id);
  if(p.kind==='artifact'&&row?.task_id)add('task:'+row.task_id);
  if((p.kind==='notification'||p.kind==='operation')&&row){add('operation:'+row.operation_id);if(row.kind==='GOAL_NOTIFICATION')add('notification:'+row.operation_id);if(row.task_id)add('task:'+row.task_id);add('decision:'+row.decision_id);}
  if(p.kind==='decision'&&row){add('message:'+row.message_id);for(const operation of all(db,'SELECT operation_id FROM operations WHERE decision_id=?',p.id))add('operation:'+operation.operation_id);}
 }
 // Persist the whole invalidation closure: it survives graph rebuilding and old backups.
 const now=Date.now();for(const ref of affected)run(db,'INSERT INTO privacy_tombstones VALUES (?,?,?,?) ON CONFLICT(dot_id,source_ref) DO NOTHING',dotId,ref,epochs.privacy_epoch!,now);
 const artifactKeys=new Set<string>(),blockedRunIds=new Set<string>();let scrubbedEntries=0,scrubbedClaims=0;
 for(const ref of affected){
  const p=refParts(ref),row=rowFor(db,ref);if(!row||rowDot(db,ref,row)!==dotId)continue;
  switch(p.kind){
   case'decision':run(db,"UPDATE router_decisions SET candidate_snapshot_json='[]',decision_json='{}' WHERE decision_id=?",p.id);break;
   case'message':{
    const operationCopy=one(db,'SELECT o.operation_id FROM operations o JOIN router_decisions d USING(decision_id) WHERE d.message_id=?',p.id);
    run(db,"UPDATE messages SET content='',content_hash=?,deleted_at_ms=coalesce(deleted_at_ms,?) WHERE message_id=? AND dot_id=?",operationCopy?row.content_hash!:hash(''),now,p.id,dotId);run(db,"UPDATE router_decisions SET candidate_snapshot_json='[]',decision_json='{}' WHERE message_id=?",p.id);run(db,"UPDATE pending_interactions SET options_json='{}',state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE origin_message_id=? AND dot_id=?",p.id,dotId);run(db,'UPDATE focus_states SET focused_task_id=NULL,established_by_message_id=NULL,revision=revision+1 WHERE established_by_message_id=? AND dot_id=?',p.id,dotId);break;
   }
   // Clearing our local copy does not retract a delivered notification or
   // manufacture a transport outcome. The Host separately revokes dispatch.
   case'notification':case'operation':{
    if(row.kind==='GOAL_NOTIFICATION'){
     // Keep transport facts and the original stable input hash. Forgetting a
     // local summary neither retracts a delivery nor authorizes a second send.
     const input=JSON.parse(String(row.input_json)),prior=row.result_ref?JSON.parse(String(row.result_ref)):{providerRef:null},state=row.state==='executing'?'outcome_unknown':['pending','blocked'].includes(String(row.state))?'cancelled':String(row.state);
     const retained={goalId:input.goalId,key:input.key,kind:input.kind,privacyEpoch:input.privacyEpoch,summary:'',sourceRefs:[],redacted:true},receipt={...Object.fromEntries(['claimId','runtimeEpoch','day','providerRef'].filter(key=>Object.hasOwn(prior,key)).map(key=>[key,prior[key]])),state:state==='outcome_unknown'?'unknown':state==='cancelled'?'cancelled':state==='completed'?'delivered':state==='failed'?'failed':prior.state,providerRef:prior.providerRef??null};
     run(db,'UPDATE operations SET input_json=?,result_ref=?,state=? WHERE operation_id=?',JSON.stringify(retained),JSON.stringify(receipt),state,p.id);
    }else run(db,"UPDATE operations SET input_json='{}',result_ref=NULL,state=CASE WHEN state IN ('pending','blocked') THEN 'cancelled' WHEN state='executing' THEN 'outcome_unknown' ELSE state END WHERE operation_id=?",p.id);
    break;
   }
   case'entry':scrubbedEntries+=Number(run(db,"UPDATE memory_entries SET content='',content_hash=?,deleted_at_ms=coalesce(deleted_at_ms,?) WHERE entry_id=? AND dot_id=? AND (deleted_at_ms IS NULL OR content<>'')",hash(''),now,p.id,dotId).changes);break;
   case'claim':scrubbedClaims+=Number(run(db,"UPDATE memory_claims SET fact_key='deleted',fact_text='',status='deleted',version=version+1,privacy_epoch=? WHERE claim_id=? AND dot_id=? AND (status<>'deleted' OR fact_text<>'')",epochs.privacy_epoch!,p.id,dotId).changes);break;
   case'episode':run(db,"UPDATE episodes SET title='',summary='',dirty=1,privacy_epoch=?,source_digest=?,version=version+1 WHERE episode_id=?",epochs.privacy_epoch!,hash(''),p.id);break;
   case'checkpoint':run(db,"UPDATE task_checkpoints SET summary_json='{}',content_sha256=?,privacy_epoch=? WHERE checkpoint_id=?",hash(''),epochs.privacy_epoch!,p.id);break;
   case'manifest':run(db,"UPDATE prompt_manifests SET module_hashes_json='{}',context_refs_json='[]',rendered_artifact_id=NULL,privacy_epoch=?,policy_epoch=? WHERE manifest_id=?",epochs.privacy_epoch!,epochs.policy_epoch!,row.manifest_id!);break;
   case'artifact':if(row.state!=='deleted'){artifactKeys.add(String(row.relative_storage_key));run(db,"UPDATE artifacts SET state='deleting',privacy_epoch=? WHERE artifact_id=? AND dot_id=?",epochs.privacy_epoch!,p.id,dotId);}break;
   case'thread':run(db,"UPDATE thread_bindings SET state='invalidated',rollover_reason='privacy_forget' WHERE binding_id=?",row.binding_id!);break;
   case'source':run(db,"UPDATE sources SET enabled=0,cursor_json='{}' WHERE source_id=? AND dot_id=?",p.id,dotId);break;
   case'goal':run(db,"UPDATE goals SET title='已遗忘目标',objective='',constraints_json='{}',criteria_json='[]',status=CASE WHEN status='active' THEN 'paused' ELSE status END,version=version+1,plan_version=plan_version+1 WHERE goal_id=? AND dot_id=?",p.id,dotId);break;
   case'task':{
    for(const r of all(db,"SELECT run_id FROM task_runs WHERE task_id=? AND dot_id=? AND status IN ('preparing','submitting','running','waiting_input','waiting_approval','outcome_unknown')",p.id,dotId))blockedRunIds.add(String(r.run_id));
    const constraints=JSON.parse(String(row.constraints_json));
    run(db,"UPDATE tasks SET title='已遗忘任务',summary='',constraints_json=?,criteria_json='[]',dispatch_blocked=1,version=version+1,status=CASE WHEN status IN ('created','queued','waiting_trigger') THEN 'paused' ELSE status END WHERE task_id=? AND dot_id=?",JSON.stringify({mode:constraints.mode==='workspaceWrite'?'workspaceWrite':'readOnly',privacyRevoked:true}),p.id,dotId);
    run(db,"UPDATE task_events SET payload_json='{}' WHERE task_id=?",p.id);
    run(db,"UPDATE operations SET input_json='{}',result_ref=NULL,state=CASE WHEN state IN ('pending','blocked') THEN 'cancelled' WHEN state='executing' THEN 'outcome_unknown' ELSE state END WHERE task_id=? AND kind<>'GOAL_NOTIFICATION'",p.id);
    run(db,"UPDATE mandates SET state='revoked' WHERE task_id=? AND state='active'",p.id);
    run(db,"UPDATE subscriptions SET state='cancelled' WHERE task_id=? AND state<>'cancelled'",p.id);
    run(db,"UPDATE schedules SET state='paused',version=version+1,next_fire_at_ms=NULL WHERE task_id=? AND state='active'",p.id);
    run(db,"UPDATE schedule_occurrences SET state='cancelled' WHERE schedule_id IN(SELECT schedule_id FROM schedules WHERE task_id=?) AND state IN ('pending','waiting_host','enqueued')",p.id);
    run(db,"UPDATE trigger_deliveries SET state='ignored',reason_code='PRIVACY_REVOKED' WHERE task_id=? AND state IN ('pending','claimed')",p.id);
    run(db,"UPDATE approval_receipts SET state='revoked',uses_remaining=0 WHERE state='granted' AND action_id IN(SELECT action_id FROM actions WHERE task_id=?)",p.id);
    run(db,"UPDATE actions SET canonical_payload_json='{}',payload_hash=?,status=CASE WHEN status IN ('prepared','awaiting_approval','approved') THEN 'rejected' WHEN status IN ('reserved','dispatched') THEN 'outcome_unknown' ELSE status END WHERE task_id=?",hash('{}'),p.id);
    run(db,"UPDATE execution_intents SET state=CASE WHEN state='prepared' THEN 'rejected' WHEN state='sending' THEN 'outcome_unknown' ELSE state END WHERE run_id IN(SELECT run_id FROM task_runs WHERE task_id=?)",p.id);
    run(db,"UPDATE runtime_requests SET payload_json='{}',state=CASE WHEN state='pending' THEN 'expired' WHEN state='responding' THEN 'outcome_unknown' ELSE state END WHERE run_id IN(SELECT run_id FROM task_runs WHERE task_id=?)",p.id);
    run(db,"UPDATE pending_interactions SET options_json='{}',state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE task_id=?",p.id);
    run(db,"UPDATE pending_interactions SET options_json='{}',state=CASE WHEN state='pending' THEN 'cancelled' ELSE state END WHERE dot_id=? AND EXISTS(SELECT 1 FROM json_each(pending_interactions.options_json,'$.choices') c WHERE json_extract(c.value,'$.taskId')=?)",dotId,p.id);
    run(db,"UPDATE outbox_events SET payload_json='{}',state=CASE WHEN state IN ('pending','claimed') THEN 'dead_letter' ELSE state END,lease_until_ms=NULL WHERE aggregate_ref=?",p.id);
    break;
   }
  }
 }
 // Feed is a rebuildable local cache; invalidate all Dot projections conservatively.
 run(db,'DELETE FROM main_feed WHERE conversation_id IN(SELECT conversation_id FROM conversations WHERE dot_id=?)',dotId);
 return{privacyEpoch:Number(epochs.privacy_epoch),policyEpoch:Number(epochs.policy_epoch),affectedRefs:[...affected],blockedRunIds:[...blockedRunIds],artifactKeys:[...artifactKeys],scrubbedEntries,scrubbedClaims,databaseCompactionRequired:affected.size>0,externalCopies:'not_controlled'};
}

/** Private same-database collaborator. The Host supplies its existing Owner and
 * short transaction; no second database, executor or trusted IPC surface exists.
 */
export class MemoryLedger {
 private db:DatabaseSync;private dotId:string;private fail:(code:string)=>never;private host:MemoryHost;
 constructor(db:DatabaseSync,dotId:string,fail:(code:string)=>never,host:MemoryHost){this.db=db;this.dotId=dotId;this.fail=fail;this.host=host;this.db.exec('PRAGMA secure_delete=ON');}
 private atomic<T>(body:()=>T):T{return this.host.transaction(()=>{this.host.owner();return body();});}
 private epochs(){const r=one(this.db,'SELECT policy_epoch,privacy_epoch FROM dots WHERE dot_id=?',this.dotId)??this.fail('MEMORY_DOT_UNAVAILABLE');return{policyEpoch:Number(r.policy_epoch),privacyEpoch:Number(r.privacy_epoch)};}
 private guard(privacy:number,policy:number){const e=this.epochs();if(!Number.isSafeInteger(privacy)||!Number.isSafeInteger(policy)||privacy!==e.privacyEpoch||policy!==e.policyEpoch)this.fail('MEMORY_SOURCE_CHANGED');return e;}
 private scope(ref:string):Row|undefined {const row=rowFor(this.db,ref);if(row&&rowDot(this.db,ref,row)!==this.dotId)this.fail('MEMORY_SCOPE_MISMATCH');return row;}
 private alive(ref:string):boolean {
  if(revoked(this.db,this.dotId,ref))return false;
  const row=this.scope(ref),p=refParts(ref);if(p.kind==='message')return Boolean(row&&row.deleted_at_ms===null);
  if(p.kind==='source')return row?.enabled===1;
  if(p.kind==='task')return Boolean(row&&!revoked(this.db,this.dotId,p.id));
  if(p.kind==='entry')return Boolean(row&&row.deleted_at_ms===null);
  if(p.kind==='claim')return Boolean(row&&row.status!=='deleted'&&row.status!=='expired');
  return Boolean(row)||p.kind==='external'||p.kind==='context';
 }
 private entry(entryId:string):Row {
  const row=this.scope('entry:'+entryId)??this.fail('MEMORY_ENTRY_UNAVAILABLE');
  if(!this.alive('entry:'+entryId)||!this.alive(String(row.source_ref)))return this.fail('MEMORY_SOURCE_REVOKED');
  let revision:SourceRevision;try{revision=JSON.parse(String(row.source_revision)) as SourceRevision;}catch{return this.fail('MEMORY_SOURCE_CHANGED');}
  if(revision.kind==='user_message'){
   const message=this.scope(String(row.source_ref)),decision=message?one(this.db,'SELECT router_revision FROM router_decisions WHERE message_id=?',message.message_id!):undefined;if(!message||message.role!=='user'||!['main-chat-rules-v1','main-chat-proposal-v2'].includes(String(decision?.router_revision))||hash(String(message.content))!==revision.revision||message.content_hash!==revision.messageHash)return this.fail('MEMORY_SOURCE_CHANGED');
   if(one(this.db,"SELECT l.task_id FROM message_task_links l JOIN privacy_tombstones p ON p.dot_id=l.dot_id AND p.source_ref IN(l.task_id,'task:'||l.task_id) WHERE l.dot_id=? AND l.message_id=?",this.dotId,message.message_id!))return this.fail('MEMORY_SOURCE_REVOKED');
  }else if(revision.kind==='external'){
   const source=this.scope('source:'+revision.sourceId);if(!source||source.enabled!==1||revoked(this.db,this.dotId,'source:'+revision.sourceId))return this.fail('MEMORY_SOURCE_REVOKED');
   if(hash(String(source.identity_binding_ref))!==revision.identityHash||hash(String(source.cursor_json))!==revision.cursorHash)return this.fail('MEMORY_SOURCE_CHANGED');
  }else return this.fail('MEMORY_SOURCE_CHANGED');
  if(hash(String(row.content))!==row.content_hash)return this.fail('MEMORY_SOURCE_CHANGED');
  return row;
 }
 private snapshot(row:Row):MemoryEntrySnapshot {const revision=JSON.parse(String(row.source_revision)) as SourceRevision;return{entryId:String(row.entry_id),sourceRef:String(row.source_ref),sourceRevision:String(row.source_revision),contentHash:String(row.content_hash),...this.epochs(),trust:revision.kind==='user_message'?'agent_inference':'untrusted_external'};}
 private capture(sourceRef:string,revision:SourceRevision,content:string,sensitivity:MemorySensitivity):MemoryEntrySnapshot {
  if(revoked(this.db,this.dotId,sourceRef))return this.fail('MEMORY_SOURCE_REVOKED');
  const sourceRevision=JSON.stringify(revision),entryId='memory-entry:'+encoded([this.dotId,sourceRef,sourceRevision,hash(content)]),epochs=this.epochs();
  if(revoked(this.db,this.dotId,'entry:'+entryId))return this.fail('MEMORY_SOURCE_REVOKED');
  const existing=one(this.db,'SELECT * FROM memory_entries WHERE entry_id=?',entryId);if(existing){if(existing.sensitivity!==sensitivity)return this.fail('MEMORY_SOURCE_CHANGED');return this.snapshot(this.entry(entryId));}
  if(Number(one(this.db,'SELECT count(*) AS n FROM memory_entries WHERE dot_id=?',this.dotId)!.n)>=10000)return this.fail('MEMORY_ENTRY_LIMIT');
  run(this.db,'INSERT INTO memory_entries VALUES (?,?,?,?,?,?,?,?,NULL)',entryId,this.dotId,sourceRef,sourceRevision,content,hash(content),sensitivity,epochs.privacyEpoch);
  run(this.db,'INSERT INTO derivation_edges VALUES (?,?,?,?,?)',this.dotId,sourceRef,'entry:'+entryId,revision.revision,epochs.privacyEpoch);
  return this.snapshot(this.entry(entryId));
 }
 captureUser(messageId:string,sensitivity:MemorySensitivity='private'):MemoryEntrySnapshot {return this.atomic(()=>{
  if(!identifier(messageId)||!sensitivities.includes(sensitivity))return this.fail('INVALID_MEMORY_SOURCE');
  const message=this.scope('message:'+messageId),decision=one(this.db,'SELECT router_revision FROM router_decisions WHERE message_id=?',messageId);if(!message||message.role!=='user'||!['main-chat-rules-v1','main-chat-proposal-v2'].includes(String(decision?.router_revision))||!this.alive('message:'+messageId)||!text(message.content,32768))return this.fail('MEMORY_SOURCE_UNAVAILABLE');
  return this.capture('message:'+messageId,{kind:'user_message',revision:hash(String(message.content)),messageHash:String(message.content_hash)},String(message.content),sensitivity);
 });}
 captureExternal(input:{sourceId:string;sourceRef:string;sourceRevision:string;content:string;sensitivity:MemorySensitivity}):MemoryEntrySnapshot {return this.atomic(()=>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['sourceId','sourceRef','sourceRevision','content','sensitivity'].includes(k))||!identifier(input.sourceId)||!text(input.sourceRef,1000)||!text(input.sourceRevision,1000)||!text(input.content,32768)||!sensitivities.includes(input.sensitivity))return this.fail('INVALID_MEMORY_SOURCE');
  const source=this.scope('source:'+input.sourceId);if(!source||source.enabled!==1||revoked(this.db,this.dotId,'source:'+input.sourceId))return this.fail('MEMORY_SOURCE_UNAVAILABLE');
  const entry=this.capture('external:'+input.sourceId+':'+hash(input.sourceRef),{kind:'external',sourceId:input.sourceId,revision:input.sourceRevision,identityHash:hash(String(source.identity_binding_ref)),cursorHash:hash(String(source.cursor_json))},input.content,input.sensitivity);
  run(this.db,'INSERT OR IGNORE INTO derivation_edges VALUES (?,?,?,?,?)',this.dotId,'source:'+input.sourceId,'entry:'+entry.entryId,encoded([source.identity_binding_ref,source.cursor_json]),entry.privacyEpoch);return entry;
 });}
 private domain(key:string,entry?:Row,allowPublicUserCoding=false):'personal'|'task'|'coding' {
  if(!text(key)||!key.trim()||/\s/.test(key))return this.fail('INVALID_MEMORY_FACT_KEY');
  if(/^personal:[^:]+$/.test(key))return'personal';
  if(/^coding:[^:]+$/.test(key)){if(entry&&(entry.sensitivity!=='public'||JSON.parse(String(entry.source_revision)).kind==='user_message'&&!allowPublicUserCoding))return this.fail('PRIVATE_CODING_MEMORY_REJECTED');return'coding';}
  const task=/^task:([^:]+):[^:]+$/.exec(key);if(task){if(!this.scope('task:'+task[1])||!this.alive('task:'+task[1]))return this.fail('MEMORY_SCOPE_MISMATCH');return'task';}
  return this.fail('INVALID_MEMORY_FACT_KEY');
 }
 commitClaim(input:MemoryClaimInput):MemoryClaimView {return this.atomic(()=>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['entryId','expectedPrivacyEpoch','expectedPolicyEpoch','factKey','factText','quote','trust','supersedesClaimId','expectedVersion','validFromMs','validUntilMs'].includes(k))||!identifier(input.entryId)||!text(input.factText,4000)||!input.factText.trim()||!text(input.quote,4000)||!['explicit_user','verified_connector','agent_inference','untrusted_external'].includes(input.trust))return this.fail('INVALID_MEMORY_CLAIM');
  const epochs=this.guard(input.expectedPrivacyEpoch,input.expectedPolicyEpoch),entry=this.entry(input.entryId),revision=JSON.parse(String(entry.source_revision)) as SourceRevision;this.domain(input.factKey,entry,input.trust==='explicit_user');
  for(const time of [input.validFromMs,input.validUntilMs])if(time!==undefined&&(!Number.isSafeInteger(time)||time<0))return this.fail('INVALID_MEMORY_VALIDITY');
  if(input.validFromMs!==undefined&&input.validUntilMs!==undefined&&input.validUntilMs<=input.validFromMs)return this.fail('INVALID_MEMORY_VALIDITY');
  if(!String(entry.content).includes(input.quote))return this.fail('MEMORY_EVIDENCE_MISMATCH');
  if(input.trust==='verified_connector'||(revision.kind==='external'&&input.trust!=='untrusted_external'))return this.fail('MEMORY_TRUST_ESCALATION');
  if(input.trust==='explicit_user'){
   const command=/^\/remember\s+([^\s=]+)\s*=\s*([\s\S]+)$/.exec(String(entry.content).trim());
   if(revision.kind!=='user_message'||!command||command[1]!==input.factKey||command[2]!.trim()!==input.factText||input.factText!==input.quote)return this.fail('MEMORY_EXPLICIT_USER_REQUIRED');
  }
  if(input.trust==='untrusted_external'&&revision.kind!=='external')return this.fail('MEMORY_TRUST_MISMATCH');
  const claimId='memory-claim:'+encoded([this.dotId,input.entryId,input.factKey,input.factText,input.trust,input.supersedesClaimId??null,input.validFromMs??null,input.validUntilMs??null]),existing=one(this.db,'SELECT * FROM memory_claims WHERE claim_id=?',claimId);
  if(existing){if(!this.alive('claim:'+claimId))return this.fail('MEMORY_SOURCE_REVOKED');if(input.supersedesClaimId!==undefined){const previous=this.scope('claim:'+input.supersedesClaimId);if(!previous||previous.version!==input.expectedVersion)return this.fail('MEMORY_CLAIM_VERSION_CONFLICT');}else if(input.expectedVersion!==undefined)return this.fail('INVALID_MEMORY_REVISION');return this.claimView(existing);}
  if(Number(one(this.db,'SELECT count(*) AS n FROM memory_claims WHERE dot_id=?',this.dotId)!.n)>=10000)return this.fail('MEMORY_CLAIM_LIMIT');
  let previous:Row|undefined;
  if(input.supersedesClaimId!==undefined){if(!identifier(input.supersedesClaimId)||!Number.isSafeInteger(input.expectedVersion))return this.fail('INVALID_MEMORY_REVISION');previous=this.scope('claim:'+input.supersedesClaimId)??this.fail('MEMORY_CLAIM_UNAVAILABLE');if(previous.fact_key!==input.factKey||previous.version!==input.expectedVersion||!['active','disputed'].includes(String(previous.status))||!this.alive('claim:'+input.supersedesClaimId))return this.fail('MEMORY_CLAIM_VERSION_CONFLICT');if(previous.trust==='explicit_user'&&input.trust!=='explicit_user')return this.fail('MEMORY_TRUST_ESCALATION');}
  else if(input.expectedVersion!==undefined)return this.fail('INVALID_MEMORY_REVISION');
  if(previous&&revision.kind==='user_message'&&this.revisionSourceRefs(previous).includes(String(entry.source_ref)))return this.fail('MEMORY_REVISION_SOURCE_REQUIRED');
  const conflicts=all(this.db,"SELECT * FROM memory_claims WHERE dot_id=? AND fact_key=? AND status IN ('active','disputed')",this.dotId,input.factKey).filter(c=>c.claim_id!==previous?.claim_id&&c.fact_text!==input.factText),status=conflicts.some(c=>input.trust!=='explicit_user'||c.trust==='explicit_user')?'disputed':'active';
  if(previous)run(this.db,"UPDATE memory_claims SET status='superseded' WHERE claim_id=?",previous.claim_id!);
  for(const conflict of conflicts)if(conflict.trust!=='explicit_user')run(this.db,'UPDATE memory_claims SET status=? WHERE claim_id=?',input.trust==='explicit_user'?'superseded':'disputed',conflict.claim_id!);
  run(this.db,'INSERT INTO memory_claims VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',claimId,this.dotId,input.factKey,input.factText,status,input.trust,input.validFromMs??null,input.validUntilMs??null,Date.now(),previous?.claim_id??null,previous?Number(previous.version)+1:1,epochs.privacyEpoch);
  run(this.db,'INSERT INTO claim_evidence VALUES (?,?,?,NULL,?,?)','memory-evidence:'+encoded([claimId,input.entryId,hash(input.quote)]),claimId,input.entryId,hash(input.quote),'exact_quote');
  run(this.db,'INSERT INTO derivation_edges VALUES (?,?,?,?,?)',this.dotId,'entry:'+input.entryId,'claim:'+claimId,String(entry.source_revision),epochs.privacyEpoch);
  const taskFact=/^task:([^:]+):/.exec(input.factKey);if(taskFact)run(this.db,'INSERT INTO derivation_edges VALUES (?,?,?,?,?)',this.dotId,'task:'+taskFact[1],'claim:'+claimId,String(this.scope('task:'+taskFact[1])!.version),epochs.privacyEpoch);
  run(this.db,"INSERT INTO outbox_events(outbox_id,dedupe_key,event_type,aggregate_ref,payload_json) VALUES (?,?, 'memory_claim_changed',?,?)",randomUUID(),'memory-claim:'+claimId,claimId,JSON.stringify({claimId,factKeyHash:hash(input.factKey),privacyEpoch:epochs.privacyEpoch}));
  return this.claimView(one(this.db,'SELECT * FROM memory_claims WHERE claim_id=?',claimId)!);
 });}
 /** Host Context resolver only; read under the caller's existing Owner transaction. */
 readContextClaim(claimId:string,taskId:string):MemoryContextClaim|null {
  this.host.owner();const row=this.scope('claim:'+claimId),now=Date.now();if(!row||row.status!=='active'||!this.alive('claim:'+claimId)||(row.valid_from_ms!==null&&Number(row.valid_from_ms)>now)||(row.valid_until_ms!==null&&Number(row.valid_until_ms)<=now)||Number(row.privacy_epoch)>this.epochs().privacyEpoch)return null;
  const view=this.claimView(row),evidence=all(this.db,'SELECT entry_id,quote_hash FROM claim_evidence WHERE claim_id=?',claimId);if(!evidence.length||evidence.length>100||evidence.length!==view.evidence.length)return null;
  try{
   const domain=this.domain(view.factKey),scopedTask=domain==='task'?/^task:([^:]+):/.exec(view.factKey)?.[1]:undefined;if(domain==='task'&&scopedTask!==taskId)return null;
   let sensitivity:MemorySensitivity='public';const rank={public:0,private:1,sensitive:2};
   for(const e of evidence){if(typeof e.entry_id!=='string'||!/^([a-f0-9]{64})$/.test(String(e.quote_hash)))return null;const entry=this.entry(e.entry_id);if(!sensitivities.includes(String(entry.sensitivity))||Number(entry.privacy_epoch)>this.epochs().privacyEpoch)return null;const level=entry.sensitivity as MemorySensitivity;if(rank[level]>rank[sensitivity])sensitivity=level;this.domain(view.factKey,entry,view.trust==='explicit_user');
    if(domain==='coding'&&JSON.parse(String(entry.source_revision)).kind==='user_message'){const command=/^\/remember\s+([^\s=]+)\s*=\s*([\s\S]+)$/.exec(String(entry.content).trim());if(view.trust!=='explicit_user'||!command||command[1]!==view.factKey||command[2]!.trim()!==view.factText||e.quote_hash!==hash(view.factText))return null;}
   }
   const ancestors=all(this.db,'WITH RECURSIVE ancestors(ref) AS(SELECT source_ref FROM derivation_edges WHERE dot_id=? AND derived_ref=? UNION SELECT d.source_ref FROM derivation_edges d JOIN ancestors a ON d.derived_ref=a.ref WHERE d.dot_id=?) SELECT ref FROM ancestors LIMIT 10001',this.dotId,'claim:'+claimId,this.dotId);if(ancestors.length>10000||ancestors.some(a=>!this.alive(String(a.ref))))return null;
   return{...view,domain,sensitivity,...(scopedTask?{taskId:scopedTask}:{})};
  }catch{return null;}
 }
 private revisionSourceRefs(row:Row):string[] {
  // UNION bounds even a corrupt cycle; all ancestors and evidence stay in this Dot.
  const refs=all(this.db,`WITH RECURSIVE chain(claim_id,supersedes_claim_id) AS (
   SELECT claim_id,supersedes_claim_id FROM memory_claims WHERE claim_id=? AND dot_id=?
   UNION SELECT c.claim_id,c.supersedes_claim_id FROM memory_claims c JOIN chain p ON c.claim_id=p.supersedes_claim_id WHERE c.dot_id=?
  ) SELECT DISTINCT e.source_ref FROM chain c JOIN claim_evidence v USING(claim_id) JOIN memory_entries e USING(entry_id) WHERE e.dot_id=? LIMIT 10001`,row.claim_id!,this.dotId,this.dotId,this.dotId);
  if(refs.length>10000)return this.fail('MEMORY_REVISION_LIMIT');
  return refs.map(ref=>String(ref.source_ref));
 }
 private claimView(row:Row):MemoryClaimView {return{claimId:String(row.claim_id),factKey:String(row.fact_key),factText:String(row.fact_text),status:String(row.status),trust:row.trust as MemoryTrust,version:Number(row.version),privacyEpoch:Number(row.privacy_epoch),validFromMs:row.valid_from_ms===null?null:Number(row.valid_from_ms),validUntilMs:row.valid_until_ms===null?null:Number(row.valid_until_ms),revisionSourceRefs:this.revisionSourceRefs(row),evidence:all(this.db,'SELECT e.entry_id,e.source_ref,e.source_revision,c.quote_hash FROM claim_evidence c JOIN memory_entries e USING(entry_id) WHERE c.claim_id=? AND e.dot_id=?',row.claim_id!,this.dotId).map(e=>({entryId:String(e.entry_id),sourceRef:String(e.source_ref),sourceRevision:String(e.source_revision),quoteHash:String(e.quote_hash)}))};}
 search(input:{query:string;domain?:'personal'|'task'|'coding';limit?:number;includeDisputed?:boolean}):MemoryClaimView[] {return this.atomic(()=>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['query','domain','limit','includeDisputed'].includes(k))||typeof input.query!=='string'||input.query.length>1000||controls.test(input.query)||(input.domain!==undefined&&!['personal','task','coding'].includes(input.domain))||(input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100))||(input.includeDisputed!==undefined&&typeof input.includeDisputed!=='boolean'))return this.fail('INVALID_MEMORY_QUERY');
  const now=Date.now(),pattern='%'+input.query.replace(/[\\%_]/g,'\\$&')+'%',rows=all(this.db,"SELECT * FROM memory_claims WHERE dot_id=? AND (status='active' OR (?=1 AND status='disputed')) AND (valid_from_ms IS NULL OR valid_from_ms<=?) AND (valid_until_ms IS NULL OR valid_until_ms>?) AND (fact_text LIKE ? ESCAPE '\\' OR fact_key LIKE ? ESCAPE '\\') ORDER BY recorded_at_ms DESC,rowid DESC LIMIT 10001",this.dotId,input.includeDisputed?1:0,now,now,pattern,pattern);if(rows.length>10000)return this.fail('MEMORY_CLAIM_LIMIT');
  const found:MemoryClaimView[]=[];for(const row of rows){if(input.domain&&!String(row.fact_key).startsWith(input.domain+':'))continue;if(!this.alive('claim:'+row.claim_id))continue;const evidence=all(this.db,'SELECT entry_id FROM claim_evidence WHERE claim_id=?',row.claim_id!);if(!evidence.length)continue;let valid=true;for(const e of evidence){try{this.entry(String(e.entry_id));}catch{valid=false;break;}}if(!valid)continue;const ancestors=all(this.db,'WITH RECURSIVE ancestors(ref) AS(SELECT source_ref FROM derivation_edges WHERE dot_id=? AND derived_ref=? UNION SELECT d.source_ref FROM derivation_edges d JOIN ancestors a ON d.derived_ref=a.ref WHERE d.dot_id=?) SELECT ref FROM ancestors LIMIT 10001',this.dotId,'claim:'+row.claim_id,this.dotId);if(ancestors.length>10000||ancestors.some(a=>!this.alive(String(a.ref))))continue;found.push(this.claimView(row));if(found.length>=(input.limit??20))break;}return found;
 });}
 addDerivation(input:{sourceRef:string;derivedRef:string;sourceRevision:string;expectedPrivacyEpoch:number;expectedPolicyEpoch:number}):void {this.atomic(()=>{
  if(!input||typeof input!=='object'||!text(input.sourceRef,500)||!text(input.derivedRef,500)||!text(input.sourceRevision,4000)||input.sourceRef===input.derivedRef)return this.fail('INVALID_MEMORY_DERIVATION');const epochs=this.guard(input.expectedPrivacyEpoch,input.expectedPolicyEpoch);
  if(!this.alive(input.sourceRef)||!this.alive(input.derivedRef))return this.fail('MEMORY_SOURCE_REVOKED');
  const source=this.scope(input.sourceRef),kind=refParts(input.sourceRef).kind,revision=source?(kind==='claim'||kind==='episode'||kind==='task'||kind==='goal'||kind==='thread'?String(source.version??source.generation):kind==='message'?hash(String(source.content)):kind==='entry'?String(source.source_revision):String(source.content_sha256??source.source_digest??'')):'';
  if(!revision||revision!==input.sourceRevision)return this.fail('MEMORY_SOURCE_CHANGED');
  if(refParts(input.sourceRef).kind==='entry')this.entry(refParts(input.sourceRef).id);
  if(kind==='claim'){const evidence=all(this.db,'SELECT entry_id FROM claim_evidence WHERE claim_id=? AND entry_id IS NOT NULL',source!.claim_id!);if(!evidence.length)return this.fail('MEMORY_SOURCE_UNAVAILABLE');for(const entry of evidence)this.entry(String(entry.entry_id));}
  run(this.db,'INSERT OR IGNORE INTO derivation_edges VALUES (?,?,?,?,?)',this.dotId,input.sourceRef,input.derivedRef,input.sourceRevision,epochs.privacyEpoch);
 });}
 forget(input:{sourceRefs:string[];expectedPrivacyEpoch:number}):MemoryForgetResult {return this.atomic(()=>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['sourceRefs','expectedPrivacyEpoch'].includes(k))||!Array.isArray(input.sourceRefs)||input.sourceRefs.length<1||input.sourceRefs.length>100||input.sourceRefs.some(ref=>!text(ref,500)||!ref.includes(':')))return this.fail('INVALID_MEMORY_FORGET');
  const current=this.epochs();if(input.expectedPrivacyEpoch!==current.privacyEpoch)return this.fail('MEMORY_SOURCE_CHANGED');if(current.privacyEpoch>=Number.MAX_SAFE_INTEGER||current.policyEpoch>=Number.MAX_SAFE_INTEGER)return this.fail('MEMORY_EPOCH_OVERFLOW');
  for(const ref of input.sourceRefs)this.scope(ref);
  const privacy=current.privacyEpoch+1,policy=current.policyEpoch+1;run(this.db,'UPDATE dots SET privacy_epoch=?,policy_epoch=? WHERE dot_id=?',privacy,policy,this.dotId);
  for(const ref of new Set(input.sourceRefs))run(this.db,'INSERT INTO privacy_tombstones VALUES (?,?,?,?) ON CONFLICT(dot_id,source_ref) DO UPDATE SET privacy_epoch=excluded.privacy_epoch,deleted_at_ms=excluded.deleted_at_ms',this.dotId,ref,privacy,Date.now());
  const result=applyMemoryTombstones(this.db,this.dotId,this.fail);
  run(this.db,"INSERT INTO outbox_events(outbox_id,dedupe_key,event_type,aggregate_ref,payload_json) VALUES (?,?, 'privacy_forgotten',?,?)",randomUUID(),'privacy-forgotten:'+this.dotId+':'+privacy,this.dotId,JSON.stringify({privacyEpoch:privacy,policyEpoch:policy,blockedRunIds:result.blockedRunIds}));return result;
 });}
 /** Logical deletion precedes compaction. Busy readers leave physical cleanup
  * explicitly incomplete. This cannot erase OS snapshots, backups or providers. */
 compact():{databaseCompacted:true;sqliteWalTruncated:true;externalCopies:'not_controlled'} {
  this.host.owner();if(this.db.isTransaction)return this.fail('MEMORY_COMPACTION_IN_TRANSACTION');
  const checkpoint=()=>{const status=this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(Number(status?.busy??0)!==0)return this.fail('MEMORY_CLEANUP_BUSY');};
  this.db.exec('PRAGMA secure_delete=ON');checkpoint();this.db.exec('VACUUM');checkpoint();return{databaseCompacted:true,sqliteWalTruncated:true,externalCopies:'not_controlled'};
 }
}
