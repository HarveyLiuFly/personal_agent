import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { ExecutionLedger, LedgerError } from '../packages/store/src/ledger.ts';
import { ForegroundExecution } from '../packages/runtime/src/execution.ts';
import type { ExecutionOptions } from '../packages/runtime/src/execution.ts';
import { StdioRpcClient } from '../packages/codex-adapter/src/rpc.ts';
import { DatabaseSync } from 'node:sqlite';
function fixture(t: { after(fn: () => void | Promise<void>): void }, mode = 'ok', prepareCode?: ExecutionOptions['prepareCode']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-agent-execution-'))), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const file = join(root, 'store.db'), receipts = join(root, 'receipts.txt');
  const store = new ExecutionLedger(file, readFileSync('docs/design/contracts/schema.sql', 'utf8')); store.startOwner('execution-fixture', true);
  const project = store.registerWorkspace(workspace);
  const runtime = new ForegroundExecution(store, { executable: process.execPath, stateDirectory: root, timeoutMs: 2000, ...(prepareCode ? {prepareCode} : {}),
    connect: callbacks => new StdioRpcClient({ executable: process.execPath, args: ['--disable-warning=ExperimentalWarning', resolve('tests/fixtures/execution-server.ts'), mode, file, receipts], requestTimeoutMs: 1500, ...callbacks }) });
  t.after(async () => { await runtime.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const input = { projectId: project.id, submissionKey: 'fixture-submission', text: 'Synthetic question, not a model request.' };
  return { root, store, project, runtime, input, file, receipts };
}
test('real stdio fixture sees committed intents before both requests and final projection preserves repeated deltas', async t => {
  const f = fixture(t), run = f.runtime.submit(f.input); await f.runtime.wait();
  const view = f.runtime.view({ projectId: f.project.id, runId: run.runId });
  assert.equal(view.status, 'completed',JSON.stringify(f.runtime.diagnostics)); assert.equal(view.taskStatus, 'needs_review');
  assert.equal(view.snapshot!.items.find(item => item.role === 'assistant')!.text, 'aab');
  assert.equal(view.snapshot!.needsSnapshot, false);
  assert.deepEqual(readFileSync(f.receipts, 'utf8').trim().split('\n'), ['thread/start','turn/start']);
  assert.equal(f.runtime.diagnostics.clientTurnStarts, 1);
  const db=new DatabaseSync(f.file,{readOnly:true});
  const verified=db.prepare("SELECT sequence FROM task_events WHERE run_id=? AND event_type='native_policy_verified'").get(run.runId)!;
  const sent=db.prepare("SELECT sequence FROM task_events WHERE run_id=? AND event_type='intent_prepared' AND json_extract(payload_json,'$.kind')='turn_start'").get(run.runId)!;
  assert.ok(Number(verified.sequence)<Number(sent.sequence));db.close();
});
test('duplicate keys after completion return the stored result without another transport', async t => {
  const f = fixture(t), first = f.runtime.submit(f.input); await f.runtime.wait();
  const duplicate = f.runtime.submit(f.input); await f.runtime.wait(); assert.equal(first.runId, duplicate.runId);
  assert.equal(f.runtime.diagnostics.clientTurnStarts, 1);
  assert.throws(() => f.runtime.submit({ ...f.input, text: 'changed' }), (e: unknown) => e instanceof LedgerError && e.code === 'IDEMPOTENCY_CONFLICT');
});
test('lost acceptance remains unknown even when a completed event was observed; no automatic resend', async t => {
  const f = fixture(t, 'drop-response'), run = f.runtime.submit(f.input); await f.runtime.wait();
  const view = f.runtime.view({ projectId: f.project.id, runId: run.runId });
  assert.equal(view.status, 'outcome_unknown'); assert.equal(view.turnId, null); assert.equal(view.blocked, true);
  assert.equal(f.runtime.diagnostics.clientTurnStarts, 1);
  assert.throws(() => f.runtime.submit({ ...f.input, submissionKey: 'new-key' }), /RUNTIME_BUSY/);
});
test('a disconnected server and a silent turn preserve Unknown and mark the snapshot stale', async t => {
  for (const mode of ['disconnect','silent']) {
    const f = fixture(t, mode), run = f.runtime.submit(f.input); await f.runtime.wait();
    const view = f.runtime.view({ projectId: f.project.id, runId: run.runId });
    assert.equal(view.status, 'outcome_unknown'); assert.equal(view.snapshot!.needsSnapshot, true);
  }
});
test('confirmed invalid protocol parameters reject once and do not leave a sending intent', async t => {
  const f = fixture(t, 'reject'), run = f.runtime.submit(f.input); await f.runtime.wait();
  assert.equal(f.runtime.view({ projectId: f.project.id, runId: run.runId }).status, 'failed');
  const db = new DatabaseSync(f.file, { readOnly: true });
  assert.equal(db.prepare("SELECT state FROM execution_intents WHERE kind='turn_start'").get()!.state, 'rejected'); db.close();
});
test('queries reject arbitrary keys, raw paths and foreign run IDs before exporting content', async t => {
  const f = fixture(t), run = f.runtime.submit(f.input); await f.runtime.wait();
  assert.throws(() => f.runtime.view({ projectId: f.project.id, runId: run.runId, path: '/etc/passwd' }), /INVALID_EXECUTION_QUERY/);
  assert.throws(() => f.runtime.view({ projectId: f.project.id, runId: 'foreign' }), /RUN_NOT_IN_PROJECT/);
  assert.throws(() => f.runtime.submit({ ...f.input, method: 'command/exec' }), /INVALID_EXECUTION_QUERY/);
});
test('concurrent different submission cannot create an orphan ledger run', async t => {
  const f = fixture(t, 'slow'), first = f.runtime.submit(f.input);
  assert.throws(() => f.runtime.submit({ ...f.input, submissionKey: 'concurrent' }), /RUNTIME_BUSY/);
  assert.equal(f.runtime.submit(f.input).runId, first.runId); await f.runtime.wait();
  assert.equal(f.store.runs(f.project.id).length, 1);
});
test('closing owner while running records Unknown and waits for the child process shutdown', async t => {
  const f = fixture(t, 'silent'), run = f.runtime.submit(f.input);
  const deadline=Date.now()+3000;while(!f.runtime.view({projectId:f.project.id,runId:run.runId}).turnId){assert.ok(Date.now()<deadline,'fixture turn must be accepted before close');await new Promise(resolve=>setTimeout(resolve,10));}
  await f.runtime.close();
  assert.equal(f.runtime.busy, false); assert.equal(f.runtime.view({ projectId: f.project.id, runId: run.runId }).status, 'outcome_unknown');
});
test('nonempty thread MCP inventory blocks a model turn even if disable overrides were supplied', async t => {
  const f = fixture(t, 'external-mcp'), run = f.runtime.submit(f.input); await f.runtime.wait();
  assert.equal(f.runtime.diagnostics.clientTurnStarts, 0);
  assert.equal(f.runtime.diagnostics.failureCode, 'EXTERNAL_TOOLS_NOT_DISABLED');
  assert.equal(f.runtime.view({ projectId: f.project.id, runId: run.runId }).status, 'failed');
});
test('configured servers explicitly disabled with zero tools are accepted as a closed inventory', async t => {
  const f = fixture(t, 'disabled-list'), run = f.runtime.submit(f.input); await f.runtime.wait();
  assert.equal(f.runtime.view({ projectId: f.project.id, runId: run.runId }).status, 'completed');
  assert.equal(f.runtime.diagnostics.externalMcpServers, 0);
});
test('an inherited automatic approval reviewer cannot bypass the Host broker before a model turn',async t=>{
 const f=fixture(t,'auto-review'),run=f.runtime.submit(f.input);await f.runtime.wait();
 assert.equal(f.runtime.diagnostics.clientTurnStarts,0);assert.equal(f.runtime.diagnostics.failureCode,'NATIVE_POLICY_NOT_ENFORCED');
 assert.equal(f.runtime.view({projectId:f.project.id,runId:run.runId}).status,'failed');
});
test('native network, write-root and temporary-directory expansion fail before any model turn',async t=>{
 for(const mode of ['unsafe-network','unsafe-roots','unsafe-temp']){
  const f=fixture(t,mode,async()=>{}),run=f.runtime.submit({...f.input,code:{profile:'node-test',target:'test.mjs',allowedPaths:['src.mjs']}});await f.runtime.wait();
  assert.equal(f.runtime.diagnostics.clientTurnStarts,0);assert.equal(f.runtime.diagnostics.failureCode,'NATIVE_POLICY_NOT_ENFORCED');
  assert.equal(f.runtime.view({projectId:f.project.id,runId:run.runId}).status,'failed');
 }
});
const code = {profile:'node-test' as const,target:'test/math.test.mjs',allowedPaths:['src/math.mjs']};
test('code execution requires a successful frozen contract before any RPC connection or model request', async t => {
  const f=fixture(t,'ok',async()=>{throw new LedgerError('BASELINE_TEST_EXECUTION_REQUIRED');});
  const run=f.runtime.submit({...f.input,code});await f.runtime.wait();
  assert.equal(f.runtime.view({projectId:f.project.id,runId:run.runId}).status,'failed');
  assert.equal(f.runtime.diagnostics.clientThreadStarts,0);assert.equal(f.runtime.diagnostics.clientTurnStarts,0);
  assert.equal(f.runtime.diagnostics.failureCode,'BASELINE_TEST_EXECUTION_REQUIRED');
});
test('stopping during contract preparation aborts without starting the native executor', async t => {
  const f=fixture(t,'ok',async(_token,_code,signal)=>{await new Promise<void>(done=>signal.addEventListener('abort',()=>done(),{once:true}));});
  const run=f.runtime.submit({...f.input,code});await f.runtime.interrupt({projectId:f.project.id,runId:run.runId});await f.runtime.wait();
  assert.equal(f.runtime.view({projectId:f.project.id,runId:run.runId}).status,'cancelled');
  assert.equal(f.runtime.diagnostics.clientThreadStarts,0);assert.equal(f.runtime.diagnostics.clientTurnStarts,0);
});
test('a changed code contract cannot reuse a submission key while preparation is in progress',async t=>{
  let release!:()=>void;const f=fixture(t,'ok',async()=>{await new Promise<void>(done=>{release=done;});throw new LedgerError('FIXTURE_PREPARATION_STOP');});
  const run=f.runtime.submit({...f.input,code});
  assert.equal(f.runtime.submit({...f.input,code}).runId,run.runId);
  assert.throws(()=>f.runtime.submit({...f.input,code:{...code,allowedPaths:['src/other.mjs']}}),/IDEMPOTENCY_CONFLICT/);
  release();await f.runtime.wait();assert.equal(f.runtime.diagnostics.clientTurnStarts,0);
});
test('known ended tasks continue with a fenced new Run and durable resume before sending, retaining the original binding',async t=>{
 const f=fixture(t),first=f.runtime.submit(f.input);await f.runtime.wait();
 const continued=f.runtime.continueRun({projectId:f.project.id,runId:first.runId,text:'Follow up synthetic prompt',submissionKey:'continuation'});await f.runtime.wait();
 assert.notEqual(continued.runId,first.runId);assert.equal(continued.taskId,first.taskId);assert.equal(f.runtime.view({projectId:f.project.id,runId:continued.runId}).threadId,f.runtime.view({projectId:f.project.id,runId:first.runId}).threadId);
 assert.equal(f.runtime.diagnostics.clientThreadStarts,1);assert.equal(f.runtime.diagnostics.clientThreadResumes,1);assert.equal(f.runtime.diagnostics.clientTurnStarts,2);
 assert.deepEqual(readFileSync(f.receipts,'utf8').trim().split('\n'),['thread/start','turn/start','thread/resume','turn/start']);
 assert.equal(f.runtime.continueRun({projectId:f.project.id,runId:first.runId,text:'Follow up synthetic prompt',submissionKey:'continuation'}).runId,continued.runId);
 assert.throws(()=>f.runtime.continueRun({projectId:f.project.id,runId:first.runId,text:'different',submissionKey:'continuation'}),/IDEMPOTENCY_CONFLICT/);
 assert.throws(()=>f.runtime.continueRun({projectId:f.project.id,runId:first.runId,text:'stale source',submissionKey:'another'}),/RUN_NOT_CONTINUABLE/);
});
test('Unknown tasks never become a new continuation',async t=>{
 const f=fixture(t,'drop-response'),run=f.runtime.submit(f.input);await f.runtime.wait();
 assert.throws(()=>f.runtime.continueRun({projectId:f.project.id,runId:run.runId,text:'must not resend',submissionKey:'blocked'}),/RUN_NOT_CONTINUABLE/);
 assert.equal(f.runtime.diagnostics.clientThreadResumes,0);assert.equal(f.store.runs(f.project.id).length,1);
});
