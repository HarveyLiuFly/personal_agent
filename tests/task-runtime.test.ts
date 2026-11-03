import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ExecutionLedger} from '../packages/store/src/ledger.ts';
import {ForegroundExecution} from '../packages/runtime/src/execution.ts';
import {TaskService} from '../packages/runtime/src/tasks.ts';
import {OutboxPump} from '../packages/runtime/src/outbox.ts';
import {StdioRpcClient} from '../packages/codex-adapter/src/rpc.ts';
function fixture(t:{after(fn:()=>unknown):void},mode='ok'){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-task-runtime-'))),cwd=join(root,'project'),file=join(root,'store.db');mkdirSync(cwd);const store=new ExecutionLedger(file,readFileSync('docs/design/contracts/schema.sql','utf8'));store.startOwner('task-runtime-owner',true);const project=store.registerWorkspace(cwd,cwd);let connections=0;
 const execution=new ForegroundExecution(store,{executable:process.execPath,stateDirectory:join(root,'state'),timeoutMs:5000,interruptTimeoutMs:40,connect:callbacks=>{connections++;return new StdioRpcClient({executable:process.execPath,args:[resolve('tests/fixtures/execution-server.ts'),mode,file],...callbacks});}}),service=new TaskService(store,execution);
 t.after(async()=>{await execution.close();store.close();rmSync(root,{recursive:true,force:true});});
 const create=(key='create')=>service.apply({projectId:project.id,commandKey:key,kind:'create',text:'controlled queued runtime task'});
 const waitTurn=async()=>{const deadline=Date.now()+3000;while(!store.runs(project.id)[0]?.turnId){if(Date.now()>deadline)throw new Error('TURN_FIXTURE_TIMEOUT');await new Promise(done=>setTimeout(done,10));}};
 return{root,cwd,store,project,execution,service,create,waitTurn,connections:()=>connections};
}
test('queue persistence performs no RPC; explicit start reuses the guarded Intent execution path exactly once',async t=>{
 const f=fixture(t),queued=await f.create();assert.equal(f.connections(),0);assert.equal(f.store.runs(f.project.id).length,0);
 const input={projectId:f.project.id,taskId:queued.taskId,expectedVersion:2,submissionKey:'start-key'},run=f.execution.startTask(input);assert.equal(f.execution.startTask(input).runId,run.runId);await f.execution.wait();
 assert.equal(f.connections(),1);assert.equal(f.execution.diagnostics.clientTurnStarts,1);assert.equal(f.execution.view({projectId:f.project.id,runId:run.runId}).taskStatus,'needs_review');
 assert.equal(f.execution.startTask(input).runId,run.runId);assert.equal(f.connections(),1);const pump=new OutboxPump(f.store);while(pump.step().claimed){}assert.ok(f.service.activity({projectId:f.project.id}).items.length>0);
});
test('active pause/resume/cancel uses the same Task and Thread but separate runs, with confirmed stop states',async t=>{
 const f=fixture(t,'interrupt-ok'),queued=await f.create(),first=f.execution.startTask({projectId:f.project.id,taskId:queued.taskId,expectedVersion:2,submissionKey:'first'});await f.waitTurn();
 await f.service.apply({projectId:f.project.id,taskId:queued.taskId,expectedVersion:f.store.tasks(f.project.id)[0]!.version,commandKey:'pause',kind:'pause'});await f.execution.wait();const paused=f.store.tasks(f.project.id)[0]!;assert.equal(paused.status,'paused');assert.equal(paused.activeRunId,null);
 const resumed=await f.service.apply({projectId:f.project.id,taskId:queued.taskId,expectedVersion:paused.version,commandKey:'resume',kind:'resume'}),second=f.execution.startTask({projectId:f.project.id,taskId:queued.taskId,expectedVersion:resumed.taskVersion,submissionKey:'second'});await f.waitTurn();
 await f.service.apply({projectId:f.project.id,taskId:queued.taskId,expectedVersion:f.store.tasks(f.project.id)[0]!.version,commandKey:'cancel',kind:'cancel'});await f.execution.wait();
 const records=f.store.runs(f.project.id);assert.equal(records.length,2);assert.notEqual(first.runId,second.runId);assert.equal(records[0]!.threadId,records[1]!.threadId);assert.equal(records[0]!.taskId,records[1]!.taskId);assert.equal(f.store.tasks(f.project.id)[0]!.status,'cancelled');assert.equal(f.execution.diagnostics.clientThreadResumes,1);assert.equal(f.execution.diagnostics.clientTurnStarts,2);
});
test('queue creation remains available during execution while another start is rejected without a second run',async t=>{
 const f=fixture(t,'interrupt-ok'),first=await f.create('first');f.execution.startTask({projectId:f.project.id,taskId:first.taskId,expectedVersion:2,submissionKey:'first-run'});await f.waitTurn();const second=await f.create('second');assert.equal(second.status,'queued');
 assert.throws(()=>f.execution.startTask({projectId:f.project.id,taskId:second.taskId,expectedVersion:2,submissionKey:'second-run'}),/RUNTIME_BUSY/);assert.equal(f.store.runs(f.project.id).length,1);
 await f.service.apply({projectId:f.project.id,taskId:first.taskId,expectedVersion:f.store.tasks(f.project.id).find(x=>x.taskId===first.taskId)!.version,commandKey:'cancel',kind:'cancel'});await f.execution.wait();
});
test('an unacknowledged interrupt retains an unknown operation and blocks new starts instead of resending',async t=>{
 const f=fixture(t,'interrupt-timeout'),queued=await f.create();f.execution.startTask({projectId:f.project.id,taskId:queued.taskId,expectedVersion:2,submissionKey:'run'});await f.waitTurn();
 const command={projectId:f.project.id,taskId:queued.taskId,expectedVersion:f.store.tasks(f.project.id)[0]!.version,commandKey:'cancel-unknown',kind:'cancel' as const};await f.service.apply(command);await f.execution.wait();const receipt=await f.service.apply(command);assert.equal(receipt.state,'outcome_unknown');assert.equal(receipt.status,'outcome_unknown');
 const another=await f.create('new-queue');assert.throws(()=>f.execution.startTask({projectId:f.project.id,taskId:another.taskId,expectedVersion:2,submissionKey:'unsafe-retry'}),/RUNTIME_BUSY/);assert.equal(f.execution.diagnostics.clientTurnStarts,1);assert.equal(f.connections(),1);
});
test('task entry points reject extra/prototype fields, cross-project targets and unavailable code execution',async t=>{
 const f=fixture(t),queued=await f.create();mkdirSync(join(f.root,'other'));const other=f.store.registerWorkspace(join(f.root,'other'),join(f.root,'other'));
 for(const input of [{projectId:f.project.id,path:'/'},Object.assign(Object.create({projectId:f.project.id}),{extra:1})])assert.throws(()=>f.service.list(input),/INVALID_TASK_QUERY/);
 assert.throws(()=>f.service.activity({projectId:f.project.id,cursor:0,argv:['x']}),/INVALID_TASK_QUERY/);assert.throws(()=>f.service.activity(Object.create({projectId:f.project.id})),/INVALID_TASK_QUERY/);
 assert.throws(()=>f.execution.startTask({projectId:other.id,taskId:queued.taskId,expectedVersion:2,submissionKey:'foreign'}),/TASK_NOT_IN_PROJECT/);assert.throws(()=>f.execution.startTask({projectId:f.project.id,taskId:queued.taskId,expectedVersion:2,submissionKey:'raw',argv:['x']}),/INVALID_EXECUTION_QUERY/);
 await assert.rejects(f.service.apply({projectId:f.project.id,commandKey:'code',kind:'create',text:'code fixture',code:{profile:'node-test',target:'test.mjs',allowedPaths:['src.mjs']}}),/CODE_EXECUTION_UNAVAILABLE/);assert.equal(f.connections(),0);assert.equal(f.store.tasks(f.project.id).length,1);
});
