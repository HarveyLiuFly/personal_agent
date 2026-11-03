import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ExecutionLedger} from '../packages/store/src/ledger.ts';
import {ForegroundExecution} from '../packages/runtime/src/execution.ts';
import {StdioRpcClient} from '../packages/codex-adapter/src/rpc.ts';
import {AuthenticatedSourcePoller} from '../packages/runtime/src/source-poller.ts';
import {GoalService} from '../packages/runtime/src/goal-service.ts';
import {ScheduleService} from '../packages/runtime/src/schedules.ts';
import type {GoalView,GoalNotificationClaim} from '../packages/contracts/src/goals.ts';
const schema=readFileSync('docs/design/contracts/schema.sql','utf8');
const token='PUBLIC_M3_SELF_OWNED_PROVIDER_TOKEN',sourceId='public-long-source',bindingRef='public-long-binding',actorRef='public-provider';
type Event={id:string;threadRef:string;eventType:string;occurredAtMs:number;payload:string};
const event=(id:string,occurredAtMs=Date.now()):Event=>({id,threadRef:'public-long-thread',eventType:'issue.changed',occurredAtMs,payload:'PUBLIC_EVENT_'+id});

/** Real SQLite + authenticated self-owned loopback HTTP. Model execution is
 * explicitly a synthetic stdio protocol Fixture, never native model success. */
async function fixture(t:{after(fn:()=>void|Promise<void>):void}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-m3-long-'))),cwd=join(root,'project'),file=join(root,'ledger.db'),receiptFile=join(root,'stdio-receipts.txt');mkdirSync(cwd);
 let events:Event[]=[],generation=0,dropNotification=false;const polls:Array<{cursor:unknown;authorized:boolean}>=[],notificationRequests:string[]=[],effects=new Map<string,number>();let db!:DatabaseSync;
 const server=createServer((request,response)=>{const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(Buffer.from(chunk)));request.on('end',()=>{
  const authorized=request.headers.authorization==='Bearer '+token;if(!authorized){response.writeHead(401);response.end();return;}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(request.url==='/poll'){
   polls.push({cursor:input.cursor,authorized});assert.equal(input.sourceId,sourceId);assert.equal(input.bindingRef,bindingRef);assert.equal(input.nonce,request.headers['x-source-nonce']);
   const bytes=Buffer.from(JSON.stringify({sourceId,bindingRef,actorRef,events,cursor:{generation}}));response.writeHead(200,{'content-type':'application/json','x-source-signature':createHmac('sha256',token).update(input.nonce+'\n').update(bytes).digest('hex')});response.end(bytes);return;
  }
  if(request.url==='/notify'){
   const claim=input as GoalNotificationClaim;assert.equal(claim.dispatchKey,'notification:'+claim.operationId);assert.equal(db.prepare('SELECT state FROM operations WHERE operation_id=?').get(claim.operationId)!.state,'executing');
   notificationRequests.push(claim.dispatchKey);effects.set(claim.dispatchKey,1);if(dropNotification){response.destroy();return;}response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({state:'delivered',providerRef:'public-provider:'+claim.operationId}));return;
  }
  response.writeHead(404);response.end();
 });});
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 const pollerConfig={connections:[{sourceId,bindingRef,url:base+'/poll',token}],directory:join(root,'payloads'),allowLoopbackHttpForTests:true};let poller=new AuthenticatedSourcePoller(pollerConfig),store!:ExecutionLedger,runtime!:ForegroundExecution;
 const open=()=>{store=new ExecutionLedger(file,schema,{verifySource:(source,envelope)=>poller.verified(source,envelope),sourcePayload:(ref,sha)=>ref==='payload:'+sha?poller.getPayload(ref):null,budgetPolicy:{dailyTokens:1000,reservationTokens:60}});store.startOwner('long-chain-owner-'+generation,true);runtime=new ForegroundExecution(store,{executable:process.execPath,stateDirectory:root,timeoutMs:2000,connect:callbacks=>new StdioRpcClient({executable:process.execPath,args:['--disable-warning=ExperimentalWarning',resolve('tests/fixtures/execution-server.ts'),'usage',file,receiptFile],requestTimeoutMs:1000,...callbacks})});};open();
 db=new DatabaseSync(file);const project=store.registerWorkspace(cwd);store.bindGoalSource({sourceId,bindingRef,allowedActors:[actorRef],selfActor:'public-host',eventTypes:['issue.changed'],maxAgeMs:60000});
 const service=()=>new GoalService(store,runtime,{sourcePoller:poller,sources:[{sourceId,cursor:()=>store.goalSourceCursor(sourceId)}],notificationTimeoutMs:200,send:async(claim,signal)=>{const response=await fetch(base+'/notify',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(claim),signal});assert.equal(response.status,200);return await response.json() as {state:'delivered';providerRef:string};}});
 const create=(budgetTokens=1000)=>store.applyGoal({kind:'create',commandKey:'public-goal',projectId:project.id,title:'PUBLIC_GOAL',objective:'PUBLIC_OBJECTIVE',criteria:['An independently verified business result'],budgetTokens,notificationPolicy:{enabled:true,dailyLimit:10,quietStartMinute:0,quietEndMinute:0}}).goal;
 const goal=(goalId:string)=>store.listGoals(project.id).find(g=>g.goalId===goalId)!;
 const plan=(g:GoalView,key:string,dispatch:'queue_only'|'execute_once'='queue_only')=>store.applyGoal({kind:'plan',commandKey:'plan-'+key,goalId:g.goalId,expectedVersion:g.version,expectedPlanVersion:g.planVersion,tasks:[{key,text:'Synthetic Source-woken Task; no model involved.',dispatch,dependsOn:[],subscription:{sourceId,threadRef:'public-long-thread',purpose:'wake',eventTypes:['issue.changed'],expiresAtMs:Date.now()+600000}}]});
 const setEvents=(next:Event[])=>{events=next;generation++;};
 const restart=async()=>{await runtime.close();store.close();poller=new AuthenticatedSourcePoller(pollerConfig);open();};
 t.after(async()=>{await runtime.close();store.close();db.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(root,{recursive:true,force:true});});
 return{root,project,db,polls,notificationRequests,effects,create,goal,plan,service,setEvents,restart,get store(){return store;},get runtime(){return runtime;},get poller(){return poller;},dropNotifications(){dropNotification=true;}};
}
const version=(db:DatabaseSync,taskId:string)=>Number(db.prepare('SELECT version FROM tasks WHERE task_id=?').get(taskId)!.version);

test('authenticated Source→wake→stdio Fixture→Plan revision→restart→pause/resume uses one Goal budget and requires independent completion evidence',async t=>{
 const f=await fixture(t),g=f.create(80),p=f.plan(g,'first'),first=event('first');f.setEvents([first]);assert.equal((await f.service().tick()).goals.delivered.queued,1);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n,0);const run=f.runtime.startTask({projectId:f.project.id,taskId:p.taskIds[0],expectedVersion:version(f.db,p.taskIds[0]!),submissionKey:'public-first-run'});await f.runtime.wait();
 assert.equal(f.store.runForHost(run.runId).status,'completed');assert.equal(f.store.runForHost(run.runId).taskStatus,'needs_review');assert.equal(f.store.resourceBudget().reportedTokens,25);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM execution_intents WHERE run_id=? AND kind IN ('thread_start','turn_start') AND state='accepted'").get(run.runId)!.n,2);
 await assert.rejects(f.service().apply({kind:'complete',commandKey:'cannot-complete-from-run',goalId:g.goalId,expectedVersion:p.goal.version,verificationIds:['no-independent-business-receipt']}),/GOAL_VERIFICATION_REQUIRED/);
 const revised=await f.service().apply({kind:'revise',commandKey:'revised',goalId:g.goalId,expectedVersion:p.goal.version,objective:'PUBLIC_REVISED_OBJECTIVE',criteria:['New independent cases'],budgetTokens:80});assert.equal(revised.goal.status,'paused');assert.equal(f.db.prepare("SELECT count(*) AS n FROM subscriptions WHERE state='active'").get()!.n,0);assert.equal(f.db.prepare("SELECT count(*) AS n FROM mandates WHERE state='active'").get()!.n,0);
 await f.service().apply({kind:'resume',commandKey:'resume-revised',goalId:g.goalId,expectedVersion:revised.goal.version});const second=f.plan(f.goal(g.goalId),'second');f.setEvents([first]);assert.equal((await f.service().tick()).goals.delivered.queued,0,'replayed event cannot create a new delivery for a replacement plan');
 const secondEvent=event('second');f.setEvents([secondEvent]);assert.equal((await f.service().tick()).goals.delivered.queued,1);const before=f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n;
 assert.throws(()=>f.runtime.startTask({projectId:f.project.id,taskId:second.taskIds[0],expectedVersion:version(f.db,second.taskIds[0]!),submissionKey:'over-goal-budget'}),/TOKEN_BUDGET_EXHAUSTED/);assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n,before);assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n,1);
 f.store.queueGoalNotification(g.goalId,'known-result','result','PUBLIC_VERIFIED_PROGRESS');await f.service().tick();assert.equal(f.notificationRequests.length,1);const committedCursor=f.store.goalSourceCursor(sourceId);await f.restart();await f.service().tick();assert.deepEqual(f.polls.at(-1)!.cursor,committedCursor);assert.equal(f.notificationRequests.length,1);assert.equal(f.store.listGoals()[0]!.goalId,g.goalId);
 const paused=await f.service().apply({kind:'pause',commandKey:'pause',goalId:g.goalId,expectedVersion:second.goal.version});f.setEvents([event('while-paused')]);assert.equal((await f.service().tick()).goals.delivered.queued,0);const resumed=await f.service().apply({kind:'resume',commandKey:'resume',goalId:g.goalId,expectedVersion:paused.goal.version});assert.equal(resumed.goal.requiresPlan,true);f.setEvents([event('after-resume-no-plan')]);assert.equal((await f.service().tick()).goals.delivered.queued,0);assert.equal(f.db.prepare("SELECT count(*) AS n FROM mandates WHERE state='active'").get()!.n,0);
 assert.equal(f.store.resourceBudget().reportedTokens,25);assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);assert.ok(f.polls.every(p=>p.authorized));
});
test('stale signed Source batch rolls back cursor; disabled Mandate and paused Task cannot regain wake authority',async t=>{
 const f=await fixture(t),g=f.create(),p=f.plan(g,'listener');f.setEvents([event('stale',Date.now()-120000)]);const failed=await f.service().tick();assert.equal(failed.sourceErrors,1);assert.equal(f.store.goalSourceCursor(sourceId),null);assert.equal(f.db.prepare('SELECT count(*) AS n FROM incoming_triggers').get()!.n,0);
 f.db.prepare("UPDATE mandates SET state='revoked' WHERE task_id=?").run(p.taskIds[0]!);f.setEvents([event('mandate-revoked')]);const denied=await f.service().tick();assert.equal(denied.goals.delivered.queued,0);assert.equal(f.db.prepare("SELECT reason_code FROM trigger_deliveries WHERE task_id=?").get(p.taskIds[0]!)!.reason_code,'MANDATE_NOT_CURRENT');
 f.store.taskCommand({kind:'pause',projectId:f.project.id,taskId:p.taskIds[0]!,expectedVersion:version(f.db,p.taskIds[0]!),commandKey:'task-pause'});assert.equal(f.db.prepare('SELECT state FROM subscriptions WHERE task_id=?').get(p.taskIds[0]!)!.state,'paused');
 f.setEvents([event('task-paused')]);assert.equal((await f.service().tick()).goals.delivered.queued,0);f.store.taskCommand({kind:'resume',projectId:f.project.id,taskId:p.taskIds[0]!,expectedVersion:version(f.db,p.taskIds[0]!),commandKey:'task-resume'});f.setEvents([event('task-resumed')]);assert.equal((await f.service().tick()).goals.delivered.queued,0);assert.equal(f.db.prepare("SELECT count(*) AS n FROM mandates WHERE state='active'").get()!.n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM task_runs').get()!.n,0);
});
test('actual Provider accepted a notification but lost acknowledgement: restart preserves Unknown and the Provider is contacted exactly once',async t=>{
 const f=await fixture(t),g=f.create();f.dropNotifications();const notice=f.store.queueGoalNotification(g.goalId,'lost-ack','result','PUBLIC_RESULT')!;assert.equal((await f.service().tick()).notifications.unknown,1);assert.equal(f.notificationRequests.length,1);assert.equal(f.effects.size,1);await f.restart();f.store.queueGoalNotification(g.goalId,'lost-ack','result','PUBLIC_RESULT');await f.service().tick();assert.equal(f.notificationRequests.length,1);assert.equal(f.store.goalNotifications(g.goalId)[0]!.operationId,notice.operationId);assert.equal(f.store.goalNotifications(g.goalId)[0]!.state,'unknown');assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n,0);
});
test('Owner restart after same-transaction Run reservation seals Unknown without first sending a stdio or notification effect',async t=>{
 const f=await fixture(t),g=f.create(),p=f.plan(g,'admitted'),e=event('admission');f.setEvents([e]);await f.service().tick();const queued=f.store.claimTask(f.project.id,p.taskIds[0]!,version(f.db,p.taskIds[0]!),'admitted-before-crash');f.store.queueGoalNotification(g.goalId,'admitted-notice','result','PUBLIC_PENDING');assert.ok(f.store.claimGoalNotification());assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n,0);await f.restart();await f.service().tick();assert.equal(f.store.runForHost(queued.token.runId).status,'outcome_unknown');assert.equal(f.notificationRequests.length,0);assert.equal(f.store.goalNotifications(g.goalId)[0]!.state,'unknown');assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n,0);assert.equal(f.db.prepare("SELECT count(*) AS n FROM budget_reservations WHERE run_id=? AND state='held_unknown'").get(queued.token.runId)!.n,2);assert.throws(()=>f.runtime.startTask({projectId:f.project.id,taskId:p.taskIds[0],expectedVersion:version(f.db,p.taskIds[0]!),submissionKey:'must-not-auto-replay'}),/TASK_NOT_DISPATCHABLE|TASK_RUN_ACTIVE|RUN_DISPATCH_BLOCKED|RUNTIME_BUSY|TASK_ACTIVE/);
});
test('an explicitly authorized Source wake automatically enters the existing ScheduleService Gateway once, with committed Intents before real stdio Fixture effects',async t=>{
 const f=await fixture(t),g=f.create(),p=f.plan(g,'automatic','execute_once'),service=f.service(),pump=new ScheduleService(f.store,f.runtime);assert.deepEqual(f.store.goalDispatchCandidates(),[]);f.setEvents([event('automatic-first')]);await service.tick();const candidate=f.store.goalDispatchCandidates()[0]!;assert.equal(candidate.taskId,p.taskIds[0]);pump.step();await f.runtime.wait();
 const runs=f.store.runs(f.project.id);assert.equal(runs.length,1);assert.equal(runs[0]!.status,'completed');assert.equal(runs[0]!.taskStatus,'needs_review');assert.equal(f.db.prepare('SELECT idempotency_key FROM task_runs').get()!.idempotency_key,candidate.submissionKey);assert.deepEqual(readFileSync(join(f.root,'stdio-receipts.txt'),'utf8').trim().split('\n'),['thread/start','turn/start']);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM execution_intents WHERE state='accepted'").get()!.n,2);assert.ok(f.store.contextManifestReceipt(runs[0]!.runId)!.contextRefs.some(ref=>ref.ref.startsWith('trigger:')));const userInput=f.runtime.view({projectId:f.project.id,runId:runs[0]!.runId}).snapshot!.items.filter(item=>item.role==='user').map(item=>item.text).join('');assert.ok(userInput.includes('PUBLIC_EVENT_automatic-first'));assert.ok(userInput.includes('untrusted_external'));assert.deepEqual(f.store.goalDispatchCandidates(),[]);pump.step();assert.equal(f.store.runs(f.project.id).length,1);
 // This second transaction rechecks the Mandate after candidate discovery.
 const changed=await service.apply({kind:'revise',commandKey:'auto-revise',goalId:g.goalId,expectedVersion:p.goal.version,objective:'PUBLIC_NEXT',criteria:['Independent verification']});await service.apply({kind:'resume',commandKey:'auto-resume',goalId:g.goalId,expectedVersion:changed.goal.version});const next=f.plan(f.goal(g.goalId),'automatic-next','execute_once');f.setEvents([event('automatic-next')]);await service.tick();const stale=f.store.goalDispatchCandidates()[0]!;f.db.prepare("UPDATE mandates SET state='revoked' WHERE task_id=?").run(next.taskIds[0]!);assert.throws(()=>f.runtime.startTask(stale),/GOAL_DISPATCH_NOT_CURRENT/);pump.step();assert.equal(f.store.runs(f.project.id).length,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_intents').get()!.n,2);
});
