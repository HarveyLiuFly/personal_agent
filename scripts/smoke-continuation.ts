import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {verifiedCodex} from '../packages/codex-adapter/src/binary.ts';
import {ExecutionLedger,LedgerError} from '../packages/store/src/ledger.ts';
import {ForegroundExecution} from '../packages/runtime/src/execution.ts';
import {RpcFailure} from '../packages/codex-adapter/src/rpc.ts';
import {DatabaseSync} from 'node:sqlite';
const root=resolve(import.meta.dirname,'..'),binary=verifiedCodex(root),folder=realpathSync(process.argv[2]??'');assert.ok(basename(folder).startsWith('personal-agent-reconcile-'));
const store=new ExecutionLedger(join(folder,'ledger.db'),readFileSync(join(root,'docs/design/contracts/schema.sql'),'utf8'));store.startOwner(randomUUID(),true);
const project=store.projects()[0]!;assert.equal(project.directory,join(folder,'workspace'));
const source=store.runs(project.id)[0]!,marker=source.snapshot!.items.filter(i=>i.role==='assistant'&&i.kind==='message').at(-1)!.text.trim();assert.match(marker,/^M1_RECONCILED_[a-f0-9]{8}$/);
const runtime=new ForegroundExecution(store,{executable:binary.executable,stateDirectory:join(folder,'codex-state'),timeoutMs:90000});let evidence:Record<string,unknown>;
try{
 const run=runtime.continueRun({projectId:project.id,runId:source.runId,text:'Return exactly the marker beginning with M1_RECONCILED_ from the earlier user message, with no other text. Do not use tools or write files.',submissionKey:randomUUID()});await runtime.wait();
 const final=runtime.view({projectId:project.id,runId:run.runId}),assistant=final.snapshot!.items.filter(i=>i.role==='assistant'&&i.kind==='message').at(-1);
 assert.equal(final.status,'completed');assert.equal(final.taskStatus,'needs_review');assert.equal(final.threadId,source.threadId);assert.notEqual(final.turnId,source.turnId);assert.notEqual(final.runId,source.runId);assert.equal(final.taskId,source.taskId);assert.equal(assistant!.text.trim(),marker);
 assert.equal(runtime.diagnostics.clientThreadStarts,0);assert.equal(runtime.diagnostics.clientThreadResumes,1);assert.equal(runtime.diagnostics.clientTurnStarts,1);
 const db=new DatabaseSync(join(folder,'ledger.db'),{readOnly:true});const resume=db.prepare("SELECT state,execution_thread_id FROM execution_intents WHERE run_id=? AND kind='thread_resume'").get(final.runId)!;db.close();assert.equal(resume.state,'accepted');
 evidence={status:'passed',observedAt:new Date().toISOString(),kind:'real_native_thread_resume_and_fenced_continuation',platform:binary.platform,cliVersion:binary.lock.cliVersion,verifiedMethods:['thread/resume','turn/start'],inferenceRequested:true,scope:'CLI component probe in the original controlled workspace; one new real model turn, no Electron restart claim.',sourceRunId:source.runId,runId:final.runId,threadId:final.threadId,sourceTurnId:source.turnId,turnId:final.turnId,sameTask:true,sameThread:true,newRun:true,newTurn:true,priorContextMarkerMatched:true,taskStatus:final.taskStatus,diagnostics:runtime.diagnostics};
}catch(error){evidence={status:'blocked',observedAt:new Date().toISOString(),kind:'real_native_thread_resume_and_fenced_continuation',inferenceRequested:runtime.diagnostics.clientTurnStarts>0,code:error instanceof LedgerError||error instanceof RpcFailure?error.code:'PROBE_ASSERTION_FAILED',diagnostics:runtime.diagnostics};process.exitCode=1;}
finally{await runtime.close();store.close();}
const file=join(root,`docs/progress/evidence/${process.argv.includes('--policy-regression')?'M1.4a':'M1.3c'}-native-continuation.json`);writeFileSync(file,JSON.stringify(evidence,null,2)+'\n');writeFileSync(file.replace('.json',`-${String(evidence.observedAt).replaceAll(':','-').replaceAll('.','-')}.json`),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
