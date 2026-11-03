import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { taskTransitions } from '../../../docs/design/contracts/domain.ts';
import type { TaskStatus } from '../../../docs/design/contracts/domain.ts';
import type { VerificationPlan, VerificationReceipt } from '../../verification/src/verification.ts';
import type { InteractionView, ProjectView, ThreadView } from '../../contracts/src/views.ts';
import type {CodeTaskSpec} from '../../contracts/src/views.ts';
import type {TaskSummary,TaskCommand,OperationReceipt,ActivityPage,TaskPlanCommand,TaskPlanView,TaskPlanNode,TaskPlanOperation} from '../../contracts/src/tasks.ts';
import {BudgetLedger} from './budget.ts';
import type {BudgetPolicy} from './budget.ts';
import {TerminalLedger} from './terminal.ts';
import type {OpenTerminal,TerminalHostSession,TerminalInputReceipt,TerminalSession,WriteTerminal} from '../../contracts/src/terminal.ts';
import {SchedulerLedger,scheduledRunKey} from './scheduler.ts';
import type {ScheduleCommand} from '../../contracts/src/schedules.ts';
import {ScheduleTimeError,scheduleTime} from '../../runtime/src/calendar.ts';
import type {GitWorkspaceSnapshot,ManagedWorktreeView,WorktreeDispatch,WorktreeOperationView,WorktreePayload} from '../../contracts/src/worktrees.ts';

export class LedgerError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
const fail = (code: string): never => { throw new LedgerError(code); };
export const hashInput = (input: unknown): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const active = "('preparing','submitting','running','waiting_input','waiting_approval','outcome_unknown')";
const taskCommandKinds={create:'CREATE_TASK',rename:'UPDATE_TASK',pause:'PAUSE_TASK',cancel:'CANCEL_TASK',resume:'CONTINUE_TASK'} as const;
type Row = Record<string, string | number | null>;
export interface RunToken { runId: string; epoch: number; taskFence: number }
export interface Intent { intentId: string; kind: string; state: string; inputHash: string; threadId: string | null; turnId: string | null; rpcId: string | null }
export interface RunRecord extends RunToken {
  taskId: string; workspaceId: string; title: string; taskStatus: string; status: string;
  threadId: string | null; turnId: string | null; blocked: boolean; snapshot: ThreadView | null;
  mode: 'readOnly' | 'workspaceWrite'; errorCode?: string;
}
export interface ReconciliationClaim {
  runId:string;taskId:string;workspaceId:string;threadId:string;turnId:string|null;
  taskVersion:number;runtimeEpoch:number;connectionEpoch:number;taskFence:number;userHash:string;
  priorTurnIds:string[];
}
export interface OutboxClaim {outboxId:string;claimEpoch:number;runtimeEpoch:number;eventId:string;taskId:string;expiresAt:number}
export interface QueuedRun {token:RunToken;created:boolean;text:string;code?:CodeTaskSpec;threadId?:string;sourceRunId?:string}
export interface LedgerOptions {/** Trusted fault injection only; never accepted over IPC. */afterOutboxProjectionForTests?:()=>void;afterPlanEffectForTests?:(index:number)=>void;afterScheduleTickForTests?:()=>void;afterScheduledClaimForTests?:()=>void;/** Trusted clock injection; never accepted over IPC. */schedulerClock?:()=>number;/** Seeds a new local policy only. Never accepted over execution IPC. */budgetPolicy?:BudgetPolicy}

/** Host-only local store. startOwner requires the caller to hold the OS single-instance lock. */
export class ExecutionLedger {
  #db: DatabaseSync;
  #epoch = 0;
  #instance = '';
  private options:LedgerOptions;
  private budget:BudgetLedger;
  private scheduler:SchedulerLedger;
  private terminals:TerminalLedger;
  readonly profileId = 'local-profile';
  readonly dotId = 'local-dot';
  constructor(path: string, schemaSql: string, options:LedgerOptions={}) {
    this.options=options;
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('LEDGER_SYMLINK_REJECTED');
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.length === 0) this.#db.exec(schemaSql);
      else if (!tables.some(row => row.name === 'schema_metadata')) fail('LEDGER_SCHEMA_UNSUPPORTED');
      const revision = this.one('SELECT schema_revision FROM schema_metadata WHERE singleton=1')?.schema_revision;
      if (revision === 2 || revision === 3 || revision === 4 || revision === 5) {
        const ddl=(name:string)=>schemaSql.match(new RegExp('CREATE TABLE '+name+' \\([\\s\\S]*?\\n\\);'))?.[0]??fail('LEDGER_MIGRATION_UNAVAILABLE');
        if (path !== ':memory:') {
          const backupPath = `${path}.revision${revision}-${randomUUID()}.backup`;
          this.#db.prepare('VACUUM INTO ?').run(backupPath); chmodSync(backupPath, 0o600);
          const backup = new DatabaseSync(backupPath, { readOnly: true });
          try { if (backup.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || backup.prepare('PRAGMA foreign_key_check').all().length) fail('LEDGER_BACKUP_INVALID'); }
          finally { backup.close(); }
        }
        this.tx(() => {
          if(revision===2)this.#db.exec(ddl('runtime_requests'));
          if(revision<=3)this.#db.exec('ALTER TABLE budget_reservations ADD COLUMN actual_units INTEGER CHECK (actual_units IS NULL OR actual_units>=0); ALTER TABLE budget_reservations ADD COLUMN settlement_hash TEXT;');
          if(revision<=3)for(const name of ['budget_policies','run_usage','thread_usage'])this.#db.exec(ddl(name));
          if(revision<=4)for(const name of ['worktree_operations','project_operation_leases','managed_worktrees'])this.#db.exec(ddl(name));
          for(const name of ['terminal_sessions','workspace_terminal_leases','terminal_inputs'])this.#db.exec(ddl(name));
          this.exec('UPDATE schema_metadata SET schema_revision=6 WHERE singleton=1');
        });
      } else if (revision !== 6) fail('LEDGER_SCHEMA_UNSUPPORTED');
      this.budget=new BudgetLedger(this.#db,this.dotId,fail,options.budgetPolicy);
      this.terminals=new TerminalLedger(this.#db,this.dotId,fail,{owner:()=>this.owner(),tx:work=>this.tx(work),context:id=>this.worktreeContext(id),available:id=>this.projectOperationAvailable(id),open:(key,kind,input)=>this.openOperation(key,kind,input,null,null),epoch:()=>this.#epoch});
      this.scheduler=new SchedulerLedger(this.#db,this.dotId,fail,{task:(projectId,taskId)=>{
        this.workspace(projectId);const task=this.taskRow(projectId,taskId),authority=this.taskAuthority(task),constraints=JSON.parse(String(task.constraints_json));
        if(typeof constraints.inputHash!=='string'||typeof constraints.text!=='string')return fail('TASK_INPUT_UNAVAILABLE');
        return{taskId,projectId,version:Number(task.version),status:String(task.status),blocked:task.dispatch_blocked===1,active:Boolean(this.one(`SELECT run_id FROM task_runs WHERE task_id=? AND status IN ${active}`,taskId)),authority,inputHash:constraints.inputHash,mode:String(constraints.mode)};
      },event:(taskId,type,payload)=>{this.event(taskId,null,type,payload);},transition:(taskId,status)=>{this.transition(taskId,status);}});
      if (path !== ':memory:') chmodSync(path, 0o600);
    } catch (error) { this.#db.close(); throw error; }
  }
  private one(sql: string, ...args: Array<string | number | null>): Row | undefined { return this.#db.prepare(sql).get(...args) as Row | undefined; }
  private all(sql: string, ...args: Array<string | number | null>): Row[] { return this.#db.prepare(sql).all(...args) as Row[]; }
  private exec(sql: string, ...args: Array<string | number | null>): void { this.#db.prepare(sql).run(...args); }
  private tx<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  private owner(): void {
    const current = this.one('SELECT * FROM runtime_owners WHERE profile_id=?', this.profileId);
    if (!current || current.runtime_epoch !== this.#epoch || current.instance_id !== this.#instance || current.state !== 'ready') fail('STALE_RUNTIME_OWNER');
  }
  private event(taskId: string, runId: string | null, type: string, payload: unknown = {}): string {
    this.exec('UPDATE tasks SET last_event_sequence=last_event_sequence+1,updated_at_ms=? WHERE task_id=?', Date.now(), taskId);
    const task = this.one('SELECT last_event_sequence,version FROM tasks WHERE task_id=?', taskId)!;
    const eventId = randomUUID(), data = JSON.stringify(payload);
    this.exec('INSERT INTO task_events VALUES (?,?,?,?,?,?,NULL,NULL,?,?)', eventId, taskId, runId, task.last_event_sequence!, task.version!, type, data, Date.now());
    this.exec("INSERT INTO outbox_events(outbox_id,dedupe_key,event_type,aggregate_ref,payload_json) VALUES (?,?,?,?,?)", randomUUID(), eventId, type, taskId, data);
    return eventId;
  }
  private transition(taskId: string, target: TaskStatus): void {
    const task = this.one('SELECT status FROM tasks WHERE task_id=?', taskId);
    if (!task || !taskTransitions[task.status as TaskStatus].includes(target)) fail('INVALID_TASK_TRANSITION');
    this.exec('UPDATE tasks SET status=?,version=version+1,updated_at_ms=? WHERE task_id=?', target, Date.now(), taskId);
    if(target==='paused'||target==='cancelled'||target==='completed')this.scheduler.stopTask(taskId,target==='paused'?'paused':'cancelled');
  }
  private projectOperationAvailable(workspaceId:string):void {
    if(this.one('SELECT l.session_id FROM workspace_terminal_leases l JOIN workspaces w ON w.workspace_id=l.workspace_id JOIN workspaces scope ON scope.project_id=w.project_id WHERE scope.workspace_id=? AND scope.dot_id=?',workspaceId,this.dotId))return fail('WORKSPACE_TERMINAL_ACTIVE');
    if(this.one('SELECT l.operation_id FROM project_operation_leases l JOIN workspaces w USING(project_id) WHERE w.workspace_id=? AND w.dot_id=?',workspaceId,this.dotId))return fail('WORKSPACE_BUSY');
  }
  startOwner(instanceId: string, exclusiveLockHeld: true): number {
    if (!id(instanceId) || exclusiveLockHeld !== true || this.#epoch) return fail('OWNER_LOCK_REQUIRED');
    const epoch = this.tx(() => {
      this.exec('INSERT OR IGNORE INTO profiles VALUES (?,?,?)', this.profileId, '本机', Date.now());
      this.exec('INSERT OR IGNORE INTO dots(dot_id,profile_id,display_name) VALUES (?,?,?)', this.dotId, this.profileId, 'Personal Agent');
      this.budget.initialize();
      const next = Number(this.one('SELECT runtime_epoch FROM runtime_owners WHERE profile_id=?', this.profileId)?.runtime_epoch ?? 0) + 1;
      this.exec("INSERT INTO runtime_owners VALUES (?,?,?,'main','ready',?) ON CONFLICT(profile_id) DO UPDATE SET runtime_epoch=excluded.runtime_epoch,instance_id=excluded.instance_id,state='ready',updated_at_ms=excluded.updated_at_ms", this.profileId, next, instanceId, Date.now());
      this.exec("UPDATE runtime_requests SET state=CASE WHEN state='responding' THEN 'outcome_unknown' ELSE 'cancelled' END WHERE state IN ('pending','responding')");
      this.exec("UPDATE outbox_events SET lease_until_ms=0 WHERE state='claimed' AND aggregate_ref IN (SELECT task_id FROM tasks WHERE dot_id=?)",this.dotId);
      this.terminals.recover();
      for(const op of this.all("SELECT * FROM worktree_operations WHERE dot_id=? AND state IN ('prepared','dispatching')",this.dotId)){
        const state=op.state==='prepared'&&!JSON.parse(String(op.payload_json)).repairOf?'failed':'outcome_unknown';this.exec('UPDATE worktree_operations SET state=?,error_code=? WHERE operation_id=?',state,op.state==='prepared'?'OWNER_STOPPED_BEFORE_SEND':'OWNER_RECOVERY_UNKNOWN',op.operation_id!);this.exec('UPDATE operations SET state=? WHERE operation_id=?',state,op.operation_id!);
        if(state==='failed')this.exec('DELETE FROM project_operation_leases WHERE operation_id=?',op.operation_id!);
      }
      for (const run of this.all(`SELECT * FROM task_runs WHERE status IN ${active} AND dot_id=?`, this.dotId)) {
        this.exec("UPDATE execution_intents SET state='outcome_unknown' WHERE run_id=? AND state='sending'", run.run_id!);
        this.exec("UPDATE execution_intents SET state='rejected',response_ref='owner_stopped_before_send' WHERE run_id=? AND state='prepared'", run.run_id!);
        this.exec("UPDATE task_runs SET status='outcome_unknown' WHERE run_id=?", run.run_id!);
        const task = this.one('SELECT status FROM tasks WHERE task_id=?', run.task_id!)!;
        if (task.status !== 'outcome_unknown') this.transition(String(run.task_id), 'outcome_unknown');
        this.exec('UPDATE tasks SET dispatch_blocked=1 WHERE task_id=?', run.task_id!);
        this.budget.unknown(String(run.run_id),true);
        this.event(String(run.task_id), String(run.run_id), 'owner_recovery_unknown');
        this.stopOperation(String(run.task_id),'outcome_unknown',String(run.run_id));
      }
      return next;
    });
    this.#epoch = epoch; this.#instance = instanceId; return epoch;
  }
  registerWorkspace(directory: string, gitRoot?: string): ProjectView {
    this.owner();
    const cwd = realpathSync(directory), info = statSync(cwd, { bigint: true });
    if (!info.isDirectory()) return fail('PROJECT_NOT_DIRECTORY');
    const known=this.one("SELECT workspace_id FROM workspaces WHERE dot_id=? AND canonical_cwd=?",this.dotId,cwd);if(known)return this.workspace(String(known.workspace_id));
    let detected = gitRoot;
    if (!detected) {
      try { detected = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000, maxBuffer: 8192, stdio: ['ignore','pipe','ignore'] }).trim(); } catch {}
    }
    const root = realpathSync(detected || cwd);
    return this.tx(() => {
      this.owner();
      let project = this.one('SELECT * FROM projects WHERE dot_id=? AND canonical_git_root=?', this.dotId, root);
      if (!project) {
        const projectId = randomUUID();
        this.exec('INSERT INTO projects VALUES (?,?,?,?)', projectId, this.dotId, root, basename(root));
        project = this.one('SELECT * FROM projects WHERE project_id=?', projectId)!;
      }
      let workspace = this.one('SELECT * FROM workspaces WHERE dot_id=? AND canonical_cwd=?', this.dotId, cwd);
      if (!workspace) {
        if (Number(this.one("SELECT COUNT(*) AS n FROM workspaces WHERE dot_id=? AND state<>'archived'", this.dotId)!.n) >= 16) return fail('PROJECT_LIMIT');
        const workspaceId = randomUUID();
        this.exec("INSERT INTO workspaces(workspace_id,project_id,dot_id,canonical_cwd,kind,state) VALUES (?,?,?,?,?,'ready')", workspaceId, project.project_id!, this.dotId, cwd, detected ? 'main' : 'external');
        this.exec('INSERT INTO workspace_identities VALUES (?,?,?)', workspaceId, String(info.dev), String(info.ino));
        workspace = this.one('SELECT * FROM workspaces WHERE workspace_id=?', workspaceId)!;
      }
      // Reselecting a replaced directory cannot renew an active/unknown execution's authority.
      const identity = this.one('SELECT * FROM workspace_identities WHERE workspace_id=?', workspace.workspace_id!)!;
      if (identity.device_id !== String(info.dev) || identity.inode !== String(info.ino)) return fail('PROJECT_IDENTITY_CHANGED');
      return { id: String(workspace.workspace_id), name: basename(cwd), directory: cwd };
    });
  }
  projects(): ProjectView[] {
    return this.all("SELECT w.workspace_id,w.canonical_cwd,m.display_name FROM workspaces w LEFT JOIN managed_worktrees m USING(workspace_id) WHERE w.dot_id=? AND w.state<>'archived' ORDER BY w.rowid LIMIT 100", this.dotId)
      .map(row => ({ id: String(row.workspace_id), directory: String(row.canonical_cwd), name: row.display_name?String(row.display_name):basename(String(row.canonical_cwd)) }));
  }
  workspace(workspaceId: string): ProjectView {
    const row = this.one('SELECT w.*,i.device_id,i.inode FROM workspaces w JOIN workspace_identities i USING(workspace_id) WHERE workspace_id=? AND dot_id=?', workspaceId, this.dotId);
    if (!row) return fail('UNKNOWN_PROJECT');
    if(row.state==='archived')return fail('PROJECT_ARCHIVED');if(row.state==='invalid')return fail('PROJECT_INVALID');
    try {
      const cwd = realpathSync(String(row.canonical_cwd)), info = statSync(cwd, { bigint: true });
      if (cwd !== row.canonical_cwd || !info.isDirectory() || String(info.dev) !== row.device_id || String(info.ino) !== row.inode) return fail('PROJECT_IDENTITY_CHANGED');
      const managed=this.worktreeMetadata(workspaceId);
      if(managed){
        for(const expected of [managed.gitIdentity,managed.commonIdentity]){const s=lstatSync(expected.directory,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(expected.directory)!==expected.directory||String(s.dev)!==expected.device||String(s.ino)!==expected.inode)return fail('WORKTREE_IDENTITY_CHANGED');}
        const pointer=join(cwd,'.git'),s=lstatSync(pointer);if(!s.isFile()||s.isSymbolicLink()||s.size>4096||readFileSync(pointer,'utf8')!==`gitdir: ${managed.gitDir}\n`)return fail('WORKTREE_IDENTITY_CHANGED');
        const common=join(managed.gitDir,'commondir');if(lstatSync(common).isSymbolicLink()||realpathSync(resolve(managed.gitDir,readFileSync(common,'utf8').trim()))!==managed.commonDir)return fail('WORKTREE_IDENTITY_CHANGED');
      }
      return { id: workspaceId, name: managed?this.managedWorktree(workspaceId).name:basename(cwd), directory: cwd };
    } catch (error) { if (error instanceof LedgerError) throw error; return fail('PROJECT_UNAVAILABLE'); }
  }
  terminalOpen(input:OpenTerminal):{session:TerminalHostSession;created:boolean}{return this.terminals.open(input);}
  terminalHost(projectId:string,sessionId:string):TerminalHostSession{return this.terminals.host(projectId,sessionId);}
  terminalLatest(projectId:string):TerminalSession|null{return this.terminals.latest(projectId);}
  terminalDispatch(projectId:string,sessionId:string,pid:number):void{this.terminals.dispatch(projectId,sessionId,pid);}
  terminalStarted(projectId:string,sessionId:string,pid:number):void{this.terminals.started(projectId,sessionId,pid);}
  terminalInput(input:WriteTerminal):{receipt:TerminalInputReceipt;created:boolean}{return this.terminals.input(input);}
  terminalInputAccepted(projectId:string,sessionId:string,sequence:number):void{this.terminals.acceptInput(projectId,sessionId,sequence);}
  terminalResize(projectId:string,sessionId:string,cols:number,rows:number):void{this.terminals.resize(projectId,sessionId,cols,rows);}
  terminalCloseRequest(projectId:string,sessionId:string,key:string):boolean{return this.terminals.requestClose(projectId,sessionId,key);}
  terminalFinished(projectId:string,sessionId:string,code:number|null,errorCode?:string,reconciled=false):void{this.terminals.finish(projectId,sessionId,code,errorCode,reconciled);}
  terminalUnknown(projectId:string,sessionId:string,code:string):void{this.terminals.unknown(projectId,sessionId,code);}
  worktreeScope(workspaceId:string):{projectId:string;root:string} {
    const row=this.one('SELECT p.* FROM projects p JOIN workspaces w USING(project_id) WHERE w.workspace_id=? AND w.dot_id=?',workspaceId,this.dotId)??fail('UNKNOWN_PROJECT');return{projectId:String(row.project_id),root:String(row.canonical_git_root)};
  }
  worktreeContext(workspaceId:string):{projectId:string;root:string;workspace:ProjectView} {return{...this.worktreeScope(workspaceId),workspace:this.workspace(workspaceId)};}
  managedWorktree(workspaceId:string):ManagedWorktreeView {
    const row=this.one('SELECT m.*,w.canonical_cwd FROM managed_worktrees m JOIN workspaces w USING(workspace_id) WHERE workspace_id=? AND w.dot_id=?',workspaceId,this.dotId)??fail('WORKTREE_NOT_MANAGED');
    return{id:workspaceId,name:String(row.display_name),directory:String(row.canonical_cwd),sourceWorkspaceId:String(row.source_workspace_id),branch:String(row.branch),baseCommit:String(row.base_commit),version:Number(row.version),state:row.state as ManagedWorktreeView['state']};
  }
  worktreeMetadata(workspaceId:string):GitWorkspaceSnapshot|null {
    const row=this.one('SELECT m.git_identity_json FROM managed_worktrees m JOIN workspaces w USING(workspace_id) WHERE workspace_id=? AND w.dot_id=?',workspaceId,this.dotId);return row?JSON.parse(String(row.git_identity_json)):null;
  }
  worktreePendingTasks(workspaceId:string):number {
    return Number(this.one("SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=? AND dot_id=? AND status NOT IN ('completed','cancelled')",workspaceId,this.dotId)!.n);
  }
  worktreeOperations(workspaceId:string):WorktreeOperationView[] {
    const context=this.worktreeScope(workspaceId);
    return this.all('SELECT * FROM worktree_operations WHERE project_id=? AND dot_id=? ORDER BY created_at_ms DESC,rowid DESC LIMIT 20',context.projectId,this.dotId).map(row=>{const p=JSON.parse(String(row.payload_json)) as WorktreePayload;return{operationId:String(row.operation_id),kind:p.repairOf?'repairRemove':row.kind as 'create'|'remove',state:row.state as WorktreeOperationView['state'],workspaceId:row.target_workspace_id as string|null,name:p.name,branch:p.branch,errorCode:row.error_code as string|null,createdAt:Number(row.created_at_ms)};});
  }
  worktreeList(workspaceId:string):ManagedWorktreeView[] {
    const context=this.worktreeScope(workspaceId);return this.all("SELECT m.workspace_id FROM managed_worktrees m JOIN workspaces w USING(workspace_id) WHERE w.project_id=? AND w.dot_id=? AND m.state<>'removed' ORDER BY w.rowid LIMIT 16",context.projectId,this.dotId).map(row=>this.managedWorktree(String(row.workspace_id)));
  }
  worktreeReplay(workspaceId:string,key:string,input:unknown,kind:'create'|'remove'|'repairRemove'):WorktreeDispatch|null {
    this.owner();this.worktreeContext(workspaceId);const row=this.one('SELECT o.* FROM operations o JOIN router_decisions d USING(decision_id) JOIN messages m USING(message_id) WHERE decision_id=? AND m.dot_id=?','command:'+hashInput([this.dotId,'worktree:'+key]),this.dotId);
    if(!row)return null;if(row.input_hash!==hashInput(input)||row.kind!==(kind==='create'?'CREATE_WORKTREE':kind==='remove'?'REMOVE_WORKTREE':'REPAIR_WORKTREE_REMOVAL'))return fail('IDEMPOTENCY_CONFLICT');return this.worktreeDispatch(workspaceId,String(row.operation_id));
  }
  prepareWorktree(workspaceId:string,key:string,input:unknown,kind:'create'|'remove',source:GitWorkspaceSnapshot,managedRoot:string,target?:{workspaceId:string;version:number;snapshot:GitWorkspaceSnapshot;inspectionHash:string}):WorktreeDispatch {
    if(!id(key))return fail('INVALID_WORKTREE_COMMAND');const context=this.worktreeContext(workspaceId);
    return this.tx(()=>{
      this.owner();const opened=this.openOperation('worktree:'+key,kind==='create'?'CREATE_WORKTREE':'REMOVE_WORKTREE',input,null,null);if(!opened.created)return this.worktreeDispatch(workspaceId,opened.operationId);
      this.projectOperationAvailable(workspaceId);
      if(this.one(`SELECT r.run_id FROM task_runs r JOIN tasks t USING(task_id) JOIN workspaces w ON w.workspace_id=t.workspace_id WHERE w.project_id=? AND r.status IN ${active}`,context.projectId))return fail('WORKSPACE_BUSY');
      if(this.one('SELECT l.run_id FROM workspace_write_leases l JOIN workspaces w USING(workspace_id) WHERE w.project_id=?',context.projectId))return fail('WORKSPACE_BUSY');
      const targetId=kind==='create'?randomUUID():target?.workspaceId??fail('WORKTREE_NOT_MANAGED');
      let payload:WorktreePayload;
      if(kind==='create'){
        if(Number(this.one("SELECT COUNT(*) AS n FROM workspaces WHERE dot_id=? AND state<>'archived'",this.dotId)!.n)>=16)return fail('PROJECT_LIMIT');
        const name=(input as {name:string}).name;if(typeof name!=='string'||!name.trim()||name.length>80||/[\x00-\x1f]/.test(name))return fail('INVALID_WORKTREE_NAME');
        payload={name,targetId,targetDirectory:join(resolve(managedRoot),targetId),branch:'codex/worktree-'+targetId,baseCommit:source.head,executionDirectory:context.root,source};
      }else{
        const managed=this.managedWorktree(targetId);if(managed.state!=='ready'||managed.version!==target!.version||this.worktreeContext(targetId).projectId!==context.projectId)return fail('WORKTREE_VERSION_CONFLICT');
        if(this.worktreePendingTasks(targetId))return fail('WORKTREE_PENDING_TASKS');
        payload={name:managed.name,targetId,targetDirectory:managed.directory,branch:managed.branch,baseCommit:managed.baseCommit,executionDirectory:context.root,source,target:target!.snapshot,inspectionHash:target!.inspectionHash,recoveryDirectory:join(resolve(managedRoot),'..','removed',targetId+'-'+opened.operationId)};
      }
      this.exec('UPDATE workspaces SET write_fence=write_fence+1 WHERE workspace_id=?',workspaceId);const fence=Number(this.one('SELECT write_fence FROM workspaces WHERE workspace_id=?',workspaceId)!.write_fence);
      this.exec("INSERT INTO worktree_operations(operation_id,dot_id,project_id,source_workspace_id,target_workspace_id,kind,state,source_fence,runtime_epoch,payload_json,payload_sha256,created_at_ms) VALUES (?,?,?,?,?,?,'prepared',?,?,?,?,?)",opened.operationId,this.dotId,context.projectId,workspaceId,kind==='remove'?targetId:null,kind,fence,this.#epoch,JSON.stringify(payload),hashInput(payload),Date.now());
      this.exec('INSERT INTO project_operation_leases VALUES (?,?,?,?)',context.projectId,opened.operationId,this.#epoch,fence);return this.worktreeDispatch(workspaceId,opened.operationId);
    });
  }
  worktreeRecoveries(workspaceId:string):WorktreeDispatch[] {
    const context=this.worktreeScope(workspaceId);return this.all("SELECT operation_id FROM worktree_operations WHERE project_id=? AND dot_id=? AND kind='remove' AND json_extract(payload_json,'$.repairOf') IS NULL AND state IN ('completed','outcome_unknown') ORDER BY created_at_ms DESC,rowid DESC LIMIT 100",context.projectId,this.dotId).map(row=>this.worktreeDispatch(workspaceId,String(row.operation_id)));
  }
  currentWorktreeOperation(workspaceId:string):WorktreeDispatch|null {
    const context=this.worktreeScope(workspaceId),row=this.one('SELECT operation_id FROM project_operation_leases WHERE project_id=?',context.projectId);return row?this.worktreeDispatch(workspaceId,String(row.operation_id)):null;
  }
  prepareWorktreeRepair(workspaceId:string,key:string,input:unknown,parentId:string,source:GitWorkspaceSnapshot):WorktreeDispatch {
    if(!id(key))return fail('INVALID_WORKTREE_COMMAND');const context=this.worktreeContext(workspaceId);
    return this.tx(()=>{this.owner();const opened=this.openOperation('worktree:'+key,'REPAIR_WORKTREE_REMOVAL',input,null,null);if(!opened.created)return this.worktreeDispatch(workspaceId,opened.operationId);
      const parent=this.worktreeDispatch(workspaceId,parentId),lease=this.one('SELECT * FROM project_operation_leases WHERE project_id=?',context.projectId);
      if(this.one('SELECT w.write_fence FROM worktree_operations o JOIN workspaces w ON w.workspace_id=o.source_workspace_id WHERE o.operation_id=?',parentId)?.write_fence!==parent.sourceFence)return fail('STALE_WORKTREE_OPERATION');
      if(parent.kind!=='remove'||parent.state!=='outcome_unknown'||!parent.payload.recoveryDirectory||!parent.payload.target||lease?.operation_id!==parentId||lease.source_fence!==parent.sourceFence)return fail('WORKTREE_REPAIR_NOT_ALLOWED');
      let ancestor:string|undefined=parentId;for(let depth=0;ancestor;depth++){if(depth>=8)return fail('WORKTREE_REPAIR_CHAIN_LIMIT');ancestor=this.worktreeDispatch(workspaceId,ancestor).payload.repairOf;}
      this.exec('UPDATE workspaces SET write_fence=write_fence+1 WHERE workspace_id=?',workspaceId);const fence=Number(this.one('SELECT write_fence FROM workspaces WHERE workspace_id=?',workspaceId)!.write_fence),payload:WorktreePayload={...parent.payload,source,executionDirectory:context.root,repairOf:parentId};
      this.exec("INSERT INTO worktree_operations(operation_id,dot_id,project_id,source_workspace_id,target_workspace_id,kind,state,source_fence,runtime_epoch,payload_json,payload_sha256,created_at_ms) VALUES (?,?,?,?,?,'remove','prepared',?,?,?,?,?)",opened.operationId,this.dotId,context.projectId,workspaceId,payload.targetId,fence,this.#epoch,JSON.stringify(payload),hashInput(payload),Date.now());
      this.exec('UPDATE project_operation_leases SET operation_id=?,runtime_epoch=?,source_fence=? WHERE project_id=?',opened.operationId,this.#epoch,fence,context.projectId);return this.worktreeDispatch(workspaceId,opened.operationId);
    });
  }
  worktreeDispatch(workspaceId:string,operationId:string):WorktreeDispatch {
    const context=this.worktreeScope(workspaceId),row=this.one('SELECT * FROM worktree_operations WHERE operation_id=? AND project_id=? AND dot_id=?',operationId,context.projectId,this.dotId)??fail('WORKTREE_OPERATION_NOT_FOUND');
    const payload=JSON.parse(String(row.payload_json));if(hashInput(payload)!==row.payload_sha256)return fail('WORKTREE_PAYLOAD_CHANGED');return{operationId,kind:row.kind as 'create'|'remove',state:row.state as WorktreeDispatch['state'],payload,runtimeEpoch:Number(row.runtime_epoch),sourceFence:Number(row.source_fence),supervisorPid:row.supervisor_pid as number|null,createdAt:Number(row.created_at_ms)};
  }
  dispatchWorktree(workspaceId:string,operationId:string,pid:number):void {
    this.tx(()=>{this.owner();const op=this.worktreeDispatch(workspaceId,operationId);if(op.state!=='prepared'||op.runtimeEpoch!==this.#epoch||!Number.isSafeInteger(pid)||pid<2)return fail('STALE_WORKTREE_OPERATION');
      this.exec("UPDATE worktree_operations SET state='dispatching',supervisor_pid=? WHERE operation_id=?",pid,operationId);this.exec("UPDATE operations SET state='executing' WHERE operation_id=?",operationId);
    });
  }
  recordWorktreeArchive(workspaceId:string,operationId:string,pid:number):boolean {
    return this.tx(()=>{this.owner();const op=this.worktreeDispatch(workspaceId,operationId),row=this.one('SELECT source_workspace_id,result_json FROM worktree_operations WHERE operation_id=?',operationId)!;
      if(op.kind!=='remove'||op.payload.repairOf||op.state!=='dispatching'||op.runtimeEpoch!==this.#epoch||op.supervisorPid!==pid||!this.one('SELECT operation_id FROM project_operation_leases WHERE operation_id=? AND source_fence=?',operationId,op.sourceFence)||this.one('SELECT write_fence FROM workspaces WHERE workspace_id=?',row.source_workspace_id!)?.write_fence!==op.sourceFence)return fail('STALE_WORKTREE_OPERATION');
      if(row.result_json&&JSON.parse(String(row.result_json)).phase==='archived')return false;this.exec('UPDATE worktree_operations SET result_json=? WHERE operation_id=?',JSON.stringify({phase:'archived'}),operationId);return true;
    });
  }
  finishWorktree(workspaceId:string,operationId:string,outcome:'completed'|'failed'|'outcome_unknown',snapshot?:GitWorkspaceSnapshot,errorCode?:string,reconciled=false):void {
    this.tx(()=>{this.owner();const op=this.worktreeDispatch(workspaceId,operationId),row=this.one('SELECT * FROM worktree_operations WHERE operation_id=?',operationId)!;
      if(!['prepared','dispatching','outcome_unknown'].includes(op.state)||(!reconciled&&op.runtimeEpoch!==this.#epoch)||op.state==='outcome_unknown'&&!reconciled)return fail('STALE_WORKTREE_OPERATION');
      const lease=this.one('SELECT * FROM project_operation_leases WHERE operation_id=?',operationId);if(!lease||lease.source_fence!==op.sourceFence||this.one('SELECT write_fence FROM workspaces WHERE workspace_id=?',row.source_workspace_id!)?.write_fence!==op.sourceFence)return fail('STALE_WORKTREE_OPERATION');
      if(op.payload.repairOf&&outcome==='failed'&&!reconciled)outcome='outcome_unknown';
      if(outcome==='completed'&&op.kind==='create'){
        if(!snapshot||snapshot.directory!==op.payload.targetDirectory||snapshot.head!==op.payload.baseCommit||snapshot.commonDir!==op.payload.source.commonDir)return fail('WORKTREE_RESULT_MISMATCH');
        const p=op.payload;this.exec("INSERT INTO workspaces(workspace_id,project_id,dot_id,canonical_cwd,kind,state) VALUES (?,?,?,?,'worktree','ready')",p.targetId,row.project_id!,this.dotId,p.targetDirectory);
        this.exec('INSERT INTO workspace_identities VALUES (?,?,?)',p.targetId,snapshot.rootIdentity.device,snapshot.rootIdentity.inode);
        this.exec("INSERT INTO managed_worktrees(workspace_id,source_workspace_id,create_operation_id,display_name,branch,base_commit,git_dir,common_dir,git_identity_json,state) VALUES (?,?,?,?,?,?,?,?,?,'ready')",p.targetId,row.source_workspace_id!,operationId,p.name,p.branch,p.baseCommit,snapshot.gitDir,snapshot.commonDir,JSON.stringify(snapshot));
        this.exec('UPDATE worktree_operations SET target_workspace_id=? WHERE operation_id=?',p.targetId,operationId);
      }
      if(outcome==='completed'&&op.kind==='remove'){this.exec("UPDATE managed_worktrees SET state='removed',version=version+1 WHERE workspace_id=? AND state<>'removed'",op.payload.targetId);this.exec("UPDATE workspaces SET state='archived' WHERE workspace_id=?",op.payload.targetId);}
      this.exec('UPDATE worktree_operations SET state=?,result_json=?,error_code=? WHERE operation_id=?',outcome,JSON.stringify({workspaceId:op.payload.targetId}),errorCode??null,operationId);this.exec('UPDATE operations SET state=?,result_ref=? WHERE operation_id=?',outcome,'worktree-result:'+operationId,operationId);
      if(outcome!=='outcome_unknown'){
        let ancestor=op.payload.repairOf;for(let depth=0;ancestor;depth++){if(depth>=8)return fail('WORKTREE_REPAIR_CHAIN_LIMIT');const parent=this.worktreeDispatch(workspaceId,ancestor);if(parent.kind!=='remove'||parent.state!=='outcome_unknown'||parent.payload.targetId!==op.payload.targetId)return fail('WORKTREE_REPAIR_PARENT_CHANGED');
          this.exec('UPDATE worktree_operations SET state=?,result_json=?,error_code=? WHERE operation_id=?',outcome,JSON.stringify({workspaceId:op.payload.targetId,resolvedBy:operationId}),errorCode??null,ancestor);this.exec('UPDATE operations SET state=?,result_ref=? WHERE operation_id=?',outcome,'worktree-result:'+operationId,ancestor);ancestor=parent.payload.repairOf;
        }this.exec('DELETE FROM project_operation_leases WHERE operation_id=?',operationId);
      }
    });
  }
  private taskRow(projectId:string,taskId:string):Row {
    const task=this.one('SELECT * FROM tasks WHERE task_id=? AND workspace_id=? AND dot_id=?',taskId,projectId,this.dotId);
    return task??fail('TASK_NOT_IN_PROJECT');
  }
  private taskAuthority(task:Row):Row {
    const epochs=this.one('SELECT policy_epoch,privacy_epoch FROM dots WHERE dot_id=?',this.dotId)!,data=JSON.parse(String(task.constraints_json)) as {policyEpoch?:number;privacyEpoch?:number};
    const source=this.one('SELECT policy_epoch,privacy_epoch FROM task_runs WHERE task_id=? ORDER BY started_at_ms DESC,rowid DESC LIMIT 1',task.task_id!);
    if((data.policyEpoch??source?.policy_epoch)!==epochs.policy_epoch||(data.privacyEpoch??source?.privacy_epoch)!==epochs.privacy_epoch||this.one('SELECT source_ref FROM privacy_tombstones WHERE dot_id=? AND source_ref IN (?,?)',this.dotId,task.task_id!,'task:'+task.task_id))return fail('TASK_AUTHORIZATION_CHANGED');
    if(task.goal_id){const goal=this.one("SELECT plan_version FROM goals WHERE goal_id=? AND dot_id=? AND status='active'",task.goal_id,this.dotId)??fail('GOAL_NOT_ACTIVE');return{...epochs,goal_plan_version:goal.plan_version!};}return epochs;
  }
  tasks(projectId:string):TaskSummary[] {
    this.workspace(projectId);
    return this.all("SELECT * FROM tasks WHERE workspace_id=? AND dot_id=? AND NOT EXISTS(SELECT 1 FROM privacy_tombstones p WHERE p.dot_id=tasks.dot_id AND p.source_ref IN (tasks.task_id,'task:'||tasks.task_id)) ORDER BY updated_at_ms DESC,rowid DESC LIMIT 100",projectId,this.dotId).map(t=>({
      projectId,taskId:String(t.task_id),title:String(t.title),status:t.status as TaskStatus,version:Number(t.version),blocked:t.dispatch_blocked===1,
      activeRunId:this.one(`SELECT run_id FROM task_runs WHERE task_id=? AND status IN ${active}`,t.task_id!)?.run_id as string??null,
      mode:JSON.parse(String(t.constraints_json)).mode==='workspaceWrite'?'workspaceWrite':'readOnly',updatedAt:Number(t.updated_at_ms),
    }));
  }
  taskForHost(projectId:string,taskId:string):{mode:'readOnly'|'workspaceWrite'} {
    this.workspace(projectId);const task=this.taskRow(projectId,taskId);return{mode:JSON.parse(String(task.constraints_json)).mode==='workspaceWrite'?'workspaceWrite':'readOnly'};
  }
  private conversation():string {
    const current=this.one('SELECT conversation_id FROM conversations WHERE dot_id=?',this.dotId);if(current)return String(current.conversation_id);
    const conversationId=randomUUID();this.exec('INSERT INTO conversations VALUES (?,?)',conversationId,this.dotId);return conversationId;
  }
  private openOperation(key:string,kind:string,input:unknown,taskId:string|null,version:number|null):{operationId:string;created:boolean} {
    const decisionId='command:'+hashInput([this.dotId,key]),inputHash=hashInput(input),previous=this.one('SELECT o.* FROM operations o JOIN router_decisions d USING(decision_id) JOIN messages m USING(message_id) WHERE decision_id=? AND m.dot_id=?',decisionId,this.dotId);
    if(previous){if(previous.input_hash!==inputHash||previous.kind!==kind)return fail('IDEMPOTENCY_CONFLICT');return{operationId:String(previous.operation_id),created:false};}
    const messageId=randomUUID(),operationId=randomUUID(),content=JSON.stringify(input);
    this.exec("INSERT INTO messages(message_id,conversation_id,dot_id,role,content,content_hash,route_state,created_at_ms) VALUES (?,?,?,'user',?,?,'decided',?)",messageId,this.conversation(),this.dotId,content,hashInput(content),Date.now());
    this.exec('INSERT INTO router_decisions VALUES (?,?,?,?,?,?)',decisionId,messageId,'desktop-command-v1',JSON.stringify(taskId?[{taskId,version}]:[]),JSON.stringify({operationId,kind,inputHash,origin:'explicit_user'}),Date.now());
    this.exec("INSERT INTO operations VALUES (?,?,0,?,?,'pending',?,?,?,NULL)",operationId,decisionId,taskId,kind,version,content,inputHash);return{operationId,created:true};
  }
  private operationReceipt(operationId:string):OperationReceipt {
    const op=this.one('SELECT o.* FROM operations o JOIN router_decisions d USING(decision_id) JOIN messages m USING(message_id) WHERE operation_id=? AND m.dot_id=?',operationId,this.dotId);
    if(!op||!op.result_ref)return fail('OPERATION_NOT_AVAILABLE');
    const event=this.one('SELECT payload_json FROM task_events WHERE event_id=? AND task_id=?',String(op.result_ref),op.task_id!);
    if(!event)return fail('OPERATION_RESULT_UNAVAILABLE');const result=JSON.parse(String(event.payload_json)) as OperationReceipt;
    return{...result,state:op.state as OperationReceipt['state']};
  }
  private sealOperation(operationId:string,taskId:string,state:OperationReceipt['state'],runId:string|null):OperationReceipt {
    const task=this.one('SELECT * FROM tasks WHERE task_id=? AND dot_id=?',taskId,this.dotId)??fail('UNKNOWN_TASK');
    const op=this.one('SELECT kind FROM operations WHERE operation_id=?',operationId)??fail('UNKNOWN_OPERATION');
    const receipt:OperationReceipt={operationId,kind:String(op.kind),state,taskId,taskVersion:Number(task.version),status:task.status as TaskStatus,blocked:task.dispatch_blocked===1,runId};
    const eventId=this.event(taskId,runId,state==='completed'?'operation_applied':state==='executing'?'operation_stop_requested':'operation_outcome_unknown',receipt);
    this.exec('UPDATE operations SET task_id=?,state=?,result_ref=? WHERE operation_id=?',taskId,state,eventId,operationId);return receipt;
  }
  private stopOperation(taskId:string,state:'completed'|'outcome_unknown',runId:string):void {
    const op=this.one("SELECT operation_id FROM operations WHERE task_id=? AND kind IN ('PAUSE_TASK','CANCEL_TASK') AND state IN ('executing','outcome_unknown')",taskId);
    if(op)this.sealOperation(String(op.operation_id),taskId,state,runId);
  }
  private stopTarget(taskId:string):'paused'|'cancelled'|null {
    const op=this.one("SELECT kind FROM operations WHERE task_id=? AND kind IN ('PAUSE_TASK','CANCEL_TASK') AND state IN ('executing','outcome_unknown')",taskId);
    return op?.kind==='PAUSE_TASK'?'paused':op?.kind==='CANCEL_TASK'?'cancelled':null;
  }
  private validateTaskCommand(input:TaskCommand){
    if(!input||typeof input!=='object'||Array.isArray(input)||!id(input.projectId)||!id(input.commandKey))return fail('INVALID_TASK_COMMAND');
    const fields=input.kind==='create'?['projectId','commandKey','kind','text',...('code'in input?['code']:[])]:['projectId','commandKey','kind','taskId','expectedVersion',...(input.kind==='rename'?['title']:[])];
    if(Object.keys(input).length!==fields.length||Object.keys(input).some(k=>!fields.includes(k)))return fail('INVALID_TASK_COMMAND');
    if(!Object.hasOwn(taskCommandKinds,input.kind))return fail('INVALID_TASK_COMMAND');
    if(input.kind==='create'){
      if(typeof input.text!=='string'||!input.text.trim()||input.text.length>32768)return fail('INVALID_TASK_INPUT');
      if('code'in input){const c=input.code,path=(p:unknown)=>typeof p==='string'&&p.length>0&&p.length<=300&&!/[\x00-\x1f\\]/.test(p)&&p.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!['.git','.codex','.agents','.aws'].includes(x));
        if(!c||typeof c!=='object'||Object.keys(c).length!==3||c.profile!=='node-test'||!path(c.target)||!Array.isArray(c.allowedPaths)||c.allowedPaths.length<1||c.allowedPaths.length>20||!c.allowedPaths.every(path)||c.allowedPaths.includes(c.target))return fail('INVALID_VERIFICATION_PROFILE');}
    }else if(!id(input.taskId)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||input.kind==='rename'&&(typeof input.title!=='string'||!input.title.trim()||input.title.length>120))return fail('INVALID_TASK_COMMAND');
    const normalized=input.kind==='create'?{projectId:input.projectId,kind:input.kind,text:input.text,...(input.code?{code:{profile:input.code.profile,target:input.code.target,allowedPaths:input.code.allowedPaths}}:{})}:{projectId:input.projectId,kind:input.kind,taskId:input.taskId,expectedVersion:input.expectedVersion,...(input.kind==='rename'?{title:input.title}:{})};
    return normalized;
  }
  taskCommand(input:TaskCommand):OperationReceipt {
    const normalized=this.validateTaskCommand(input);this.workspace(input.projectId);
    return this.tx(()=>{
      this.owner();const opened=this.openOperation(input.commandKey,taskCommandKinds[input.kind],normalized,input.kind==='create'?null:input.taskId,input.kind==='create'?null:input.expectedVersion);
      if(!opened.created)return this.operationReceipt(opened.operationId);
      return this.applyTaskOperation(input,opened.operationId,normalized);
    });
  }
  private applyTaskOperation(input:TaskCommand,operationId:string,normalized:unknown):OperationReceipt {
    if(input.kind==='create'){
      this.projectOperationAvailable(input.projectId);
      if(Number(this.one('SELECT COUNT(*) AS n FROM tasks WHERE dot_id=?',this.dotId)!.n)>=10000)return fail('TASK_LIMIT');
      const epochs=this.one('SELECT policy_epoch,privacy_epoch FROM dots WHERE dot_id=?',this.dotId)!,taskId=randomUUID(),constraints={mode:input.code?'workspaceWrite':'readOnly',inputHash:hashInput(normalized),text:input.text,policyEpoch:epochs.policy_epoch,privacyEpoch:epochs.privacy_epoch,...(input.code?{code:input.code}:{})};
      this.exec("INSERT INTO tasks(task_id,dot_id,workspace_id,title,constraints_json,status,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'created',?,?)",taskId,this.dotId,input.projectId,input.text.slice(0,120),JSON.stringify(constraints),Date.now(),Date.now());
      this.event(taskId,null,'task_created');this.transition(taskId,'queued');return this.sealOperation(operationId,taskId,'completed',null);
    }
    const task=this.taskRow(input.projectId,input.taskId);if(task.version!==input.expectedVersion)return fail('TASK_VERSION_CONFLICT');
    if(this.one("SELECT operation_id FROM operations WHERE task_id=? AND state IN ('executing','outcome_unknown')",input.taskId))return fail('TASK_STOP_PENDING');
    const run=this.one(`SELECT * FROM task_runs WHERE task_id=? AND status IN ${active}`,input.taskId);
    if(input.kind!=='rename')this.scheduler.stopTask(input.taskId,input.kind==='cancel'?'cancelled':'paused');
    if(input.kind==='rename'){
      this.taskAuthority(task);
      if(run||['completed','cancelled','outcome_unknown'].includes(String(task.status)))return fail('TASK_NOT_EDITABLE');
      this.exec('UPDATE tasks SET title=?,version=version+1,updated_at_ms=? WHERE task_id=?',input.title,Date.now(),input.taskId);
    }else if(input.kind==='resume'){
      this.taskAuthority(task);
      if(typeof JSON.parse(String(task.constraints_json)).text!=='string')return fail('TASK_INPUT_UNAVAILABLE');
      if(run||task.status==='outcome_unknown'||!['created','paused','failed','waiting_trigger'].includes(String(task.status)))return fail('TASK_NOT_RESUMABLE');
      this.transition(input.taskId,'queued');this.exec('UPDATE tasks SET dispatch_blocked=0 WHERE task_id=?',input.taskId);
    }else{
      const target=input.kind==='pause'?'paused':'cancelled';
      if(run){
        if(task.status!=='outcome_unknown'&&!taskTransitions[task.status as TaskStatus].includes(target))return fail('INVALID_TASK_TRANSITION');
        this.exec('UPDATE tasks SET dispatch_blocked=1,version=version+1,updated_at_ms=? WHERE task_id=?',Date.now(),input.taskId);
        return this.sealOperation(operationId,input.taskId,task.status==='outcome_unknown'?'outcome_unknown':'executing',String(run.run_id));
      }
      this.transition(input.taskId,target);this.exec('UPDATE tasks SET dispatch_blocked=1 WHERE task_id=?',input.taskId);
    }
    return this.sealOperation(operationId,input.taskId,'completed',null);
  }
  private planCommand(projectId:string,node:TaskPlanNode,expectedVersion:number,key:string):TaskCommand {
    const base={projectId,taskId:node.taskId,expectedVersion,commandKey:key};return node.kind==='rename'?{...base,kind:'rename',title:node.title??''}:{...base,kind:node.kind};
  }
  submitTaskPlan(input:unknown):TaskPlanView {
    if(!input||typeof input!=='object'||Array.isArray(input))return fail('INVALID_TASK_PLAN');const q=input as TaskPlanCommand;
    if(Object.keys(q).length!==3||!['projectId','commandKey','nodes'].every(k=>Object.hasOwn(q,k))||!id(q.projectId)||!id(q.commandKey)||!Array.isArray(q.nodes)||q.nodes.length<1||q.nodes.length>20)return fail('INVALID_TASK_PLAN');
    const nodes=Array.from(q.nodes).map((node,index):TaskPlanNode=>{
      if(!node||typeof node!=='object'||Array.isArray(node)||!['rename','pause','cancel','resume'].includes(node.kind))return fail('INVALID_TASK_PLAN_NODE');
      const numeric=Object.hasOwn(node,'expectedVersion'),reference=Object.hasOwn(node,'versionFrom'),fields=['kind','taskId','dependsOn',numeric?'expectedVersion':'versionFrom',...(node.kind==='rename'?['title']:[])];
      if(numeric===reference||Object.keys(node).length!==fields.length||Object.keys(node).some(k=>!fields.includes(k))||!Array.isArray(node.dependsOn)||node.dependsOn.length>19||new Set(node.dependsOn).size!==node.dependsOn.length||Array.from(node.dependsOn).some(n=>!Number.isSafeInteger(n)||n<0||n>=q.nodes.length||n===index))return fail('INVALID_TASK_PLAN_NODE');
      if(reference&&(!Number.isSafeInteger(node.versionFrom)||node.versionFrom!<0||node.versionFrom!>=q.nodes.length||!node.dependsOn.includes(node.versionFrom!)))return fail('INVALID_PLAN_VERSION_REFERENCE');
      this.validateTaskCommand(this.planCommand(q.projectId,node,numeric?node.expectedVersion!:1,'plan-validation'));
      return{kind:node.kind,taskId:node.taskId,...(numeric?{expectedVersion:node.expectedVersion!}:{versionFrom:node.versionFrom!}),dependsOn:[...node.dependsOn].sort((a,b)=>a-b),...(node.kind==='rename'?{title:node.title!}:{})} satisfies TaskPlanNode;
    });
    const color=nodes.map(()=>0),visit=(index:number)=>{if(color[index]===1)return fail('TASK_PLAN_CYCLE');if(color[index]===2)return;color[index]=1;for(const dependency of nodes[index]!.dependsOn)visit(dependency);color[index]=2;};nodes.forEach((_,index)=>visit(index));
    for(const node of nodes)if(node.versionFrom!==undefined&&nodes[node.versionFrom]!.taskId!==node.taskId)return fail('PLAN_VERSION_SCOPE_MISMATCH');
    this.workspace(q.projectId);const planId='task-plan:'+hashInput([this.dotId,q.commandKey]),planHash=hashInput({projectId:q.projectId,nodes});
    return this.tx(()=>{
      this.owner();const previous=this.planRecord(planId,false);
      if(previous){const data=JSON.parse(String(previous.decision_json));if(data.planHash!==planHash||data.projectId!==q.projectId)return fail('IDEMPOTENCY_CONFLICT');return this.taskPlan(q.projectId,planId);}
      const snapshots=nodes.map(n=>{const task=this.taskRow(q.projectId,n.taskId);return{taskId:n.taskId,version:task.version,status:task.status};});
      if(this.pendingTaskPlans().length>=20)return fail('TASK_PLAN_LIMIT');
      const messageId=randomUUID(),content=JSON.stringify({projectId:q.projectId,nodes}),ids=nodes.map(()=>randomUUID());
      this.exec("INSERT INTO messages(message_id,conversation_id,dot_id,role,content,content_hash,route_state,created_at_ms) VALUES (?,?,?,'user',?,?,'decided',?)",messageId,this.conversation(),this.dotId,content,hashInput(content),Date.now());
      this.exec('INSERT INTO router_decisions VALUES (?,?,?,?,?,?)',planId,messageId,'desktop-task-plan-v1',JSON.stringify(snapshots),JSON.stringify({projectId:q.projectId,planHash,origin:'explicit_user',operationIds:ids}),Date.now());
      nodes.forEach((node,index)=>this.exec("INSERT INTO operations VALUES (?,?,?,?,?,'pending',?,?,?,NULL)",ids[index]!,planId,index,node.taskId,taskCommandKinds[node.kind],node.expectedVersion??null,JSON.stringify(node),hashInput(node)));
      nodes.forEach((node,index)=>node.dependsOn.forEach(dependency=>this.exec('INSERT INTO operation_dependencies VALUES (?,?)',ids[index]!,ids[dependency]!)));
      return this.taskPlan(q.projectId,planId);
    });
  }
  private planRecord(planId:string,required=true):Row|undefined {
    const row=this.one("SELECT d.* FROM router_decisions d JOIN messages m USING(message_id) WHERE decision_id=? AND router_revision='desktop-task-plan-v1' AND m.dot_id=?",planId,this.dotId);if(!row&&required)return fail('TASK_PLAN_NOT_FOUND');return row;
  }
  private taskPlanHidden(planId:string):boolean {
    return Boolean(this.one("SELECT o.operation_id FROM operations o JOIN privacy_tombstones p ON p.dot_id=? AND p.source_ref IN (o.task_id,'task:'||o.task_id) WHERE o.decision_id=? LIMIT 1",this.dotId,planId));
  }
  taskPlan(projectId:string,planId:string):TaskPlanView {
    this.workspace(projectId);const record=this.planRecord(planId)!;if(JSON.parse(String(record.decision_json)).projectId!==projectId)return fail('TASK_PLAN_NOT_IN_PROJECT');
    if(this.taskPlanHidden(planId))return fail('TASK_PLAN_NOT_FOUND');
    const operations=this.all('SELECT * FROM operations WHERE decision_id=? ORDER BY operation_index',planId).map(op=>{
      const node=JSON.parse(String(op.input_json)) as TaskPlanNode,view:TaskPlanOperation={operationId:String(op.operation_id),index:Number(op.operation_index),kind:node.kind,taskId:String(op.task_id),state:op.state as TaskPlanOperation['state'],dependsOn:node.dependsOn};
      if(['completed','executing','outcome_unknown'].includes(view.state))view.receipt=this.operationReceipt(view.operationId);
      if(typeof op.result_ref==='string'&&op.result_ref.startsWith('error:'))view.errorCode=op.result_ref.slice(6);return view;
    });
    const allDone=operations.every(o=>o.state==='completed'),unknown=operations.some(o=>o.state==='outcome_unknown'),unfinished=operations.some(o=>['pending','blocked','executing'].includes(o.state));
    const status=allDone?'completed':unknown?'outcome_unknown':operations.every(o=>o.state==='cancelled')?'cancelled':!unfinished?'needs_review':operations.every(o=>o.state==='pending')?'pending':'running';return{planId,projectId,createdAt:Number(record.created_at_ms),status,operations};
  }
  cancelTaskPlan(projectId:string,planId:string,key:string):TaskPlanView {
    if(!id(key))return fail('INVALID_TASK_PLAN');this.taskPlan(projectId,planId);
    return this.tx(()=>{this.owner();const op=this.openOperation('cancel-plan:'+key,'CANCEL_TASK_PLAN',{projectId,planId},null,null);
      if(op.created){this.exec("UPDATE operations SET state='cancelled',result_ref='error:PLAN_CANCELLED' WHERE decision_id=? AND state IN ('pending','blocked')",planId);this.exec("UPDATE operations SET state='completed',result_ref=? WHERE operation_id=?",'plan:'+planId,op.operationId);}
      return this.taskPlan(projectId,planId);
    });
  }
  taskPlans(projectId:string):TaskPlanView[] {
    this.workspace(projectId);return this.all("SELECT d.decision_id FROM router_decisions d JOIN messages m USING(message_id) WHERE m.dot_id=? AND d.router_revision='desktop-task-plan-v1' AND json_extract(d.decision_json,'$.projectId')=? AND NOT EXISTS(SELECT 1 FROM operations o JOIN privacy_tombstones p ON p.dot_id=m.dot_id AND p.source_ref IN (o.task_id,'task:'||o.task_id) WHERE o.decision_id=d.decision_id) ORDER BY d.created_at_ms DESC,d.rowid DESC LIMIT 20",this.dotId,projectId).map(row=>this.taskPlan(projectId,String(row.decision_id)));
  }
  pendingTaskPlans():Array<{planId:string;projectId:string}> {
    return this.all("SELECT DISTINCT d.decision_id,d.decision_json FROM router_decisions d JOIN messages m USING(message_id) JOIN operations o USING(decision_id) WHERE m.dot_id=? AND d.router_revision='desktop-task-plan-v1' AND o.state IN ('pending','blocked','executing','outcome_unknown') AND NOT EXISTS(SELECT 1 FROM operations hidden JOIN privacy_tombstones p ON p.dot_id=m.dot_id AND p.source_ref IN (hidden.task_id,'task:'||hidden.task_id) WHERE hidden.decision_id=d.decision_id) ORDER BY d.created_at_ms,d.rowid LIMIT 20",this.dotId).map(row=>({planId:String(row.decision_id),projectId:JSON.parse(String(row.decision_json)).projectId as string}));
  }
  advanceTaskPlan(projectId:string,planId:string,maxSteps=20):TaskPlanView {
    if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>20)return fail('INVALID_PLAN_STEP_LIMIT');
    for(let step=0;step<maxSteps;step++){
      const changed=this.tx(()=>{
        this.owner();const plan=this.taskPlan(projectId,planId),rows=this.all('SELECT * FROM operations WHERE decision_id=? ORDER BY operation_index',planId);let blockedChanged=false;
        for(const op of rows){
          if(!['pending','blocked'].includes(String(op.state)))continue;const node=JSON.parse(String(op.input_json)) as TaskPlanNode;
          if(hashInput(node)!==op.input_hash)return fail('TASK_PLAN_INTEGRITY_CHANGED');
          const dependencies=this.all('SELECT p.* FROM operation_dependencies d JOIN operations p ON p.operation_id=d.prerequisite_id WHERE d.operation_id=?',op.operation_id!);
          if(dependencies.length!==node.dependsOn.length||dependencies.some(d=>d.decision_id!==planId||!node.dependsOn.includes(Number(d.operation_index))))return fail('TASK_PLAN_INTEGRITY_CHANGED');
          if(dependencies.some(d=>['failed','cancelled'].includes(String(d.state)))){
            this.exec("UPDATE operations SET state='cancelled',result_ref='error:DEPENDENCY_FAILED' WHERE operation_id=?",op.operation_id!);this.event(String(op.task_id),null,'operation_dependency_cancelled',{operationId:op.operation_id,planId});return true;
          }
          if(dependencies.some(d=>d.state!=='completed')){if(op.state!=='blocked'){this.exec("UPDATE operations SET state='blocked' WHERE operation_id=?",op.operation_id!);blockedChanged=true;}continue;}
          const source=node.versionFrom===undefined?undefined:plan.operations[node.versionFrom];
          if(node.versionFrom!==undefined&&(!source?.receipt||source.taskId!==node.taskId||source.state!=='completed'))return fail('INVALID_PLAN_VERSION_REFERENCE');
          const expectedVersion=node.expectedVersion??source!.receipt!.taskVersion,command=this.planCommand(projectId,node,expectedVersion,planId+':'+op.operation_index);
          this.exec('UPDATE operations SET expected_task_version=? WHERE operation_id=?',expectedVersion,op.operation_id!);
          this.#db.exec('SAVEPOINT task_plan_effect');
          try{
            const normalized=this.validateTaskCommand(command);this.applyTaskOperation(command,String(op.operation_id),normalized);this.options.afterPlanEffectForTests?.(Number(op.operation_index));this.#db.exec('RELEASE task_plan_effect');
          }catch(error){
            this.#db.exec('ROLLBACK TO task_plan_effect; RELEASE task_plan_effect');
            if(!(error instanceof LedgerError))throw error;
            this.exec("UPDATE operations SET state='failed',result_ref=? WHERE operation_id=?",'error:'+error.code,op.operation_id!);this.event(String(op.task_id),null,'operation_failed',{operationId:op.operation_id,planId,code:error.code});
          }
          return true;
        }return blockedChanged;
      });
      if(!changed)break;
    }return this.taskPlan(projectId,planId);
  }
  private schedulerNow():number {try{return scheduleTime(this.options.schedulerClock?.()??Date.now());}catch(error){if(error instanceof ScheduleTimeError)return fail(error.code);throw error;}}
  scheduleCommand(input:unknown){
    if(!input||typeof input!=='object'||Array.isArray(input))return fail('INVALID_SCHEDULE_COMMAND');const q=input as ScheduleCommand;
    if(!id(q.projectId)||!id(q.commandKey)||!['create','pause','cancel','resume','replace'].includes(q.kind))return fail('INVALID_SCHEDULE_COMMAND');
    const fields=q.kind==='create'?['kind','projectId','taskId','expectedTaskVersion','commandKey','config']:['kind','projectId','scheduleId','expectedVersion','commandKey',...(q.kind==='replace'?['config']:[])];
    if(Object.keys(q).length!==fields.length||!fields.every(k=>Object.hasOwn(q,k)))return fail('INVALID_SCHEDULE_COMMAND');
    if(q.kind==='create'?(!id(q.taskId)||!Number.isSafeInteger(q.expectedTaskVersion)||q.expectedTaskVersion<1):(!id(q.scheduleId)||!Number.isSafeInteger(q.expectedVersion)||q.expectedVersion<1))return fail('INVALID_SCHEDULE_COMMAND');
    this.workspace(q.projectId);
    try{
      const config=q.kind==='create'||q.kind==='replace'?this.scheduler.config(q.config):undefined,normalized={kind:q.kind,projectId:q.projectId,...(q.kind==='create'?{taskId:q.taskId,expectedTaskVersion:q.expectedTaskVersion}:{scheduleId:q.scheduleId,expectedVersion:q.expectedVersion}),commandKey:q.commandKey,...(config?{config}:{})};
      return this.tx(()=>{this.owner();const scheduleId=q.kind==='create'?'schedule:'+hashInput([this.dotId,q.commandKey]):q.scheduleId,previous=q.kind==='create'?null:this.scheduler.view(q.projectId,scheduleId),taskId=q.kind==='create'?q.taskId:previous!.taskId;
        const operation=this.openOperation('schedule:'+q.commandKey,'SCHEDULE_'+q.kind.toUpperCase(),normalized,taskId,q.kind==='create'?q.expectedTaskVersion:null);
        if(!operation.created)return this.scheduler.view(q.projectId,scheduleId);
        const now=this.schedulerNow(),view=q.kind==='create'?this.scheduler.create(q.projectId,q.taskId,q.expectedTaskVersion,scheduleId,config!,now):this.scheduler.control(q.projectId,scheduleId,q.expectedVersion,q.kind,config,now);
        this.sealOperation(operation.operationId,taskId,'completed',null);return view;
      });
    }catch(error){if(error instanceof ScheduleTimeError)return fail(error.code);throw error;}
  }
  schedules(projectId:string){if(!id(projectId))return fail('INVALID_SCHEDULE_QUERY');this.workspace(projectId);return this.scheduler.list(projectId);}
  scheduleOccurrences(projectId:string,scheduleId:string){if(!id(projectId)||!id(scheduleId))return fail('INVALID_SCHEDULE_QUERY');this.workspace(projectId);return this.scheduler.occurrences(projectId,scheduleId);}
  stepSchedules(){
    this.owner();const now=this.schedulerNow(),due=this.scheduler.due(now);let processed=0;
    for(const scheduleId of due)processed+=this.tx(()=>{this.owner();const count=this.scheduler.tick(scheduleId,now);this.options.afterScheduleTickForTests?.();return count;});
    return{processed};
  }
  deliverScheduleWakes(){return this.tx(()=>{this.owner();return{queued:this.scheduler.deliver(this.schedulerNow())};});}
  claimTask(projectId:string,taskId:string,expectedVersion:number,key:string):QueuedRun {
    if(!id(key)||!id(taskId)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)return fail('INVALID_TASK_COMMAND');this.workspace(projectId);
    return this.tx(()=>{this.owner();return this.claimTaskInTransaction(projectId,taskId,expectedVersion,key);});
  }
  private claimTaskInTransaction(projectId:string,taskId:string,expectedVersion:number,key:string):QueuedRun {
      this.projectOperationAvailable(projectId);
      const task=this.taskRow(projectId,taskId),data=JSON.parse(String(task.constraints_json)) as {text?:string;mode:'readOnly'|'workspaceWrite';code?:CodeTaskSpec};
      if(typeof data.text!=='string'||!data.text.trim())return fail('TASK_INPUT_UNAVAILABLE');
      const prior=this.one('SELECT * FROM task_runs WHERE idempotency_key=?',key);
      if(prior){if(prior.task_id!==taskId||Number(prior.task_snapshot_version)!==expectedVersion+1)return fail('IDEMPOTENCY_CONFLICT');return{token:{runId:String(prior.run_id),epoch:Number(prior.runtime_epoch),taskFence:Number(prior.task_fence)},created:false,text:data.text,...(data.code?{code:data.code}:{})};}
      if(task.version!==expectedVersion)return fail('TASK_VERSION_CONFLICT');if(task.status!=='queued'||task.dispatch_blocked!==0)return fail('TASK_NOT_DISPATCHABLE');
      const epochs=this.taskAuthority(task);
      if(this.one(`SELECT run_id FROM task_runs WHERE dot_id=? AND status IN ${active}`,this.dotId))return fail('RUNTIME_BUSY');
      const binding=this.one("SELECT execution_thread_id FROM thread_bindings WHERE task_id=? AND state='active'",taskId),source=this.one('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at_ms DESC,rowid DESC LIMIT 1',taskId);
      const plan=source?this.verificationPlan(String(source.run_id)):null,code=data.code??(plan?{profile:'node-test' as const,target:plan.target,allowedPaths:plan.allowedPaths}:undefined);
      if(data.mode==='workspaceWrite'&&(!code||binding&&!plan))return fail('VERIFICATION_NOT_CONFIGURED');
      const operation=this.openOperation('dispatch:'+key,'DISPATCH_TASK',{projectId,taskId,expectedVersion},taskId,expectedVersion);
      this.transition(taskId,'running');this.exec('UPDATE tasks SET write_fence=write_fence+1 WHERE task_id=?',taskId);const current=this.taskRow(projectId,taskId),runId=randomUUID();
      this.exec("INSERT INTO task_runs(run_id,task_id,dot_id,operation_id,idempotency_key,executor_kind,status,task_snapshot_version,goal_plan_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES (?,?,?,?,?,'codex','preparing',?,?,?,?,?,?,?,?,?)",runId,taskId,this.dotId,operation.operationId,key,current.version!,epochs.goal_plan_version??null,current.write_fence!,this.#epoch,epochs.policy_epoch!,epochs.privacy_epoch!,this.#instance,Date.now()+60000,Date.now());
      this.budget.reserve(runId,current.goal_id as string|null);
      if(data.mode==='workspaceWrite'){
        if(this.one('SELECT run_id FROM workspace_write_leases WHERE workspace_id=?',projectId))return fail('WORKSPACE_BUSY');
        this.exec("UPDATE workspaces SET write_fence=write_fence+1,state='busy' WHERE workspace_id=?",projectId);const ws=this.one('SELECT write_fence FROM workspaces WHERE workspace_id=?',projectId)!;
        this.exec('INSERT INTO workspace_write_leases VALUES (?,?,?,?)',projectId,runId,ws.write_fence!,Date.now()+60000);
      }
      this.exec("INSERT INTO prompt_manifests VALUES (?,?,'coding',?,?,?, ?,?,'[]',NULL)",randomUUID(),runId,data.mode==='workspaceWrite'?'execution':'read-only',JSON.stringify({submission:hashInput([taskId,key,expectedVersion]),user:hashInput(data.text)}),hashInput({mode:data.mode}),epochs.policy_epoch!,epochs.privacy_epoch!);
      this.event(taskId,runId,'run_claimed',{mode:data.mode});this.sealOperation(operation.operationId,taskId,'completed',runId);
      return{token:{runId,epoch:this.#epoch,taskFence:Number(current.write_fence)},created:true,text:data.text,...(code?{code}:{}),...(binding?{threadId:String(binding.execution_thread_id),sourceRunId:String(source!.run_id)}:{})};
  }
  scheduledCandidates(){this.owner();return this.scheduler.autoCandidates();}
  claimScheduledTask(projectId:string,triggerId:string):QueuedRun&{submissionKey:string} {
    if(!id(projectId)||!id(triggerId))return fail('INVALID_SCHEDULE_QUERY');this.workspace(projectId);
    return this.tx(()=>{this.owner();const key=scheduledRunKey(triggerId),prior=this.one('SELECT r.* FROM task_runs r JOIN tasks t USING(task_id) WHERE r.idempotency_key=? AND t.workspace_id=? AND t.dot_id=?',key,projectId,this.dotId);
      if(prior){const event=this.one("SELECT event_id FROM task_events WHERE run_id=? AND event_type='scheduled_run_claimed' AND json_extract(payload_json,'$.triggerId')=?",prior.run_id!,triggerId);if(!event)return fail('SCHEDULE_RUN_BINDING_MISMATCH');return{token:{runId:String(prior.run_id),epoch:Number(prior.runtime_epoch),taskFence:Number(prior.task_fence)},created:false,text:'',submissionKey:key};}
      const admitted=this.scheduler.admission(projectId,triggerId,this.schedulerNow()),queued=this.claimTaskInTransaction(projectId,admitted.taskId,admitted.expectedVersion,key);
      this.event(admitted.taskId,queued.token.runId,'scheduled_run_claimed',{triggerId,scheduleId:admitted.scheduleId,scheduleVersion:admitted.scheduleVersion,occurrenceId:admitted.occurrenceId,expectedTaskVersion:admitted.expectedVersion,submissionKeyHash:hashInput(key)});
      const manifest=this.one('SELECT module_hashes_json FROM prompt_manifests WHERE run_id=?',queued.token.runId)!;
      this.exec('UPDATE prompt_manifests SET module_hashes_json=? WHERE run_id=?',JSON.stringify({...JSON.parse(String(manifest.module_hashes_json)),schedule:hashInput({triggerId,...admitted})}),queued.token.runId);
      this.scheduler.claimed(projectId,triggerId);this.options.afterScheduledClaimForTests?.();return{...queued,submissionKey:key};
    });
  }
  scheduleDispatchWait(projectId:string,triggerId:string,code:string){this.tx(()=>{this.owner();this.scheduler.dispatchWait(projectId,triggerId,code);});}
  claimOutbox(limit=50,leaseMs=30000):OutboxClaim[] {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>60000)return fail('INVALID_OUTBOX_CLAIM');
    return this.tx(()=>{
      this.owner();const now=Date.now();
      this.exec("UPDATE outbox_events SET state='dead_letter',lease_until_ms=NULL WHERE state='claimed' AND lease_until_ms<=? AND attempts>=5 AND aggregate_ref IN (SELECT task_id FROM tasks WHERE dot_id=?)",now,this.dotId);
      const rows=this.all("SELECT o.* FROM outbox_events o JOIN tasks t ON t.task_id=o.aggregate_ref WHERE t.dot_id=? AND o.attempts<5 AND ((o.state='pending' AND COALESCE(o.next_attempt_at_ms,0)<=?) OR (o.state='claimed' AND o.lease_until_ms<=?)) ORDER BY o.rowid LIMIT ?",this.dotId,now,now,limit);
      return rows.map(row=>{
        const epoch=Number(row.claim_epoch)+1,expiresAt=now+leaseMs;
        this.exec("UPDATE outbox_events SET state='claimed',claim_epoch=?,lease_until_ms=?,attempts=attempts+1 WHERE outbox_id=?",epoch,expiresAt,row.outbox_id!);
        return{outboxId:String(row.outbox_id),claimEpoch:epoch,runtimeEpoch:this.#epoch,eventId:String(row.dedupe_key),taskId:String(row.aggregate_ref),expiresAt};
      });
    });
  }
  private outboxClaim(claim:OutboxClaim,delivered=false):Row {
    this.owner();if(!claim||!id(claim.outboxId)||claim.runtimeEpoch!==this.#epoch||!Number.isSafeInteger(claim.claimEpoch)||claim.claimEpoch<1)return fail('STALE_OUTBOX_CLAIM');
    const row=this.one('SELECT o.* FROM outbox_events o JOIN tasks t ON t.task_id=o.aggregate_ref WHERE outbox_id=? AND t.dot_id=?',claim.outboxId,this.dotId);
    if(!row||row.claim_epoch!==claim.claimEpoch||row.dedupe_key!==claim.eventId||row.aggregate_ref!==claim.taskId)return fail('STALE_OUTBOX_CLAIM');
    if(delivered&&row.state==='delivered')return row;
    if(row.state!=='claimed'||row.lease_until_ms!==claim.expiresAt||Number(row.lease_until_ms)<=Date.now())return fail('STALE_OUTBOX_CLAIM');return row;
  }
  deliverOutbox(claim:OutboxClaim):boolean {
    return this.tx(()=>{
      const row=this.outboxClaim(claim,true);if(row.state==='delivered')return false;
      const event=this.one('SELECT e.* FROM task_events e JOIN tasks t USING(task_id) WHERE event_id=? AND task_id=? AND t.dot_id=?',claim.eventId,claim.taskId,this.dotId);
      if(!event||event.event_type!==row.event_type||event.payload_json!==row.payload_json)return fail('OUTBOX_EVENT_MISMATCH');
      const privacy=this.one('SELECT privacy_epoch FROM dots WHERE dot_id=?',this.dotId)!;
      const tombstone=this.one('SELECT source_ref FROM privacy_tombstones WHERE dot_id=? AND source_ref IN (?,?)',this.dotId,claim.taskId,'task:'+claim.taskId);
      let projected=false;
      if(!tombstone){
        const display={eventId:claim.eventId,taskId:claim.taskId,eventType:String(event.event_type),taskVersion:Number(event.task_version),runId:event.run_id as string|null};
        const inserted=this.#db.prepare("INSERT OR IGNORE INTO main_feed(conversation_id,source_event_id,item_type,ref_id,privacy_epoch,display_json) VALUES (?,?,'task_event',?,?,?)").run(this.conversation(),claim.eventId,claim.taskId,privacy.privacy_epoch!,JSON.stringify(display));projected=Number(inserted.changes)===1;
      }
      this.options.afterOutboxProjectionForTests?.();
      this.exec("UPDATE outbox_events SET state='delivered',lease_until_ms=NULL,next_attempt_at_ms=NULL WHERE outbox_id=?",claim.outboxId);return projected;
    });
  }
  retryOutbox(claim:OutboxClaim):void {
    this.tx(()=>{const row=this.outboxClaim(claim),dead=Number(row.attempts)>=5;
      this.exec('UPDATE outbox_events SET state=?,lease_until_ms=NULL,next_attempt_at_ms=? WHERE outbox_id=?',dead?'dead_letter':'pending',dead?null:Date.now()+Math.min(60000,1000*2**(Number(row.attempts)-1)),claim.outboxId);
    });
  }
  outboxStatus(projectId?:string):{pending:number;claimed:number;delivered:number;deadLetter:number} {
    const counts={pending:0,claimed:0,delivered:0,deadLetter:0};
    for(const row of this.all('SELECT o.state,COUNT(*) AS n FROM outbox_events o JOIN tasks t ON t.task_id=o.aggregate_ref WHERE t.dot_id=? AND (? IS NULL OR t.workspace_id=?) GROUP BY o.state',this.dotId,projectId??null,projectId??null)){
      if(row.state==='dead_letter')counts.deadLetter=Number(row.n);else counts[row.state as 'pending'|'claimed'|'delivered']=Number(row.n);
    }return counts;
  }
  activity(projectId:string,cursor=0):ActivityPage {
    this.workspace(projectId);if(!Number.isSafeInteger(cursor)||cursor<0)return fail('INVALID_ACTIVITY_CURSOR');
    const rows=this.all("SELECT f.projection_sequence,f.display_json FROM main_feed f JOIN tasks t ON t.task_id=f.ref_id JOIN dots d ON d.dot_id=t.dot_id WHERE t.workspace_id=? AND t.dot_id=? AND f.privacy_epoch=d.privacy_epoch AND f.item_type='task_event' AND f.projection_sequence>? AND NOT EXISTS(SELECT 1 FROM privacy_tombstones p WHERE p.dot_id=t.dot_id AND p.source_ref IN (t.task_id,'task:'||t.task_id)) ORDER BY f.projection_sequence LIMIT 101",projectId,this.dotId,cursor);
    const items=rows.slice(0,100).map(row=>({sequence:Number(row.projection_sequence),...JSON.parse(String(row.display_json)) as Omit<ActivityPage['items'][number],'sequence'>}));
    const {pending,claimed,deadLetter}=this.outboxStatus(projectId);return{items,nextCursor:rows.length>100?items.at(-1)!.sequence:null,delivery:{pending,claimed,deadLetter}};
  }
  beginRun(workspaceId: string, text: string, key: string, mode: 'readOnly' | 'workspaceWrite', contextHash?: string): { token: RunToken; created: boolean } {
    if (!id(key) || typeof text !== 'string' || !text.trim() || text.length > 32_768 || !['readOnly','workspaceWrite'].includes(mode)) return fail('INVALID_TASK_INPUT');
    this.workspace(workspaceId);
    const inputHash = hashInput(contextHash ? [workspaceId, text, mode, contextHash] : [workspaceId, text, mode]);
    return this.tx(() => {
      this.owner();
      const previous = this.one('SELECT r.*,t.constraints_json FROM task_runs r JOIN tasks t USING(task_id) WHERE r.idempotency_key=? AND r.dot_id=?', key, this.dotId);
      if (previous) {
        const manifest=this.one('SELECT module_hashes_json FROM prompt_manifests WHERE run_id=?',previous.run_id!);
        const savedHash=manifest ? JSON.parse(String(manifest.module_hashes_json)).submission ?? JSON.parse(String(previous.constraints_json)).inputHash : JSON.parse(String(previous.constraints_json)).inputHash;
        if (savedHash !== inputHash) return fail('IDEMPOTENCY_CONFLICT');
        return { token: { runId: String(previous.run_id), epoch: Number(previous.runtime_epoch), taskFence: Number(previous.task_fence) }, created: false };
      }
      if (this.one(`SELECT run_id FROM task_runs WHERE dot_id=? AND status IN ${active}`, this.dotId)) return fail('RUNTIME_BUSY');
      this.projectOperationAvailable(workspaceId);
      const taskId = randomUUID(), runId = randomUUID();
      this.exec("INSERT INTO tasks(task_id,dot_id,workspace_id,title,constraints_json,status,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'created',?,?)", taskId, this.dotId, workspaceId, text.slice(0, 120), JSON.stringify({ inputHash, mode, text }), Date.now(), Date.now());
      this.event(taskId, null, 'task_created'); this.transition(taskId, 'queued'); this.transition(taskId, 'running');
      this.exec('UPDATE tasks SET write_fence=write_fence+1 WHERE task_id=?', taskId);
      this.exec("INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES (?,?,?,?,'codex','preparing',3,1,?,1,1,?,?,?)", runId, taskId, this.dotId, key, this.#epoch, this.#instance, Date.now() + 60_000, Date.now());
      this.budget.reserve(runId,null);
      if (mode === 'workspaceWrite') {
        this.projectOperationAvailable(workspaceId);
        if (this.one('SELECT run_id FROM workspace_write_leases WHERE workspace_id=?', workspaceId)) return fail('WORKSPACE_BUSY');
        this.exec('UPDATE workspaces SET write_fence=write_fence+1,state=\'busy\' WHERE workspace_id=?', workspaceId);
        const ws = this.one('SELECT write_fence FROM workspaces WHERE workspace_id=?', workspaceId)!;
        this.exec('INSERT INTO workspace_write_leases VALUES (?,?,?,?)', workspaceId, runId, ws.write_fence!, Date.now() + 60_000);
      }
      this.exec("INSERT INTO prompt_manifests VALUES (?,?,'coding',?,?,?,1,1,'[]',NULL)", randomUUID(), runId, mode === 'readOnly' ? 'read-only' : 'execution', JSON.stringify({ submission: inputHash, user: hashInput(text) }), hashInput({ mode }));
      this.event(taskId, runId, 'run_claimed', { mode });
      const operation=this.openOperation('submit:'+key,'CREATE_TASK',{workspaceId,text,mode,contextHash:contextHash??null},taskId,null);
      this.exec('UPDATE task_runs SET operation_id=? WHERE run_id=?',operation.operationId,runId);this.sealOperation(operation.operationId,taskId,'completed',runId);
      return { token: { runId, epoch: this.#epoch, taskFence: 1 }, created: true };
    });
  }
  beginContinuation(workspaceId:string,sourceRunId:string,text:string,key:string):{token:RunToken;created:boolean;threadId:string;mode:'readOnly'|'workspaceWrite'} {
    if(!id(key)||!id(sourceRunId)||typeof text!=='string'||!text.trim()||text.length>32768)return fail('INVALID_TASK_INPUT');
    this.workspace(workspaceId);
    return this.tx(()=>{
      this.owner();const source=this.runForHost(sourceRunId);
      if(source.workspaceId!==workspaceId||!source.threadId)return fail('RUN_NOT_CONTINUABLE');
      const inputHash=hashInput([workspaceId,text,source.mode,'continuation',sourceRunId]);
      const previous=this.one('SELECT * FROM task_runs WHERE idempotency_key=? AND dot_id=?',key,this.dotId);
      if(previous){const manifest=JSON.parse(String(this.one('SELECT module_hashes_json FROM prompt_manifests WHERE run_id=?',previous.run_id!)!.module_hashes_json));if(manifest.submission!==inputHash)return fail('IDEMPOTENCY_CONFLICT');return{token:{runId:String(previous.run_id),epoch:Number(previous.runtime_epoch),taskFence:Number(previous.task_fence)},created:false,threadId:source.threadId,mode:source.mode};}
      this.projectOperationAvailable(workspaceId);
      const task=this.one('SELECT * FROM tasks WHERE task_id=?',source.taskId)!;
      if(!['completed','failed'].includes(source.status)||!['needs_review','failed'].includes(String(task.status))||source.blocked||task.write_fence!==source.taskFence)return fail('RUN_NOT_CONTINUABLE');
      if(this.one(`SELECT run_id FROM task_runs WHERE dot_id=? AND status IN ${active}`,this.dotId))return fail('RUNTIME_BUSY');
      if(source.mode==='workspaceWrite'&&!this.verificationPlan(sourceRunId))return fail('VERIFICATION_NOT_CONFIGURED');
      this.transition(source.taskId,'queued');this.transition(source.taskId,'running');this.exec('UPDATE tasks SET write_fence=write_fence+1 WHERE task_id=?',source.taskId);
      const current=this.one('SELECT version,write_fence FROM tasks WHERE task_id=?',source.taskId)!,runId=randomUUID(),fence=Number(current.write_fence);
      this.exec("INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES (?,?,?,?,'codex','preparing',?,?,?,1,1,?,?,?)",runId,source.taskId,this.dotId,key,current.version!,fence,this.#epoch,this.#instance,Date.now()+60000,Date.now());
      this.budget.reserve(runId,task.goal_id as string|null);
      if(source.mode==='workspaceWrite'){
        this.projectOperationAvailable(workspaceId);
        if(this.one('SELECT run_id FROM workspace_write_leases WHERE workspace_id=?',workspaceId))return fail('WORKSPACE_BUSY');
        this.exec("UPDATE workspaces SET write_fence=write_fence+1,state='busy' WHERE workspace_id=?",workspaceId);
        const workspace=this.one('SELECT write_fence FROM workspaces WHERE workspace_id=?',workspaceId)!;
        this.exec('INSERT INTO workspace_write_leases VALUES (?,?,?,?)',workspaceId,runId,workspace.write_fence!,Date.now()+60000);
      }
      this.exec("INSERT INTO prompt_manifests VALUES (?,?,'coding',?,?,?,1,1,'[]',NULL)",randomUUID(),runId,source.mode==='readOnly'?'read-only':'execution',JSON.stringify({submission:inputHash,user:hashInput(text)}),hashInput({mode:source.mode}));
      this.event(source.taskId,runId,'run_continued',{sourceRunId,threadId:source.threadId,taskFence:fence});
      const operation=this.openOperation('continue:'+key,'CONTINUE_TASK',{workspaceId,sourceRunId,text},source.taskId,Number(task.version));
      this.exec('UPDATE tasks SET constraints_json=json_set(constraints_json,\'$.text\',?) WHERE task_id=?',text,source.taskId);
      this.exec('UPDATE task_runs SET operation_id=? WHERE run_id=?',operation.operationId,runId);this.sealOperation(operation.operationId,source.taskId,'completed',runId);
      return{token:{runId,epoch:this.#epoch,taskFence:fence},created:true,threadId:source.threadId,mode:source.mode};
    });
  }
  private guard(token: RunToken, allowBlocked = false, allowUnknown = false): Row {
    this.owner();
    const row = this.one('SELECT r.*,t.workspace_id,t.goal_id,t.write_fence,t.dispatch_blocked,t.constraints_json,t.status AS task_status,d.policy_epoch AS current_policy,d.privacy_epoch AS current_privacy FROM task_runs r JOIN tasks t USING(task_id) JOIN dots d ON d.dot_id=r.dot_id WHERE r.run_id=? AND r.dot_id=?', token.runId, this.dotId);
    if (!row || token.epoch !== this.#epoch || row.runtime_epoch !== this.#epoch || row.task_fence !== token.taskFence || row.write_fence !== token.taskFence) return fail('STALE_RUN');
    if ((!allowUnknown && row.status === 'outcome_unknown') || (!allowBlocked && row.dispatch_blocked === 1) || ['completed','failed','cancelled'].includes(String(row.status))) return fail('RUN_DISPATCH_BLOCKED');
    if (row.policy_epoch !== row.current_policy || row.privacy_epoch !== row.current_privacy || Number(row.lease_until_ms) <= Date.now()) return fail('RUN_GRANT_EXPIRED');
    if(row.goal_id&&!this.one("SELECT goal_id FROM goals WHERE goal_id=? AND dot_id=? AND status='active' AND plan_version=?",row.goal_id,this.dotId,row.goal_plan_version??null))return fail('RUN_GRANT_EXPIRED');
    if (JSON.parse(String(row.constraints_json)).mode === 'workspaceWrite') {
      const lease = this.one('SELECT l.*,w.write_fence FROM workspace_write_leases l JOIN workspaces w USING(workspace_id) WHERE l.workspace_id=?', row.workspace_id!);
      if (!lease || lease.run_id !== token.runId || lease.workspace_fence !== lease.write_fence || Number(lease.lease_until_ms) <= Date.now()) return fail('WORKSPACE_GRANT_EXPIRED');
    }
    this.workspace(String(row.workspace_id)); return row;
  }
  heartbeat(token: RunToken): void {
    this.tx(() => { const run = this.guard(token, true); this.exec('UPDATE task_runs SET lease_until_ms=? WHERE run_id=?', Date.now() + 60_000, token.runId); this.exec('UPDATE workspace_write_leases SET lease_until_ms=? WHERE run_id=?', Date.now() + 60_000, token.runId); this.exec('UPDATE runtime_owners SET updated_at_ms=? WHERE profile_id=?', Date.now(), this.profileId); void run; });
  }
  configureManifest(token: RunToken, moduleHashes: Record<string, string>, toolProfileHash: string): void {
    if (Object.keys(moduleHashes).length > 16 || [...Object.values(moduleHashes),toolProfileHash].some(value => !/^[0-9a-f]{64}$/.test(value))) return fail('INVALID_MANIFEST');
    this.tx(() => {
      const run = this.guard(token);
      if (this.one('SELECT intent_id FROM execution_intents WHERE run_id=?', token.runId)) return fail('MANIFEST_ALREADY_BOUND');
      if ('user' in moduleHashes || 'submission' in moduleHashes) return fail('INVALID_MANIFEST');
      const previous=JSON.parse(String(this.one('SELECT module_hashes_json FROM prompt_manifests WHERE run_id=?',token.runId)!.module_hashes_json)) as Record<string,string>;
      this.exec('UPDATE prompt_manifests SET module_hashes_json=?,tool_snapshot_hash=? WHERE run_id=?', JSON.stringify({ ...previous, ...moduleHashes }), toolProfileHash, token.runId);
      this.event(String(run.task_id), token.runId, 'manifest_bound', { moduleHashes, toolProfileHash });
    });
  }
  confirmNativePolicy(token:RunToken,policyHash:string):void {
    if(!/^[a-f0-9]{64}$/.test(policyHash))return fail('INVALID_NATIVE_POLICY_HASH');
    this.tx(()=>{const run=this.guard(token);if(this.one("SELECT intent_id FROM execution_intents WHERE run_id=? AND kind='turn_start'",token.runId)||!this.one("SELECT intent_id FROM execution_intents WHERE run_id=? AND kind IN ('thread_start','thread_resume') AND state='accepted'",token.runId))return fail('NATIVE_POLICY_SCOPE_MISMATCH');this.event(String(run.task_id),token.runId,'native_policy_verified',{policyHash});});
  }
  prepare(token: RunToken, key: string, kind: 'thread_start' | 'thread_resume' | 'turn_start' | 'turn_interrupt', params: unknown, threadId: string | null = null, turnId: string | null = null): Intent {
    if (!id(key) || !['thread_start','thread_resume','turn_start','turn_interrupt'].includes(kind) || (kind !== 'thread_start' && !id(threadId))) return fail('INVALID_INTENT');
    return this.tx(() => {
      const run = this.guard(token, kind === 'turn_interrupt');
      const inputHash = hashInput(params);
      const previous = this.one('SELECT * FROM execution_intents WHERE intent_key=?', key);
      if (previous) {
        if (previous.run_id !== token.runId || previous.kind !== kind || previous.input_hash !== inputHash
            || (kind !== 'thread_start' && previous.execution_thread_id !== threadId)
            || (kind === 'turn_interrupt' && previous.execution_turn_id !== turnId)) return fail('IDEMPOTENCY_CONFLICT');
        return this.intent(String(previous.intent_id));
      }
      if (threadId && !this.one("SELECT binding_id FROM thread_bindings WHERE task_id=? AND execution_thread_id=? AND state='active'", run.task_id!, threadId)) return fail('THREAD_NOT_BOUND');
      if (kind === 'turn_interrupt' && (!id(turnId) || !this.one("SELECT intent_id FROM execution_intents WHERE run_id=? AND kind='turn_start' AND execution_turn_id=? AND state='accepted'", token.runId, turnId))) return fail('TURN_NOT_BOUND');
      const intentId = randomUUID();
      this.exec("INSERT INTO execution_intents VALUES (?,?,?,?,?,?,'prepared',?,NULL,NULL,NULL,?)", intentId, token.runId, key, kind, threadId, turnId, inputHash, Date.now());
      this.event(String(run.task_id), token.runId, 'intent_prepared', { intentId, kind, inputHash });
      return this.intent(intentId);
    });
  }
  intent(intentId: string): Intent {
    const row = this.one('SELECT i.* FROM execution_intents i JOIN task_runs r USING(run_id) WHERE intent_id=? AND r.dot_id=?', intentId, this.dotId);
    if (!row) return fail('UNKNOWN_INTENT');
    return { intentId, kind: String(row.kind), state: String(row.state), inputHash: String(row.input_hash), threadId: row.execution_thread_id as string | null, turnId: row.execution_turn_id as string | null, rpcId: row.rpc_request_id as string | null };
  }
  sending(token: RunToken, intentId: string, connectionEpoch: number): string {
    if (!Number.isSafeInteger(connectionEpoch) || connectionEpoch < 1) return fail('INVALID_CONNECTION_EPOCH');
    return this.tx(() => {
      const intent = this.intent(intentId), run = this.guard(token, intent.kind === 'turn_interrupt');
      const own = this.one('SELECT run_id FROM execution_intents WHERE intent_id=?', intentId)!;
      if (own.run_id !== token.runId || intent.state !== 'prepared') return fail('INTENT_NOT_PREPARED');
      const rpcId = `intent-${intentId}`;
      this.exec("UPDATE execution_intents SET state='sending',connection_epoch=?,rpc_request_id=? WHERE intent_id=?", connectionEpoch, rpcId, intentId);
      if (intent.kind !== 'turn_interrupt') this.exec("UPDATE task_runs SET status='submitting' WHERE run_id=?", token.runId);
      this.event(String(run.task_id), token.runId, 'intent_sending', { intentId, connectionEpoch, rpcId });
      return rpcId;
    });
  }
  accepted(token: RunToken, intentId: string, result: { threadId?: string; turnId?: string }): void {
    this.tx(() => {
      const intent = this.intent(intentId), run = this.guard(token, intent.kind === 'turn_interrupt');
      if (this.one('SELECT run_id FROM execution_intents WHERE intent_id=?', intentId)?.run_id !== token.runId || intent.state !== 'sending') return fail('INTENT_NOT_SENDING');
      if (intent.kind === 'thread_start') {
        if (!id(result.threadId)) return fail('INVALID_THREAD_RESPONSE');
        this.exec("INSERT INTO thread_bindings VALUES (?,?,'codex',?,1,1,'active',NULL)", randomUUID(), run.task_id!, result.threadId);
      } else if (intent.kind === 'turn_start' && !id(result.turnId)) return fail('INVALID_TURN_RESPONSE');
      if (intent.threadId && result.threadId && intent.threadId !== result.threadId) return fail('THREAD_NOT_BOUND');
      this.exec("UPDATE execution_intents SET state='accepted',execution_thread_id=COALESCE(execution_thread_id,?),execution_turn_id=COALESCE(execution_turn_id,?),response_ref=? WHERE intent_id=?", result.threadId ?? null, result.turnId ?? null, `rpc:${intent.rpcId}`, intentId);
      if(intent.kind==='thread_start'||intent.kind==='thread_resume')this.budget.bind(token.runId,String(result.threadId??intent.threadId),intent.kind==='thread_start');
      this.exec("UPDATE task_runs SET status='running' WHERE run_id=?", token.runId);
      this.event(String(run.task_id), token.runId, 'intent_accepted', { intentId, ...result });
    });
  }
  uncertain(token: RunToken, intentId?: string): void {
    this.tx(() => {
      this.owner(); const run = this.one('SELECT * FROM task_runs WHERE run_id=? AND runtime_epoch=?', token.runId, token.epoch);
      if (!run || token.epoch !== this.#epoch || run.task_fence !== token.taskFence) return fail('STALE_RUN');
      if (['completed','failed','cancelled'].includes(String(run.status))) return;
      if (intentId) this.exec("UPDATE execution_intents SET state='outcome_unknown' WHERE intent_id=? AND run_id=? AND state='sending'", intentId, token.runId);
      if (this.one('SELECT status FROM tasks WHERE task_id=?', run.task_id!)?.status !== 'outcome_unknown') this.transition(String(run.task_id), 'outcome_unknown');
      this.exec("UPDATE task_runs SET status='outcome_unknown' WHERE run_id=?", token.runId);
      this.exec('UPDATE tasks SET dispatch_blocked=1 WHERE task_id=?', run.task_id!);
      this.budget.unknown(token.runId);
      this.event(String(run.task_id), token.runId, 'run_outcome_unknown');
      this.stopOperation(String(run.task_id),'outcome_unknown',token.runId);
    });
  }
  rejected(token: RunToken, intentId: string): void {
    this.tx(() => {
      const run = this.guard(token, true);
      if (this.one("SELECT run_id FROM execution_intents WHERE intent_id=? AND state='sending'", intentId)?.run_id !== token.runId) return fail('INTENT_NOT_SENDING');
      this.exec("UPDATE execution_intents SET state='rejected',response_ref='confirmed_protocol_rejection' WHERE intent_id=?", intentId);
      this.event(String(run.task_id), token.runId, 'intent_rejected', { intentId });
    });
  }
  block(token: RunToken): void {
    this.tx(()=>{const run=this.guard(token,true);if(run.dispatch_blocked===1)return;
      const task=this.one('SELECT version FROM tasks WHERE task_id=?',run.task_id!)!,operation=this.openOperation('stop:'+token.runId,'CANCEL_TASK',{runId:token.runId},String(run.task_id),Number(task.version));
      this.exec('UPDATE tasks SET dispatch_blocked=1,version=version+1 WHERE task_id=?',run.task_id!);this.event(String(run.task_id),token.runId,'stop_requested');this.sealOperation(operation.operationId,String(run.task_id),'executing',token.runId);
    });
  }
  finish(token: RunToken, outcome: 'completed' | 'failed' | 'cancelled'): void {
    this.tx(() => {
      const run = this.guard(token, true);
      if (this.one("SELECT intent_id FROM execution_intents WHERE run_id=? AND state IN ('sending','outcome_unknown')", token.runId)) return fail('UNRESOLVED_INTENT');
      if (this.one("SELECT request_id FROM runtime_requests WHERE run_id=? AND state IN ('responding','outcome_unknown')", token.runId)) return fail('UNRESOLVED_SERVER_REQUEST');
      if (outcome === 'completed' && !this.one("SELECT intent_id FROM execution_intents WHERE run_id=? AND kind='turn_start' AND state='accepted'", token.runId)) return fail('TURN_NOT_ACCEPTED');
      this.exec("UPDATE runtime_requests SET state='cancelled' WHERE run_id=? AND state='pending'", token.runId);
      this.exec("UPDATE execution_intents SET state='rejected',response_ref='run_finished_before_send' WHERE run_id=? AND state='prepared'", token.runId);
      if (['waiting_input','waiting_approval'].includes(String(run.task_status))) this.transition(String(run.task_id), 'running');
      this.transition(String(run.task_id), this.stopTarget(String(run.task_id))??(outcome === 'completed' ? 'needs_review' : outcome));
      this.exec('UPDATE task_runs SET status=?,finished_at_ms=? WHERE run_id=?', outcome, Date.now(), token.runId);
      this.exec('DELETE FROM workspace_write_leases WHERE run_id=?', token.runId);
      this.exec("UPDATE workspaces SET state='ready' WHERE workspace_id=?", run.workspace_id!);
      const usage=this.budget.finish(token.runId);this.event(String(run.task_id),token.runId,usage.known?'budget_settled':'budget_usage_unknown',{reportedTokens:usage.tokens,source:usage.known?'matched_reported_usage_or_no_turn_sent':'unconfirmed_usage_held'});
      this.event(String(run.task_id), token.runId, 'run_finished', { outcome, verification: 'pending' });
      this.stopOperation(String(run.task_id),'completed',token.runId);
    });
  }
  saveSnapshot(token: RunToken, view: ThreadView): void {
    const json = JSON.stringify(view);
    if (json.length > 300_000 || view.items.length > 512 || view.turns.length > 64) return fail('SNAPSHOT_TOO_LARGE');
    this.tx(() => {
      this.owner(); const run = this.one('SELECT * FROM task_runs WHERE run_id=? AND runtime_epoch=?', token.runId, token.epoch);
      if (!run || token.epoch !== this.#epoch || run.task_fence !== token.taskFence || !this.one('SELECT binding_id FROM thread_bindings WHERE task_id=? AND execution_thread_id=?', run.task_id!, view.threadId)) return fail('THREAD_NOT_BOUND');
      this.persistSnapshot(token.runId,String(run.task_id),view);
    });
  }
  private persistSnapshot(runId:string,taskId:string,view:ThreadView):void {
    const json=JSON.stringify(view);if(json.length>300000||view.items.length>512||view.turns.length>64)return fail('SNAPSHOT_TOO_LARGE');
    const checkpointId=`display-${runId}`,task=this.one('SELECT version FROM tasks WHERE task_id=?',taskId)!;
    this.exec('INSERT INTO task_checkpoints VALUES (?,?,?,?,1,?,?) ON CONFLICT(checkpoint_id) DO UPDATE SET task_version=excluded.task_version,summary_json=excluded.summary_json,content_sha256=excluded.content_sha256',checkpointId,taskId,runId,task.version!,json,hashInput(view));
    this.exec('UPDATE task_runs SET result_ref=? WHERE run_id=?',checkpointId,runId);
  }
  runs(workspaceId: string, options: { snapshots?: boolean; runId?: string } = {}): RunRecord[] {
    if (!id(workspaceId)) return fail('UNKNOWN_PROJECT');
    return this.all(`SELECT r.*,t.workspace_id,t.title,t.constraints_json,t.status AS task_status,t.dispatch_blocked,b.execution_thread_id,CASE WHEN ? THEN c.summary_json ELSE NULL END AS summary_json FROM task_runs r JOIN tasks t USING(task_id) LEFT JOIN thread_bindings b ON b.task_id=t.task_id AND b.state='active' LEFT JOIN task_checkpoints c ON c.checkpoint_id=r.result_ref WHERE t.workspace_id=? AND t.dot_id=? AND (? IS NULL OR r.run_id=?) ORDER BY r.started_at_ms DESC,r.rowid DESC LIMIT 50`, options.snapshots === false ? 0 : 1, workspaceId, this.dotId, options.runId ?? null, options.runId ?? null).map(row => ({
      runId: String(row.run_id), taskId: String(row.task_id), workspaceId, title: String(row.title), status: String(row.status), taskStatus: String(row.task_status), epoch: Number(row.runtime_epoch), taskFence: Number(row.task_fence), blocked: row.dispatch_blocked === 1,
      threadId: row.execution_thread_id as string | null, turnId: this.one("SELECT execution_turn_id FROM execution_intents WHERE run_id=? AND kind='turn_start' AND execution_turn_id IS NOT NULL", row.run_id!)?.execution_turn_id as string ?? null,
      snapshot: row.summary_json ? JSON.parse(String(row.summary_json)) as ThreadView : null,
      mode: JSON.parse(String(row.constraints_json)).mode as 'readOnly' | 'workspaceWrite',
      errorCode: this.one("SELECT json_extract(payload_json,'$.code') AS code FROM task_events WHERE run_id=? AND event_type='run_diagnostic' ORDER BY sequence DESC LIMIT 1", row.run_id!)?.code as string | undefined,
    }));
  }
  addRequest(token: RunToken, connectionEpoch: number, rpcId: string, threadId: string, turnId: string, payload: Omit<InteractionView, 'requestId' | 'state'>, expiresAt: number): string {
    if (JSON.stringify(payload).length > 24_000 || !id(rpcId) || !Number.isSafeInteger(connectionEpoch) || connectionEpoch < 1) return fail('INVALID_SERVER_REQUEST');
    return this.tx(() => {
      const run = this.guard(token);
      if (!this.one("SELECT intent_id FROM execution_intents WHERE run_id=? AND kind='turn_start' AND state='accepted' AND execution_thread_id=? AND execution_turn_id=? AND connection_epoch=?", token.runId, threadId, turnId, connectionEpoch)) return fail('TURN_NOT_BOUND');
      const requestId = randomUUID();
      this.exec("INSERT INTO runtime_requests VALUES (?,?,?,?,?,?,?,?,'pending',?,NULL,?)", requestId, token.runId, token.epoch, connectionEpoch, rpcId, threadId, turnId, payload.kind, JSON.stringify(payload), expiresAt);
      const target = payload.kind === 'input' ? 'waiting_input' : 'waiting_approval';
      if (run.task_status !== target) {
        if (run.task_status !== 'running') this.transition(String(run.task_id), 'running');
        this.transition(String(run.task_id), target);
      }
      this.exec('UPDATE task_runs SET status=? WHERE run_id=?', target, token.runId);
      this.event(String(run.task_id), token.runId, 'server_request_pending', { requestId, kind: payload.kind, connectionEpoch });
      return requestId;
    });
  }
  requests(workspaceId: string, runId: string): InteractionView[] {
    return this.all("SELECT q.* FROM runtime_requests q JOIN task_runs r USING(run_id) JOIN tasks t USING(task_id) WHERE q.run_id=? AND t.workspace_id=? AND t.dot_id=? ORDER BY (q.state='pending') DESC,q.rowid DESC LIMIT 32", runId, workspaceId, this.dotId).map(row => ({ ...JSON.parse(String(row.payload_json)) as Omit<InteractionView,'requestId'|'state'>, requestId: String(row.request_id), state: String(row.state) }));
  }
  responding(token: RunToken, requestId: string, epoch: number, response: unknown, expired: boolean | 'cancelled' = false): void {
    this.tx(() => {
      const run = this.guard(token, true), request = this.one('SELECT * FROM runtime_requests WHERE request_id=? AND run_id=?', requestId, token.runId);
      if (!request || request.runtime_epoch !== token.epoch || request.connection_epoch !== epoch || request.state !== 'pending') return fail('STALE_SERVER_REQUEST');
      if (!expired && Number(request.expires_at_ms) <= Date.now()) return fail('SERVER_REQUEST_EXPIRED');
      this.exec('UPDATE runtime_requests SET state=?,response_hash=? WHERE request_id=?', expired === 'cancelled' ? 'cancelled' : expired ? 'expired' : 'responding', hashInput(response), requestId);
      this.event(String(run.task_id), token.runId, expired === 'cancelled' ? 'server_request_cancelled' : expired ? 'server_request_expired' : 'server_response_prepared', { requestId, responseHash: hashInput(response) });
    });
  }
  responseWritten(token: RunToken, requestId: string, sent: boolean): void {
    this.tx(() => {
      const run = this.guard(token, true), request = this.one('SELECT * FROM runtime_requests WHERE request_id=? AND run_id=?', requestId, token.runId);
      if (!request || request.runtime_epoch !== token.epoch || !['responding','expired','cancelled'].includes(String(request.state))) return;
      if (request.state === 'responding') this.exec('UPDATE runtime_requests SET state=? WHERE request_id=?', sent ? 'responded' : 'outcome_unknown', requestId);
      if (!this.one("SELECT request_id FROM runtime_requests WHERE run_id=? AND state IN ('pending','responding')", token.runId) && ['waiting_input','waiting_approval'].includes(String(run.task_status))) {
        this.transition(String(run.task_id), 'running'); this.exec("UPDATE task_runs SET status='running' WHERE run_id=?", token.runId);
      }
      this.event(String(run.task_id), token.runId, sent ? 'server_response_written' : 'server_response_unknown', { requestId });
    });
    if (!sent) this.uncertain(token);
  }
  runForHost(runId: string): RunRecord {
    const row = this.one('SELECT t.workspace_id FROM task_runs r JOIN tasks t USING(task_id) WHERE r.run_id=? AND r.dot_id=?', runId, this.dotId);
    if (!row) return fail('UNKNOWN_RUN');
    return this.runs(String(row.workspace_id), { snapshots: false, runId })[0]!;
  }
  diagnostic(token: RunToken, code: string): void {
    if (!/^[A-Z0-9_-]{1,100}$/.test(code)) return fail('INVALID_DIAGNOSTIC');
    this.tx(() => { this.owner(); const run=this.runForHost(token.runId);if(run.epoch!==token.epoch||token.epoch!==this.#epoch)return fail('STALE_RUN');this.event(run.taskId,run.runId,'run_diagnostic',{code}); });
  }
  executorClosed(token: RunToken, connectionEpoch: number): void {
    this.tx(()=>{this.owner();const run=this.runForHost(token.runId);if(run.epoch!==token.epoch||token.epoch!==this.#epoch)return fail('STALE_RUN');this.event(run.taskId,run.runId,'executor_closed',{connectionEpoch,runtimeEpoch:token.epoch});if(run.status==='outcome_unknown')this.budget.unknown(run.runId,true);});
  }
  resourceBudget(){return this.tx(()=>{this.owner();return this.budget.snapshot();});}
  recordTokenUsage(token:RunToken,threadId:string,turnId:string,total:unknown):void {
    this.tx(()=>{
      this.owner();const run=this.one('SELECT r.*,t.write_fence FROM task_runs r JOIN tasks t USING(task_id) WHERE r.run_id=? AND r.dot_id=?',token.runId,this.dotId);
      if(!run||token.epoch!==this.#epoch||run.runtime_epoch!==this.#epoch||run.task_fence!==token.taskFence||run.write_fence!==token.taskFence)return fail('STALE_RUN_USAGE');
      if(!this.one("SELECT intent_id FROM execution_intents WHERE run_id=? AND kind='turn_start' AND state='accepted' AND execution_thread_id=? AND execution_turn_id=?",token.runId,threadId,turnId))return fail('USAGE_SCOPE_MISMATCH');
      const result=this.budget.observe(token.runId,threadId,total);if(result!=='duplicate')this.event(String(run.task_id),token.runId,result==='invalid'?'token_usage_invalid':'token_usage_observed',result==='invalid'?{code:'INVALID_USAGE_COUNTER'}:{reportedThreadTotal:total});
    });
  }
  matchesUserInput(runId: string, text: string): boolean {
    this.runForHost(runId);const row=this.one('SELECT module_hashes_json FROM prompt_manifests WHERE run_id=?',runId);
    return Boolean(row && JSON.parse(String(row.module_hashes_json)).user===hashInput(text));
  }
  reconciliationClaim(runId:string):ReconciliationClaim {
    this.owner();const run=this.runForHost(runId),task=this.one('SELECT * FROM tasks WHERE task_id=?',run.taskId)!;
    if(run.status!=='outcome_unknown'||task.status!=='outcome_unknown'||!run.blocked||task.write_fence!==run.taskFence||!run.threadId)return fail('RUN_NOT_RECONCILABLE');
    this.workspace(run.workspaceId);
    const intent=this.one("SELECT * FROM execution_intents WHERE run_id=? AND kind='turn_start' AND state IN ('accepted','outcome_unknown','sending')",runId);
    if(!intent||intent.execution_thread_id!==run.threadId)return fail('NO_RECONCILABLE_TURN');
    if(!this.one("SELECT event_id FROM task_events WHERE run_id=? AND event_type='executor_closed' AND json_extract(payload_json,'$.runtimeEpoch')=? AND json_extract(payload_json,'$.connectionEpoch')=?",runId,run.epoch,intent.connection_epoch!))return fail('EXECUTOR_CLOSURE_UNPROVEN');
    if(this.one("SELECT request_id FROM runtime_requests WHERE run_id=? AND state IN ('pending','responding','outcome_unknown')",runId))return fail('UNRESOLVED_SERVER_REQUEST');
    if(this.one("SELECT intent_id FROM execution_intents WHERE run_id=? AND kind IN ('thread_start','thread_resume') AND state<>'accepted'",runId))return fail('THREAD_RECEIPT_UNCONFIRMED');
    const manifest=JSON.parse(String(this.one('SELECT module_hashes_json FROM prompt_manifests WHERE run_id=?',runId)!.module_hashes_json));
    if(typeof manifest.user!=='string')return fail('USER_INPUT_HASH_UNAVAILABLE');
    const epochs=this.one('SELECT r.policy_epoch,r.privacy_epoch,d.policy_epoch AS current_policy,d.privacy_epoch AS current_privacy FROM task_runs r JOIN dots d USING(dot_id) WHERE run_id=?',runId)!;
    if(epochs.policy_epoch!==epochs.current_policy||epochs.privacy_epoch!==epochs.current_privacy)return fail('RUN_GRANT_EXPIRED');
    return{runId,taskId:run.taskId,workspaceId:run.workspaceId,threadId:run.threadId,turnId:run.turnId,taskVersion:Number(task.version),runtimeEpoch:run.epoch,connectionEpoch:Number(intent.connection_epoch),taskFence:run.taskFence,userHash:manifest.user,
      priorTurnIds:this.all("SELECT i.execution_turn_id FROM execution_intents i JOIN task_runs r USING(run_id) WHERE r.task_id=? AND r.run_id<>? AND i.kind='turn_start' AND i.execution_turn_id IS NOT NULL",run.taskId,runId).map(row=>String(row.execution_turn_id))};
  }
  reconcile(claim:ReconciliationClaim,result:{turnId:string;status:'completed'|'failed'|'interrupted';userHash:string;snapshot:ThreadView;evidenceHash:string}):void {
    this.tx(()=>{
      const fresh=this.reconciliationClaim(claim.runId);
      if(hashInput(fresh)!==hashInput(claim))return fail('STALE_RECONCILIATION');
      if(!id(result.turnId)||result.userHash!==claim.userHash||(claim.turnId&&claim.turnId!==result.turnId)||claim.priorTurnIds.includes(result.turnId)||result.snapshot.threadId!==claim.threadId||result.snapshot.needsSnapshot||result.snapshot.truncated||result.snapshot.unsupportedItems||result.snapshot.turns.length!==1||result.snapshot.turns[0]?.id!==result.turnId||result.snapshot.turns[0]?.status!==result.status||!/^[a-f0-9]{64}$/.test(result.evidenceHash))return fail('INVALID_RECONCILIATION');
      if(!['completed','failed','interrupted'].includes(result.status))return fail('INVALID_RECONCILIATION');
      const outcome=result.status==='interrupted'?'cancelled':result.status;
      this.exec("UPDATE execution_intents SET state='reconciled',execution_turn_id=COALESCE(execution_turn_id,?),response_ref=? WHERE run_id=? AND kind IN ('turn_start','turn_interrupt') AND state IN ('sending','accepted','outcome_unknown')",result.turnId,`history:${result.evidenceHash}`,claim.runId);
      this.transition(claim.taskId,outcome==='completed'?'needs_review':'failed');
      this.exec('UPDATE tasks SET dispatch_blocked=0 WHERE task_id=?',claim.taskId);
      this.exec('UPDATE task_runs SET status=?,finished_at_ms=? WHERE run_id=?',outcome,Date.now(),claim.runId);
      this.exec('DELETE FROM workspace_write_leases WHERE run_id=?',claim.runId);
      this.exec("UPDATE workspaces SET state='ready' WHERE workspace_id=? AND NOT EXISTS(SELECT 1 FROM workspace_write_leases WHERE workspace_id=?)",claim.workspaceId,claim.workspaceId);
      this.persistSnapshot(claim.runId,claim.taskId,result.snapshot);
      this.event(claim.taskId,claim.runId,'history_reconciled',{turnId:result.turnId,status:result.status,evidenceHash:result.evidenceHash,verification:'pending'});
      const stop=this.stopTarget(claim.taskId);if(stop){if(stop==='paused')this.transition(claim.taskId,'queued');this.transition(claim.taskId,stop);this.exec('UPDATE tasks SET dispatch_blocked=1 WHERE task_id=?',claim.taskId);this.stopOperation(claim.taskId,'completed',claim.runId);}
    });
  }
  installVerification(token: RunToken, plan: VerificationPlan): void {
    this.tx(() => {
      const run = this.guard(token);
      if (plan.runId !== token.runId || this.one('SELECT intent_id FROM execution_intents WHERE run_id=?', token.runId)) return fail('VERIFICATION_CONTRACT_TOO_LATE');
      const revision=Number(this.one('SELECT COALESCE(MAX(revision),0) AS n FROM verification_specs WHERE task_id=?',run.task_id!)!.n)+1;
      this.exec('INSERT INTO verification_specs VALUES (?,?,?,?,?,?,?,?)', plan.specId, run.task_id!, revision, plan.baselineCommit,
        JSON.stringify(plan.commandArgv), JSON.stringify([plan.target]), JSON.stringify(plan), plan.verifierHash);
      this.event(String(run.task_id), token.runId, 'verification_contract_frozen', { specId: plan.specId, target: plan.target, requiredCases: plan.requiredCases.length });
    });
  }
  verificationPlan(runId: string): VerificationPlan | null {
    const row = this.one("SELECT v.expectation_json FROM verification_specs v JOIN task_runs r ON r.task_id=v.task_id WHERE r.run_id=? AND r.dot_id=? AND json_extract(v.expectation_json,'$.runId')=? ORDER BY v.revision DESC LIMIT 1", runId, this.dotId, runId);
    return row ? JSON.parse(String(row.expectation_json)) as VerificationPlan : null;
  }
  claimVerification(runId: string): { runId: string; epoch: number; workspaceFence: number; taskVersion: number } {
    return this.tx(() => {
      this.owner(); const run = this.runForHost(runId), task = this.one('SELECT * FROM tasks WHERE task_id=?', run.taskId)!;
      if (run.status !== 'completed' || task.status !== 'needs_review' || task.write_fence !== run.taskFence || task.dispatch_blocked === 1) return fail('RUN_NOT_VERIFIABLE');
      this.projectOperationAvailable(run.workspaceId);
      if (this.one('SELECT run_id FROM workspace_write_leases WHERE workspace_id=?', run.workspaceId)) return fail('WORKSPACE_BUSY');
      this.workspace(run.workspaceId);
      this.exec('UPDATE workspaces SET write_fence=write_fence+1 WHERE workspace_id=?', run.workspaceId);
      const fence = Number(this.one('SELECT write_fence FROM workspaces WHERE workspace_id=?', run.workspaceId)!.write_fence);
      this.exec('INSERT INTO workspace_write_leases VALUES (?,?,?,?)', run.workspaceId, runId, fence, Date.now()+60000);
      return { runId, epoch: this.#epoch, workspaceFence: fence, taskVersion: Number(task.version) };
    });
  }
  recordVerification(claim: { runId: string; epoch: number; workspaceFence: number; taskVersion: number }, plan: VerificationPlan, receipt: VerificationReceipt, artifact: { storageKey: string; hash: string; bytes: number }): void {
    this.tx(() => {
      this.owner(); const run = this.runForHost(claim.runId), task = this.one('SELECT * FROM tasks WHERE task_id=?', run.taskId)!;
      this.workspace(run.workspaceId);
      const lease = this.one('SELECT * FROM workspace_write_leases WHERE run_id=?', claim.runId);
      if (claim.epoch !== this.#epoch || !lease || lease.workspace_fence !== claim.workspaceFence || Number(lease.lease_until_ms)<=Date.now() || task.version !== claim.taskVersion || task.status !== 'needs_review') return fail('STALE_VERIFICATION');
      if (plan.specId !== this.verificationPlan(claim.runId)?.specId || receipt.runId !== claim.runId || receipt.specId !== plan.specId) return fail('VERIFICATION_SCOPE_MISMATCH');
      if (receipt.status === 'passed' && (receipt.code !== 'VERIFIED' || receipt.exitCode !== 0 || receipt.executed < 1 || plan.requiredCases.some(key => !receipt.passedCases.includes(key)))) return fail('INVALID_VERIFICATION_RECEIPT');
      this.exec("INSERT INTO artifacts(artifact_id,dot_id,task_id,content_sha256,relative_storage_key,state,sensitivity,privacy_epoch,size_bytes) VALUES (?,?,?,?,?,'published','private',1,?)", receipt.verificationId, this.dotId, run.taskId, artifact.hash, artifact.storageKey, artifact.bytes);
      this.exec('INSERT INTO verification_results VALUES (?,?,?,?,?,?,?,?,?)', receipt.verificationId, claim.runId, plan.specId, receipt.status, receipt.discovered, receipt.executed, receipt.skipped, receipt.verificationId, Date.now());
      if (receipt.status === 'passed') this.transition(run.taskId, 'completed');
      this.event(run.taskId, run.runId, 'verification_recorded', { verificationId: receipt.verificationId, status: receipt.status, code: receipt.code, workspaceHash: receipt.workspaceHash });
    });
  }
  releaseVerification(claim: { runId: string; epoch: number; workspaceFence: number }): void {
    this.tx(() => { this.owner(); if (claim.epoch !== this.#epoch) return fail('STALE_RUNTIME_OWNER'); this.exec('DELETE FROM workspace_write_leases WHERE run_id=? AND workspace_fence=?', claim.runId, claim.workspaceFence); });
  }
  latestVerification(runId: string): { artifactId: string; storageKey: string; hash: string } | null {
    this.runForHost(runId);
    const row = this.one("SELECT a.* FROM verification_results v JOIN artifacts a ON a.artifact_id=v.evidence_ref WHERE v.run_id=? AND a.dot_id=? AND a.state='published' ORDER BY v.observed_at_ms DESC,v.rowid DESC LIMIT 1", runId, this.dotId);
    return row ? { artifactId: String(row.artifact_id), storageKey: String(row.relative_storage_key), hash: String(row.content_sha256) } : null;
  }
  close(): void {
    if (this.#epoch) this.exec("UPDATE runtime_owners SET state='stopped',updated_at_ms=? WHERE profile_id=? AND runtime_epoch=? AND instance_id=?", Date.now(), this.profileId, this.#epoch, this.#instance);
    this.#db.close();
  }
}
