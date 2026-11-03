import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {AppServerRuntime} from '../packages/codex-adapter/src/app-server.ts';
import type {RpcOptions} from '../packages/codex-adapter/src/rpc.ts';
import {ExecutionLedger} from '../packages/store/src/ledger.ts';
import {ForegroundExecution} from '../packages/runtime/src/execution.ts';
import {inspectCatalog} from '../packages/codex-adapter/src/smoke.ts';
function fixture(t:{after(fn:()=>Promise<void>):void},mode='usage'){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'pa-managed-execution-'))),cwd=join(root,'workspace');mkdirSync(cwd);
 const database=join(root,'store.db'),receipts=join(root,'receipts'),events=join(root,'metadata.jsonl');
 const store=new ExecutionLedger(database,readFileSync('docs/design/contracts/schema.sql','utf8'));store.startOwner('managed-fixture',true);const project=store.registerWorkspace(cwd);
 // Only the native executable is substituted: admission, manager, Run/Intent and shutdown remain real.
 class FixtureRuntime extends AppServerRuntime{
  override openDedicated(options:RpcOptions,fence:number){return super.openDedicated({...options,executable:process.execPath,args:[resolve('tests/fixtures/execution-server.ts'),mode,database,receipts]},fence);}
 }
 const runtime=new FixtureRuntime(()=>({executable:process.execPath,args:[resolve('tests/fixtures/app-server.ts'),events],env:process.env}));
 const execution=new ForegroundExecution(store,{executable:process.execPath,stateDirectory:root,runtime,timeoutMs:1500});
 t.after(async()=>{await execution.close();await runtime.close();store.close();rmSync(root,{recursive:true,force:true});});
 return{store,project,runtime,execution,receipts};
}
test('two Task turns reuse metadata but physically close separate execution processes before closure receipts',async t=>{
 const f=fixture(t),first=f.execution.submit({projectId:f.project.id,text:'Synthetic first turn',submissionKey:'first'});await f.execution.wait();
 assert.equal(f.store.runForHost(first.runId).status,'completed',JSON.stringify(f.execution.diagnostics));assert.ok(f.store.executorClosureRecorded(first.runId));assert.equal(f.runtime.snapshot().dedicatedProcesses,0);
 const meta=f.runtime.snapshot().metadataPid;
 const next=f.execution.continueRun({projectId:f.project.id,runId:first.runId,text:'Synthetic continuation',submissionKey:'second'});await f.execution.wait();
 assert.equal(f.store.runForHost(next.runId).status,'completed',JSON.stringify(f.execution.diagnostics));assert.ok(f.store.executorClosureRecorded(next.runId));assert.equal(f.runtime.snapshot().metadataPid,meta);assert.equal(f.runtime.snapshot().initializations,1);
 assert.deepEqual(readFileSync(f.receipts,'utf8').trim().split('\n'),['thread/start','turn/start','thread/resume','turn/start']);
});
test('lost dedicated acceptance remains Unknown while metadata reuse never resends a thread or turn',async t=>{
 const f=fixture(t,'drop-response'),run=f.execution.submit({projectId:f.project.id,text:'Synthetic lost response',submissionKey:'lost'});await f.execution.wait();
 assert.equal(f.store.runForHost(run.runId).status,'outcome_unknown');assert.ok(f.store.executorClosureRecorded(run.runId));
 await f.runtime.read(inspectCatalog);assert.equal(f.runtime.snapshot().initializations,1);assert.equal(f.execution.diagnostics.clientTurnStarts,1);
 assert.throws(()=>f.execution.submit({projectId:f.project.id,text:'Do not retry',submissionKey:'different'}),/RUNTIME_BUSY/);
});
test('privacy revocation stops actual execution and reset closes cached metadata before physical cleanup can start',async t=>{
 const f=fixture(t,'interrupt-timeout'),run=f.execution.submit({projectId:f.project.id,text:'Synthetic running task',submissionKey:'privacy'});
 const deadline=Date.now()+3000;while(!f.store.runForHost(run.runId).turnId){if(Date.now()>deadline)throw Error('TURN_NOT_STARTED');await new Promise(r=>setTimeout(r,10));}
 const result=await f.execution.revokeForPrivacy([run.runId]);assert.deepEqual(result.closedRunIds,[run.runId]);assert.equal(f.runtime.snapshot().dedicatedProcesses,0);
 await f.runtime.reset();assert.equal(f.runtime.snapshot().metadataPid,null);assert.equal(f.store.runForHost(run.runId).status,'outcome_unknown');assert.ok(f.store.executorClosureRecorded(run.runId));
});
