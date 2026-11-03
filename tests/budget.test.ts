import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,readdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {ExecutionLedger} from '../packages/store/src/ledger.ts';
import type {RunToken} from '../packages/store/src/ledger.ts';
import {legacySchema} from './fixtures/schema-history.ts';
const schema=readFileSync('docs/design/contracts/schema.sql','utf8');
function fixture(t:{after(fn:()=>void):void},dailyTokens=100,reservationTokens=60){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-budget-'))),cwd=join(root,'project'),file=join(root,'store.db');mkdirSync(cwd);const store=new ExecutionLedger(file,schema,{budgetPolicy:{dailyTokens,reservationTokens}});store.startOwner('budget-owner',true);const project=store.registerWorkspace(cwd,cwd),db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');
 t.after(()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});});
 const begin=(key='first')=>store.beginRun(project.id,'controlled budget task',key,'readOnly').token;
 const turn=(token:RunToken,thread='budget-thread',resume=false)=>{
  const a=store.prepare(token,'thread:'+token.runId,resume?'thread_resume':'thread_start',{},resume?thread:null);store.sending(token,a.intentId,1);store.accepted(token,a.intentId,{threadId:thread});const turnId='turn:'+token.runId,b=store.prepare(token,'turn:'+token.runId,'turn_start',{},thread);store.sending(token,b.intentId,1);store.accepted(token,b.intentId,{turnId});return{thread,turnId};
 };
 const counts=()=>Object.fromEntries(['tasks','task_runs','messages','operations','task_events','outbox_events','budget_reservations','run_usage'].map(table=>[table,Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)]));
 return{root,cwd,file,store,project,db,begin,turn,counts};
}
test('admission reserves in the Run transaction and confirmed pre-send failure releases zero-token work',t=>{
 const f=fixture(t),run=f.begin(),state=f.store.resourceBudget();assert.equal(state.reservedTokens,60);assert.equal(state.availableTokens,40);assert.equal(state.activeRuns,1);assert.equal(state.estimatedUsd,null);const before=f.counts();
 assert.throws(()=>f.begin('concurrent'),/RUNTIME_BUSY/);assert.deepEqual(f.counts(),before);f.store.finish(run,'failed');const released=f.store.resourceBudget();assert.equal(released.reservedTokens,0);assert.equal(released.reportedTokens,0);assert.equal(released.unknownHeldTokens,0);assert.equal(released.activeRuns,0);assert.ok(f.begin('next'));
});
test('cumulative usage and duplicate notifications settle once rather than adding repeated totals',t=>{
 const f=fixture(t),run=f.begin(),scope=f.turn(run);for(const total of [10,10,25,25])f.store.recordTokenUsage(run,scope.thread,scope.turnId,total);assert.equal(f.store.resourceBudget().reservedTokens,60);f.store.finish(run,'completed');const state=f.store.resourceBudget();assert.equal(state.reportedTokens,25);assert.equal(state.reservedTokens,0);assert.equal(state.availableTokens,75);
 const receipt=f.db.prepare('SELECT * FROM budget_reservations').get()!;assert.equal(receipt.state,'settled');assert.equal(receipt.actual_units,25);assert.match(String(receipt.settlement_hash),/^[a-f0-9]{64}$/);assert.throws(()=>f.store.recordTokenUsage(run,scope.thread,scope.turnId,50),/USAGE_ALREADY_FINALIZED/);assert.equal(f.store.resourceBudget().reportedTokens,25);
});
test('same Thread continuation charges only the newly reported cumulative increment',t=>{
 const f=fixture(t),first=f.begin(),a=f.turn(first);f.store.recordTokenUsage(first,a.thread,a.turnId,25);f.store.finish(first,'completed');const second=f.store.beginContinuation(f.project.id,first.runId,'next scoped task','second').token,b=f.turn(second,a.thread,true);f.store.recordTokenUsage(second,b.thread,b.turnId,30);f.store.recordTokenUsage(second,b.thread,b.turnId,55);f.store.finish(second,'completed');
 assert.equal(f.store.resourceBudget().reportedTokens,55);assert.deepEqual(f.db.prepare('SELECT actual_units FROM budget_reservations ORDER BY rowid').all().map(x=>x.actual_units),[25,30]);
});
test('missing usage retains an unknown hold and budget failure rolls back a fresh Task/Run/Operation',t=>{
 const f=fixture(t),run=f.begin();f.turn(run);f.store.finish(run,'completed');const state=f.store.resourceBudget();assert.equal(state.reportedTokens,0);assert.equal(state.reservedTokens,60);assert.equal(state.unknownHeldTokens,60);const before=f.counts();assert.throws(()=>f.begin('different-key'),/TOKEN_BUDGET_EXHAUSTED/);assert.deepEqual(f.counts(),before);assert.equal(f.db.prepare('SELECT actual_units FROM budget_reservations').get()!.actual_units,null);
});
test('zero, regressed or malformed counters cannot be treated as known zero cost',t=>{
 for(const bad of [0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){const f=fixture(t),run=f.begin(),scope=f.turn(run);f.store.recordTokenUsage(run,scope.thread,scope.turnId,bad);f.store.finish(run,'completed');assert.equal(f.store.resourceBudget().unknownHeldTokens,60);assert.equal(f.db.prepare('SELECT actual_units FROM budget_reservations').get()!.actual_units,null);}
 const f=fixture(t),run=f.begin(),scope=f.turn(run);f.store.recordTokenUsage(run,scope.thread,scope.turnId,25);f.store.recordTokenUsage(run,scope.thread,scope.turnId,20);f.store.recordTokenUsage(run,scope.thread,scope.turnId,30);f.store.finish(run,'completed');assert.equal(f.store.resourceBudget().unknownHeldTokens,60);assert.equal(f.store.resourceBudget().reportedTokens,0);
});
test('wrong Thread/Turn observations are rejected without altering the real reservation',t=>{
 const f=fixture(t),run=f.begin(),scope=f.turn(run);assert.throws(()=>f.store.recordTokenUsage(run,'foreign',scope.turnId,90),/USAGE_SCOPE_MISMATCH/);assert.throws(()=>f.store.recordTokenUsage(run,scope.thread,'foreign',90),/USAGE_SCOPE_MISMATCH/);f.store.recordTokenUsage(run,scope.thread,scope.turnId,20);f.store.finish(run,'completed');assert.equal(f.store.resourceBudget().reportedTokens,20);
});
test('observed overruns increase held units and actual settlement is recorded even above the limit',t=>{
 const f=fixture(t),run=f.begin(),scope=f.turn(run);f.store.recordTokenUsage(run,scope.thread,scope.turnId,120);assert.equal(f.store.resourceBudget().reservedTokens,120);assert.equal(f.store.resourceBudget().availableTokens,0);f.store.finish(run,'completed');assert.equal(f.store.resourceBudget().reportedTokens,120);assert.equal(f.store.resourceBudget().reservedTokens,0);const before=f.counts();assert.throws(()=>f.begin('after-overrun'),/TOKEN_BUDGET_EXHAUSTED/);assert.deepEqual(f.counts(),before);
});
test('a Goal bucket shortage rolls back the whole reservation group, fence and run',t=>{
 const f=fixture(t),task=f.store.taskCommand({projectId:f.project.id,commandKey:'task',kind:'create',text:'goal budget fixture'});f.db.prepare("INSERT INTO goals(goal_id,dot_id,title,objective,status) VALUES ('goal',?,'fixture','fixture','active')").run(f.store.dotId);f.db.prepare("UPDATE tasks SET goal_id='goal' WHERE task_id=?").run(task.taskId);const now=Date.now();f.db.prepare("INSERT INTO budget_buckets VALUES ('goal-budget',?,'goal','tokens',?,?,10,0,0)").run(f.store.dotId,now-1,now+86400000);f.store.resourceBudget();const before=f.counts();
 assert.throws(()=>f.store.claimTask(f.project.id,task.taskId,2,'goal-dispatch'),/TOKEN_BUDGET_EXHAUSTED/);assert.deepEqual(f.counts(),before);assert.equal(f.store.resourceBudget().reservedTokens,0);assert.equal(f.store.tasks(f.project.id)[0]!.version,2);assert.equal(f.db.prepare('SELECT write_fence FROM tasks WHERE task_id=?').get(task.taskId)!.write_fence,0);
});
test('an unpriced currency budget is not bypassed or filled with invented dollar costs',t=>{
 const f=fixture(t),now=Date.now();f.db.prepare("INSERT INTO budget_buckets VALUES ('cost-budget',?,NULL,'estimated_micro_usd',?,?,100,0,0)").run(f.store.dotId,now-1,now+86400000);const before=f.counts();assert.throws(()=>f.begin(),/COST_ESTIMATE_UNAVAILABLE/);assert.deepEqual(f.counts(),before);assert.equal(f.store.resourceBudget().estimatedUsd,null);
});
test('unknown holds persist across Owner restart and an old token cannot update accounting',t=>{
 const f=fixture(t),run=f.begin(),scope=f.turn(run);f.store.recordTokenUsage(run,scope.thread,scope.turnId,20);f.store.uncertain(run);const next=new ExecutionLedger(f.file,schema);next.startOwner('replacement-after-lock-fixture',true);
 try{const state=next.resourceBudget();assert.equal(state.limitTokens,100);assert.equal(state.reservedTokens,60);assert.equal(state.unknownHeldTokens,60);assert.equal(state.reportedTokens,0);assert.throws(()=>next.recordTokenUsage(run,scope.thread,scope.turnId,30),/STALE_RUN_USAGE/);assert.throws(()=>next.beginRun(f.project.id,'no unknown retry','retry','readOnly'),/RUNTIME_BUSY/);}
 finally{next.close();}
});
test('an old untracked Thread keeps an unknown reservation rather than charging its historical total',t=>{
 const f=fixture(t,1000),first=f.begin(),a=f.turn(first);f.store.recordTokenUsage(first,a.thread,a.turnId,25);f.store.finish(first,'completed');f.db.prepare('DELETE FROM thread_usage WHERE thread_id=?').run(a.thread);
 const second=f.store.beginContinuation(f.project.id,first.runId,'legacy-resume','legacy').token,b=f.turn(second,a.thread,true);f.store.recordTokenUsage(second,b.thread,b.turnId,1000);f.store.finish(second,'completed');assert.equal(f.store.resourceBudget().reportedTokens,25);assert.equal(f.store.resourceBudget().unknownHeldTokens,60);
 const third=f.store.beginContinuation(f.project.id,second.runId,'tracked-next','third').token,c=f.turn(third,a.thread,true);f.store.recordTokenUsage(third,c.thread,c.turnId,1020);f.store.finish(third,'completed');assert.equal(f.store.resourceBudget().reportedTokens,45);assert.equal(f.store.resourceBudget().unknownHeldTokens,60);
});
test('multiple budget constraints do not double-count the same unknown Run in the display',t=>{
 const f=fixture(t),now=Date.now();f.db.prepare("INSERT INTO budget_buckets VALUES ('monthly',?,NULL,'tokens',?,?,1000,0,0)").run(f.store.dotId,now-1,now+86400000);const run=f.begin();f.turn(run);f.store.finish(run,'completed');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM budget_reservations').get()!.n,2);assert.equal(f.store.resourceBudget().unknownHeldTokens,60);
});
for(const revision of [2,3] as const)test(`revision ${revision} migrates to 5 with a private verified WAL snapshot and no lost budget facts`,t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-budget-migration-'))),file=join(root,'store.db');t.after(()=>rmSync(root,{recursive:true,force:true}));const old=new DatabaseSync(file);old.exec(legacySchema(schema,revision));old.exec("INSERT INTO profiles VALUES ('legacy','public legacy WAL fixture',0); INSERT INTO dots(dot_id,profile_id,display_name) VALUES ('legacy-dot','legacy','legacy'); INSERT INTO tasks(task_id,dot_id,title,status,created_at_ms,updated_at_ms) VALUES ('t','legacy-dot','fixture','needs_review',0,0); INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES ('r','t','legacy-dot','legacy-key','codex','completed',1,1,1,1,1,'old',0,0); INSERT INTO budget_buckets VALUES ('old-bucket','legacy-dot',NULL,'tokens',0,1000,100,0,20); INSERT INTO budget_reservations VALUES ('old-reservation','old-bucket','r',10,'settled');");
 const migrated=new ExecutionLedger(file,schema);migrated.close();old.close();const backups=readdirSync(root).filter(p=>p.endsWith('.backup'));assert.equal(backups.length,1);assert.equal(statSync(join(root,backups[0]!)).mode&0o777,0o600);const backup=new DatabaseSync(join(root,backups[0]!),{readOnly:true});assert.equal(backup.prepare('SELECT schema_revision FROM schema_metadata').get()!.schema_revision,revision);assert.equal(backup.prepare('SELECT display_name FROM profiles').get()!.display_name,'public legacy WAL fixture');assert.equal(backup.prepare('PRAGMA quick_check').get()!.quick_check,'ok');backup.close();
 const db=new DatabaseSync(file,{readOnly:true});assert.equal(db.prepare('SELECT schema_revision FROM schema_metadata').get()!.schema_revision,5);assert.equal(db.prepare('SELECT consumed_units FROM budget_buckets').get()!.consumed_units,20);assert.equal(db.prepare('SELECT actual_units FROM budget_reservations').get()!.actual_units,null);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();
});
test('a failed migration rolls back new columns and preserves the source database and backup',t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-budget-bad-migration-'))),file=join(root,'store.db');t.after(()=>rmSync(root,{recursive:true,force:true}));const old=new DatabaseSync(file);old.exec(legacySchema(schema,3));old.close();const malformed=schema.replace(/CREATE TABLE run_usage \([\s\S]*?\n\);/,'');assert.throws(()=>new ExecutionLedger(file,malformed),/LEDGER_MIGRATION_UNAVAILABLE/);
 const db=new DatabaseSync(file,{readOnly:true});assert.equal(db.prepare('SELECT schema_revision FROM schema_metadata').get()!.schema_revision,3);assert.equal(db.prepare('PRAGMA table_info(budget_reservations)').all().some(row=>row.name==='actual_units'),false);db.close();assert.equal(readdirSync(root).filter(p=>p.endsWith('.backup')).length,1);
});
test('real child SIGKILL retains unknown budget reservations and blocks a replacement model dispatch',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-budget-crash-'))),cwd=join(root,'project'),file=join(root,'store.db');mkdirSync(cwd);t.after(()=>rmSync(root,{recursive:true,force:true}));const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','tests/fixtures/budget-worker.ts',file,cwd],{stdio:['ignore','pipe','ignore']}),closed=once(child,'close');t.after(()=>child.kill('SIGKILL'));let line='';
 const ready=await new Promise<{projectId:string;runId:string}>((done,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('BUDGET_CHILD_TIMEOUT'));},5000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.stdout.on('data',chunk=>{line+=String(chunk);if(line.includes('\n')){clearTimeout(timer);done(JSON.parse(line.trim()));}});});
 child.kill('SIGKILL');const [code,signal]=await closed;assert.equal(code,null);assert.equal(signal,'SIGKILL');const recovered=new ExecutionLedger(file,schema);recovered.startOwner('after-real-budget-process-exit',true);
 try{const state=recovered.resourceBudget();assert.equal(state.limitTokens,100);assert.equal(state.reservedTokens,60);assert.equal(state.unknownHeldTokens,60);assert.equal(state.reportedTokens,0);assert.equal(state.activeRuns,1);assert.equal(recovered.runForHost(ready.runId).status,'outcome_unknown');assert.throws(()=>recovered.beginRun(ready.projectId,'never resend unknown','new-key','readOnly'),/RUNTIME_BUSY/);assert.equal(recovered.runs(ready.projectId).length,1);}
 finally{recovered.close();}
});
