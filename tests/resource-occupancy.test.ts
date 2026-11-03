import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ExecutionLedger} from '../packages/store/src/ledger.ts';

const schema=readFileSync('docs/design/contracts/schema.sql','utf8');
const empty={modelActive:0,modelUnknown:0,terminalActive:0,terminalUnknown:0,worktreeActive:0,worktreeUnknown:0,writeLeases:0,queuedTasks:0};
function fixture(t:{after(fn:()=>void):void}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'personal-agent-occupancy-'))),file=join(root,'ledger.db'),cwd=join(root,'workspace');mkdirSync(cwd);const store=new ExecutionLedger(file,schema);store.startOwner('occupancy-owner',true);const project=store.registerWorkspace(cwd),db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON;');t.after(()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});});
  return{root,file,cwd,store,project,db};
}
function dump(db:DatabaseSync){return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>[row.name,db.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all()]);}
/** Real SQLite, synthetic process/Run states only. No native process, model or admission is started. */
function metadata(f:ReturnType<typeof fixture>,scope:{dotId:string;workspaceId:string;projectId:string},prefix:string){
  const {dotId,workspaceId,projectId}=scope,conversation=prefix+'-conversation',message=prefix+'-message',decision=prefix+'-decision';let index=0;
  f.db.prepare('INSERT INTO conversations VALUES (?,?)').run(conversation,dotId);
  f.db.prepare("INSERT INTO messages VALUES (?,?,?,'user','Public metadata fixture','hash','decided',1,NULL)").run(message,conversation,dotId);
  f.db.prepare("INSERT INTO router_decisions VALUES (?,?,'synthetic-occupancy','[]','{}',1)").run(decision,message);
  const task=(id:string,status='running',blocked=0)=>{const taskId=prefix+'-'+id;f.db.prepare('INSERT INTO tasks(task_id,dot_id,workspace_id,title,status,dispatch_blocked,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,1,1)').run(taskId,dotId,workspaceId,'Public synthetic task',status,blocked);return taskId;};
  const run=(state:string,id=state)=>{const taskId=task('task-'+id),runId=prefix+'-run-'+id;f.db.prepare("INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES (?,?,?,?,'codex',?,1,1,1,1,1,'synthetic-not-executed',9999999999999,1)").run(runId,taskId,dotId,runId,state);return runId;};
  const operation=(id:string)=>{const opId=prefix+'-'+id;f.db.prepare("INSERT INTO operations VALUES (?,?,?,NULL,'synthetic-occupancy','executing',NULL,'{}','hash',NULL)").run(opId,decision,index++);return opId;};
  const terminal=(state:string,id=state)=>{const sessionId=prefix+'-terminal-'+id,operationId=operation('terminal-op-'+id);f.db.prepare("INSERT INTO terminal_sessions VALUES (?,?,?,?,?,1,1,987650001,987650002,80,24,0,NULL,NULL,1)").run(sessionId,operationId,dotId,workspaceId,state);return sessionId;};
  const worktree=(state:string,id=state)=>{const operationId=operation('worktree-op-'+id);f.db.prepare("INSERT INTO worktree_operations VALUES (?,?,?,?,NULL,'create',?,1,1,987650003,'{}','hash',NULL,NULL,1)").run(operationId,dotId,projectId,workspaceId,state);return operationId;};
  return{task,run,terminal,worktree};
}
function local(f:ReturnType<typeof fixture>,prefix='local'){const row=f.db.prepare('SELECT project_id FROM workspaces WHERE workspace_id=?').get(f.project.id)!;return metadata(f,{dotId:f.store.dotId,workspaceId:f.project.id,projectId:String(row.project_id)},prefix);}

test('empty scoped occupancy is zero and repeated reads do not create budget buckets or execution data',t=>{
  const f=fixture(t),before=dump(f.db);assert.deepEqual(f.store.resourceOccupancy(),empty);assert.deepEqual(f.store.resourceOccupancy(),empty);assert.deepEqual(dump(f.db),before);for(const table of ['task_runs','execution_intents','budget_buckets','budget_reservations','schedules','sources'])assert.equal(f.db.prepare('SELECT count(*) AS n FROM '+table).get()!.n,0);
});
test('every supported lifecycle is counted as active, unknown or terminal without inferring process liveness',t=>{
  const f=fixture(t),seed=local(f);for(const state of ['preparing','submitting','running','waiting_input','waiting_approval','outcome_unknown','completed','failed','cancelled'])seed.run(state);for(const state of ['prepared','starting','running','stopping','outcome_unknown','exited'])seed.terminal(state);for(const state of ['prepared','dispatching','outcome_unknown','completed','failed'])seed.worktree(state);
  assert.deepEqual(f.store.resourceOccupancy(),{...empty,modelActive:5,modelUnknown:1,terminalActive:4,terminalUnknown:1,worktreeActive:2,worktreeUnknown:1});
});
test('Unknown rows remain held separately and only model workspace-write lease rows contribute to writeLeases',t=>{
  const f=fixture(t),seed=local(f),run=seed.run('running'),terminal=seed.terminal('running'),worktree=seed.worktree('dispatching'),project=String(f.db.prepare('SELECT project_id FROM workspaces').get()!.project_id);
  f.db.prepare('INSERT INTO workspace_write_leases VALUES (?,?,1,9999999999999)').run(f.project.id,run);f.db.prepare('INSERT INTO workspace_terminal_leases VALUES (?,?,1,1)').run(f.project.id,terminal);f.db.prepare('INSERT INTO project_operation_leases VALUES (?,?,1,1)').run(project,worktree);
  f.db.exec("UPDATE task_runs SET status='outcome_unknown';UPDATE terminal_sessions SET state='outcome_unknown';UPDATE worktree_operations SET state='outcome_unknown';");const before=dump(f.db);
  assert.deepEqual(f.store.resourceOccupancy(),{...empty,modelUnknown:1,terminalUnknown:1,worktreeUnknown:1,writeLeases:1});assert.deepEqual(dump(f.db),before);
});
test('queued count excludes dispatch-blocked and both Task tombstone spellings without claiming dispatchability',t=>{
  const f=fixture(t),seed=local(f);seed.task('visible','queued');seed.task('also-visible','queued');seed.task('blocked','queued',1);const raw=seed.task('raw-hidden','queued'),prefixed=seed.task('prefixed-hidden','queued');seed.task('paused','paused');seed.task('review','needs_review');
  f.db.prepare('INSERT INTO privacy_tombstones VALUES (?,?,2,1)').run(f.store.dotId,raw);f.db.prepare('INSERT INTO privacy_tombstones VALUES (?,?,2,1)').run(f.store.dotId,'task:'+prefixed);
  // A foreign deletion with the same opaque source reference must not hide a local queued row.
  f.db.prepare("INSERT INTO dots VALUES ('foreign-dot','local-profile','Synthetic foreign Dot',1,1)").run();f.db.prepare("INSERT INTO privacy_tombstones VALUES ('foreign-dot',?,2,1)").run('local-visible');
  const before=dump(f.db);assert.equal(f.store.resourceOccupancy().queuedTasks,2);assert.deepEqual(dump(f.db),before);
});
test('cross-Dot Run, PTY, Git operation, lease and queue metadata never leak into local counts',t=>{
  const f=fixture(t);f.db.exec("INSERT INTO dots VALUES ('foreign-dot','local-profile','Synthetic foreign Dot',1,1);INSERT INTO projects VALUES ('foreign-project','foreign-dot','/public/foreign','Foreign');INSERT INTO workspaces VALUES ('foreign-workspace','foreign-project','foreign-dot','/public/foreign','main','ready',0);");
  const seed=metadata(f,{dotId:'foreign-dot',workspaceId:'foreign-workspace',projectId:'foreign-project'},'foreign'),run=seed.run('running');seed.run('outcome_unknown');seed.terminal('running');seed.terminal('outcome_unknown');seed.worktree('dispatching');seed.worktree('outcome_unknown');seed.task('queued','queued');f.db.prepare('INSERT INTO workspace_write_leases VALUES (?,?,1,9999999999999)').run('foreign-workspace',run);
  const before=dump(f.db);assert.deepEqual(f.store.resourceOccupancy(),empty);assert.deepEqual(dump(f.db),before);
});
test('occupancy survives missing workspace directories and does not change budget, schedule or source state',t=>{
  const f=fixture(t),seed=local(f),run=seed.run('running'),taskId=String(f.db.prepare('SELECT task_id FROM task_runs WHERE run_id=?').get(run)!.task_id);
  f.db.prepare("INSERT INTO schedules VALUES ('schedule',?,1,'once','{}','UTC','active','coalesce','coalesce',1,9999999999999,NULL)").run(taskId);f.db.prepare("INSERT INTO sources VALUES ('source',?,'scheduler','synthetic','{}',1)").run(f.store.dotId);f.db.prepare("INSERT INTO budget_buckets VALUES ('bucket',?,NULL,'tokens',1,2,100,10,0)").run(f.store.dotId);f.db.prepare("INSERT INTO budget_reservations VALUES ('reservation','bucket',?,10,'active',NULL,NULL)").run(run);
  rmSync(f.cwd,{recursive:true});assert.throws(()=>f.store.workspace(f.project.id));const before=dump(f.db);assert.equal(f.store.resourceOccupancy().modelActive,1);assert.deepEqual(dump(f.db),before);assert.equal(f.db.prepare('SELECT state FROM schedules').get()!.state,'active');assert.equal(f.db.prepare('SELECT enabled FROM sources').get()!.enabled,1);
});
test('only the current Owner can read occupancy, and failed stale reads leave all metadata unchanged',t=>{
  const f=fixture(t),unclaimed=new ExecutionLedger(f.file,schema);try{assert.throws(()=>unclaimed.resourceOccupancy(),/STALE_RUNTIME_OWNER/);}finally{unclaimed.close();}
  const next=new ExecutionLedger(f.file,schema);try{next.startOwner('replacement-owner-fixture',true);const before=dump(f.db);assert.throws(()=>f.store.resourceOccupancy(),/STALE_RUNTIME_OWNER/);assert.deepEqual(dump(f.db),before);assert.deepEqual(next.resourceOccupancy(),empty);}finally{next.close();}
});
