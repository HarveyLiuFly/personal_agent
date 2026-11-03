import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ExecutionLedger} from '../packages/store/src/ledger.ts';
import {ForegroundExecution} from '../packages/runtime/src/execution.ts';
import {StdioRpcClient} from '../packages/codex-adapter/src/rpc.ts';
import {GoalService} from '../packages/runtime/src/goal-service.ts';
import type {GoalServiceOptions,GoalNotificationReceipt} from '../packages/runtime/src/goal-service.ts';
import {AuthenticatedSourcePoller} from '../packages/runtime/src/source-poller.ts';
import type {TrustedSourceEnvelope} from '../packages/contracts/src/goals.ts';
const schema=readFileSync('docs/design/contracts/schema.sql','utf8');
function fixture(t:{after(fn:()=>void|Promise<void>):void},mode?:string){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-goal-service-'))),cwd=join(root,'project'),file=join(root,'ledger.db'),receipts=join(root,'receipts.txt');mkdirSync(cwd);
 const verified=new WeakSet<TrustedSourceEnvelope>();let store=new ExecutionLedger(file,schema,{verifySource:(_source,envelope)=>verified.has(envelope)});store.startOwner('goal-service-fixture',true);const project=store.registerWorkspace(cwd),db=new DatabaseSync(file);
 const runtime=new ForegroundExecution(store,{executable:process.execPath,stateDirectory:root,timeoutMs:3000,interruptTimeoutMs:100,connect:callbacks=>new StdioRpcClient({executable:process.execPath,args:['--disable-warning=ExperimentalWarning',resolve('tests/fixtures/execution-server.ts'),mode??'interrupt-ok',file,receipts],requestTimeoutMs:1000,...callbacks})});
 t.after(async()=>{await runtime.close();db.close();store.close();rmSync(root,{recursive:true,force:true});});
 const create=(key='goal')=>store.applyGoal({kind:'create',commandKey:key,projectId:project.id,title:'PUBLIC_GOAL',objective:'PUBLIC_OBJECTIVE',criteria:['PUBLIC_CASE'],notificationPolicy:{enabled:true,dailyLimit:10,quietStartMinute:0,quietEndMinute:0}}).goal;
 const plan=(goalId:string)=>{const g=store.listGoals(project.id).find(g=>g.goalId===goalId)!;return store.applyGoal({kind:'plan',commandKey:'plan-'+goalId,goalId,expectedVersion:g.version,expectedPlanVersion:g.planVersion,tasks:[{key:'a',text:'Synthetic Goal fixture; never a model request.',dependsOn:[]}]});};
 const service=(options:GoalServiceOptions={},interrupt?:Pick<ForegroundExecution,'interrupt'>)=>new GoalService(store,interrupt??runtime,options);
 const reopen=()=>{store.close();store=new ExecutionLedger(file,schema,{verifySource:(_source,envelope)=>verified.has(envelope)});store.startOwner('goal-service-restarted',true);return store;};
 return{root,file,project,db,runtime,verified,create,plan,service,reopen,get store(){return store;}};
}
const ready=async(check:()=>boolean)=>{const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,'synthetic stdio fixture must reach accepted turn');await new Promise(resolve=>setTimeout(resolve,5));}};

test('Goal pause commits revocation before a real stdio Fixture interrupt; only acknowledged interrupted closes the Run',async t=>{
 const f=fixture(t),g=f.create(),p=f.plan(g.goalId),task=f.db.prepare('SELECT version FROM tasks WHERE task_id=?').get(p.taskIds[0]!)!;
 const run=f.runtime.startTask({projectId:f.project.id,taskId:p.taskIds[0],expectedVersion:Number(task.version),submissionKey:'public-run'});
 await ready(()=>Boolean(f.store.runForHost(run.runId).turnId));
 const command={kind:'pause' as const,commandKey:'pause',goalId:g.goalId,expectedVersion:p.goal.version};await f.service().apply(command);await f.runtime.wait();
 assert.equal(f.store.runForHost(run.runId).status,'cancelled');assert.equal(f.store.runForHost(run.runId).blocked,true);
 assert.equal(f.store.listGoals()[0]!.status,'paused');assert.equal(f.db.prepare("SELECT count(*) AS n FROM execution_intents WHERE kind='turn_interrupt' AND state='accepted'").get()!.n,1);
 await f.service().apply(command);assert.equal(readFileSync(join(f.root,'receipts.txt'),'utf8').split('turn/interrupt').length-1,1);
});
test('lost interrupt acknowledgement remains Unknown with held reservations and never manufactures process cancellation',async t=>{
 const f=fixture(t,'interrupt-timeout'),g=f.create(),p=f.plan(g.goalId),task=f.db.prepare('SELECT version FROM tasks WHERE task_id=?').get(p.taskIds[0]!)!;
 const run=f.runtime.startTask({projectId:f.project.id,taskId:p.taskIds[0],expectedVersion:Number(task.version),submissionKey:'lost-stop'});await ready(()=>Boolean(f.store.runForHost(run.runId).turnId));
 await f.service().apply({kind:'cancel',commandKey:'cancel',goalId:g.goalId,expectedVersion:p.goal.version});await f.runtime.wait();assert.equal(f.store.runForHost(run.runId).status,'outcome_unknown');assert.equal(f.db.prepare("SELECT count(*) AS n FROM budget_reservations WHERE run_id=? AND state='held_unknown'").get(run.runId)!.n,2);
});
test('an unavailable executor after Goal revise seals its admitted Run Unknown; duplicate command does not interrupt again',async t=>{
 const f=fixture(t),g=f.create(),p=f.plan(g.goalId),task=f.db.prepare('SELECT version FROM tasks WHERE task_id=?').get(p.taskIds[0]!)!,queued=f.store.claimTask(f.project.id,p.taskIds[0]!,Number(task.version),'admitted-only');let calls=0;
 const service=f.service({}, {interrupt:async()=>{calls++;assert.equal(f.store.listGoals()[0]!.status,'paused');throw Error('CONTROLLED_EXECUTOR_UNAVAILABLE');}}),command={kind:'revise' as const,commandKey:'revise',goalId:g.goalId,expectedVersion:p.goal.version,objective:'PUBLIC_NEW',criteria:['PUBLIC_NEW_CASE']};
 await service.apply(command);await service.apply(command);assert.equal(calls,1);assert.equal(f.store.runForHost(queued.token.runId).status,'outcome_unknown');assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n,0);
});
test('Source Fixture poll consumes persisted cursor, ingests through SQLite and queues wakes without a second execution loop',async t=>{
 const f=fixture(t),poller=new AuthenticatedSourcePoller({connections:[],directory:join(f.root,'payloads')}),sourceId='public-source',g=f.create();
 f.store.bindGoalSource({sourceId,bindingRef:'public-binding',allowedActors:['provider-actor'],selfActor:'host-actor',eventTypes:['issue.changed'],maxAgeMs:60000});
 f.store.applyGoal({kind:'plan',commandKey:'source-plan',goalId:g.goalId,expectedVersion:g.version,expectedPlanVersion:g.planVersion,tasks:[{key:'listener',text:'PUBLIC_LISTENER',dependsOn:[],subscription:{sourceId,threadRef:'public-thread',purpose:'wake',eventTypes:['issue.changed'],expiresAtMs:Date.now()+60000}}]});
 const cursors:unknown[]=[];poller.poll=async(_id,cursor)=>{cursors.push(cursor);const envelope:TrustedSourceEnvelope={bindingRef:'public-binding',verificationRef:'public-authenticated-fixture',actorRef:'provider-actor',events:[{id:'event-1',threadRef:'public-thread',eventType:'issue.changed',occurredAtMs:Date.now(),payloadRef:'public-ref',payloadSha256:'a'.repeat(64)}],cursor:{after:'event-1'}};f.verified.add(envelope);return envelope;};
 const service=f.service({sourcePoller:poller,sources:[{sourceId,cursor:()=>f.store.goalSourceCursor(sourceId)}]});
 assert.equal((await service.tick()).goals.delivered.queued,1);assert.equal((await service.tick()).goals.delivered.queued,0);assert.deepEqual(cursors,[null,{after:'event-1'}]);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM incoming_triggers').get()!.n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n,0);assert.equal(f.db.prepare("SELECT count(*) AS n FROM mandates WHERE state='active'").get()!.n,1);
});
test('a failing Source poll leaves its cursor unchanged and does not prevent other local Goal work',async t=>{
 const f=fixture(t),poller=new AuthenticatedSourcePoller({connections:[],directory:join(f.root,'payloads')}),g=f.create();f.store.bindGoalSource({sourceId:'fixture-unavailable',bindingRef:'public-binding',allowedActors:['provider'],selfActor:'host',eventTypes:['changed'],maxAgeMs:60000});poller.poll=async()=>{throw Error('CONTROLLED_PROVIDER_FAILURE');};f.store.queueGoalNotification(g.goalId,'notice','result','PUBLIC_RESULT');let sent=0;
 const result=await f.service({sourcePoller:poller,sources:[{sourceId:'fixture-unavailable',cursor:()=>f.store.goalSourceCursor('fixture-unavailable')}],send:async()=>{sent++;return{state:'delivered',providerRef:'public-receipt'};}}).tick();assert.equal(result.sourceErrors,1);assert.equal(result.polled,0);assert.equal(sent,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM incoming_triggers').get()!.n,0);assert.equal(f.store.goalSourceCursor('fixture-unavailable'),null);
});
test('overlapping ticks share a claim and persist each explicit Provider receipt exactly once',async t=>{
 const f=fixture(t),g=f.create();for(const key of ['a','b'])f.store.queueGoalNotification(g.goalId,key,'result','PUBLIC_'+key);let calls=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 const service=f.service({send:async claim=>{calls++;assert.equal(claim.dispatchKey,'notification:'+claim.operationId);assert.equal(f.db.prepare('SELECT state FROM operations WHERE operation_id=?').get(claim.operationId)!.state,'executing');await barrier;return{state:calls===1?'delivered':'failed',providerRef:'public-receipt-'+calls};}}),one=service.tick(),two=service.tick();assert.equal(one,two);release();const result=await one;assert.equal(calls,2);assert.deepEqual(result.notifications,{delivered:1,failed:1,unknown:0});await service.tick();assert.equal(calls,2);
});
test('a thrown notification send is Unknown and stable notification key never replays it',async t=>{
 const f=fixture(t),g=f.create(),notice=f.store.queueGoalNotification(g.goalId,'once','result','PUBLIC_RESULT')!;let calls=0;const service=f.service({send:async()=>{calls++;throw Error('CONTROLLED_LOST_ACK');}});
 assert.equal((await service.tick()).notifications.unknown,1);assert.equal(f.store.goalNotifications(g.goalId)[0]!.state,'unknown');assert.equal(f.store.queueGoalNotification(g.goalId,'once','result','PUBLIC_RESULT')!.operationId,notice.operationId);await service.tick();assert.equal(calls,1);
});
test('notification timeout aborts the adapter and a late delivered receipt cannot replace Unknown or cause resend',async t=>{
 const f=fixture(t),g=f.create();f.store.queueGoalNotification(g.goalId,'timeout','result','PUBLIC_RESULT');let signal!:AbortSignal,release!:(value:GoalNotificationReceipt)=>void,calls=0;const service=f.service({notificationTimeoutMs:10,send:async(_claim,s)=>{calls++;signal=s;return new Promise(resolve=>{release=resolve;});}});
 assert.equal((await service.tick()).notifications.unknown,1);assert.equal(signal.aborted,true);release({state:'delivered',providerRef:'late-public-receipt'});await service.tick();assert.equal(calls,1);assert.equal(f.store.goalNotifications(g.goalId)[0]!.state,'unknown');
});
test('malformed Provider receipt is conservatively sealed Unknown rather than stranded or retried',async t=>{
 const f=fixture(t),g=f.create();f.store.queueGoalNotification(g.goalId,'bad','result','PUBLIC_RESULT');const service=f.service({send:async()=>({state:'delivered',providerRef:''})});assert.equal((await service.tick()).notifications.unknown,1);assert.equal(f.store.goalNotifications(g.goalId)[0]!.state,'unknown');
});
test('actual SQLite close and new Owner seal an already claimed notification Unknown without any Provider send',async t=>{
 const f=fixture(t),g=f.create();f.store.queueGoalNotification(g.goalId,'restart','result','PUBLIC_RESULT');assert.ok(f.store.claimGoalNotification());f.reopen();let calls=0;await f.service({send:async()=>{calls++;return{state:'delivered',providerRef:'public'};}}).tick();assert.equal(calls,0);assert.equal(f.store.goalNotifications(g.goalId)[0]!.state,'unknown');
});
test('no configured notification adapter leaves pending rows unclaimed; cancelled Goal prevents a later send',async t=>{
 const f=fixture(t),g=f.create();f.store.queueGoalNotification(g.goalId,'pending','result','PUBLIC_RESULT');await f.service().tick();assert.equal(f.store.goalNotifications(g.goalId)[0]!.state,'pending');await f.service().apply({kind:'cancel',commandKey:'cancel',goalId:g.goalId,expectedVersion:g.version});let calls=0;await f.service({send:async()=>{calls++;return{state:'delivered',providerRef:'public'};}}).tick();assert.equal(calls,0);assert.equal(f.store.goalNotifications(g.goalId)[0]!.state,'cancelled');
});
test('a new Owner during Provider send rejects the late old claim and subsequent ticks never replay it',async t=>{
 const f=fixture(t),g=f.create();f.store.queueGoalNotification(g.goalId,'owner-change','result','PUBLIC_RESULT');let release!:(value:GoalNotificationReceipt)=>void,calls=0;const service=f.service({send:async()=>{calls++;return new Promise(resolve=>{release=resolve;});}}),pending=service.tick();await ready(()=>calls===1);const replacement=new ExecutionLedger(f.file,schema);try{replacement.startOwner('fixture-new-owner',true);release({state:'delivered',providerRef:'late-old-owner'});await assert.rejects(pending,/STALE_RUNTIME_OWNER/);await new GoalService(replacement,f.runtime,{send:async()=>{calls++;return{state:'delivered',providerRef:'must-not-send'};}}).tick();assert.equal(calls,1);assert.equal(replacement.goalNotifications(g.goalId)[0]!.state,'unknown');}finally{replacement.close();}
});
