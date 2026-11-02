import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { taskTransitions } from '../../../docs/design/contracts/domain.ts';
import type { TaskStatus } from '../../../docs/design/contracts/domain.ts';
import type { ProjectView, ThreadView } from '../../contracts/src/views.ts';

export class LedgerError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
const fail = (code: string): never => { throw new LedgerError(code); };
export const hashInput = (input: unknown): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const active = "('preparing','submitting','running','waiting_input','waiting_approval','outcome_unknown')";
type Row = Record<string, string | number | null>;
export interface RunToken { runId: string; epoch: number; taskFence: number }
export interface Intent { intentId: string; kind: string; state: string; inputHash: string; threadId: string | null; turnId: string | null; rpcId: string | null }
export interface RunRecord extends RunToken {
  taskId: string; workspaceId: string; title: string; taskStatus: string; status: string;
  threadId: string | null; turnId: string | null; blocked: boolean; snapshot: ThreadView | null;
}

/** Host-only local store. startOwner requires the caller to hold the OS single-instance lock. */
export class ExecutionLedger {
  #db: DatabaseSync;
  #epoch = 0;
  #instance = '';
  readonly profileId = 'local-profile';
  readonly dotId = 'local-dot';
  constructor(path: string, schemaSql: string) {
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
      if (this.one('SELECT schema_revision FROM schema_metadata WHERE singleton=1')?.schema_revision !== 2) fail('LEDGER_SCHEMA_UNSUPPORTED');
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
  private event(taskId: string, runId: string | null, type: string, payload: unknown = {}): void {
    this.exec('UPDATE tasks SET last_event_sequence=last_event_sequence+1,updated_at_ms=? WHERE task_id=?', Date.now(), taskId);
    const task = this.one('SELECT last_event_sequence,version FROM tasks WHERE task_id=?', taskId)!;
    const eventId = randomUUID(), data = JSON.stringify(payload);
    this.exec('INSERT INTO task_events VALUES (?,?,?,?,?,?,NULL,NULL,?,?)', eventId, taskId, runId, task.last_event_sequence!, task.version!, type, data, Date.now());
    this.exec("INSERT INTO outbox_events(outbox_id,dedupe_key,event_type,aggregate_ref,payload_json) VALUES (?,?,?,?,?)", randomUUID(), eventId, type, taskId, data);
  }
  private transition(taskId: string, target: TaskStatus): void {
    const task = this.one('SELECT status FROM tasks WHERE task_id=?', taskId);
    if (!task || !taskTransitions[task.status as TaskStatus].includes(target)) fail('INVALID_TASK_TRANSITION');
    this.exec('UPDATE tasks SET status=?,version=version+1,updated_at_ms=? WHERE task_id=?', target, Date.now(), taskId);
  }
  startOwner(instanceId: string, exclusiveLockHeld: true): number {
    if (!id(instanceId) || exclusiveLockHeld !== true || this.#epoch) return fail('OWNER_LOCK_REQUIRED');
    const epoch = this.tx(() => {
      this.exec('INSERT OR IGNORE INTO profiles VALUES (?,?,?)', this.profileId, '本机', Date.now());
      this.exec('INSERT OR IGNORE INTO dots(dot_id,profile_id,display_name) VALUES (?,?,?)', this.dotId, this.profileId, 'Personal Agent');
      const next = Number(this.one('SELECT runtime_epoch FROM runtime_owners WHERE profile_id=?', this.profileId)?.runtime_epoch ?? 0) + 1;
      this.exec("INSERT INTO runtime_owners VALUES (?,?,?,'main','ready',?) ON CONFLICT(profile_id) DO UPDATE SET runtime_epoch=excluded.runtime_epoch,instance_id=excluded.instance_id,state='ready',updated_at_ms=excluded.updated_at_ms", this.profileId, next, instanceId, Date.now());
      for (const run of this.all(`SELECT * FROM task_runs WHERE status IN ${active} AND dot_id=?`, this.dotId)) {
        this.exec("UPDATE execution_intents SET state='outcome_unknown' WHERE run_id=? AND state='sending'", run.run_id!);
        this.exec("UPDATE execution_intents SET state='rejected',response_ref='owner_stopped_before_send' WHERE run_id=? AND state='prepared'", run.run_id!);
        this.exec("UPDATE task_runs SET status='outcome_unknown' WHERE run_id=?", run.run_id!);
        const task = this.one('SELECT status FROM tasks WHERE task_id=?', run.task_id!)!;
        if (task.status !== 'outcome_unknown') this.transition(String(run.task_id), 'outcome_unknown');
        this.exec('UPDATE tasks SET dispatch_blocked=1 WHERE task_id=?', run.task_id!);
        this.event(String(run.task_id), String(run.run_id), 'owner_recovery_unknown');
      }
      return next;
    });
    this.#epoch = epoch; this.#instance = instanceId; return epoch;
  }
  registerWorkspace(directory: string, gitRoot?: string): ProjectView {
    this.owner();
    const cwd = realpathSync(directory), info = statSync(cwd, { bigint: true });
    if (!info.isDirectory()) return fail('PROJECT_NOT_DIRECTORY');
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
        if (Number(this.one('SELECT COUNT(*) AS n FROM workspaces WHERE dot_id=?', this.dotId)!.n) >= 16) return fail('PROJECT_LIMIT');
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
    return this.all('SELECT workspace_id,canonical_cwd FROM workspaces WHERE dot_id=? ORDER BY rowid LIMIT 100', this.dotId)
      .map(row => ({ id: String(row.workspace_id), directory: String(row.canonical_cwd), name: basename(String(row.canonical_cwd)) }));
  }
  workspace(workspaceId: string): ProjectView {
    const row = this.one('SELECT w.*,i.device_id,i.inode FROM workspaces w JOIN workspace_identities i USING(workspace_id) WHERE workspace_id=? AND dot_id=?', workspaceId, this.dotId);
    if (!row) return fail('UNKNOWN_PROJECT');
    try {
      const cwd = realpathSync(String(row.canonical_cwd)), info = statSync(cwd, { bigint: true });
      if (cwd !== row.canonical_cwd || !info.isDirectory() || String(info.dev) !== row.device_id || String(info.ino) !== row.inode) return fail('PROJECT_IDENTITY_CHANGED');
      return { id: workspaceId, name: basename(cwd), directory: cwd };
    } catch (error) { if (error instanceof LedgerError) throw error; return fail('PROJECT_UNAVAILABLE'); }
  }
  beginRun(workspaceId: string, text: string, key: string, mode: 'readOnly' | 'workspaceWrite'): { token: RunToken; created: boolean } {
    if (!id(key) || typeof text !== 'string' || !text.trim() || text.length > 32_768 || !['readOnly','workspaceWrite'].includes(mode)) return fail('INVALID_TASK_INPUT');
    this.workspace(workspaceId);
    const inputHash = hashInput([workspaceId, text, mode]);
    return this.tx(() => {
      this.owner();
      const previous = this.one('SELECT r.*,t.constraints_json FROM task_runs r JOIN tasks t USING(task_id) WHERE r.idempotency_key=? AND r.dot_id=?', key, this.dotId);
      if (previous) {
        if (JSON.parse(String(previous.constraints_json)).inputHash !== inputHash) return fail('IDEMPOTENCY_CONFLICT');
        return { token: { runId: String(previous.run_id), epoch: Number(previous.runtime_epoch), taskFence: Number(previous.task_fence) }, created: false };
      }
      if (this.one(`SELECT run_id FROM task_runs WHERE dot_id=? AND status IN ${active}`, this.dotId)) return fail('RUNTIME_BUSY');
      const taskId = randomUUID(), runId = randomUUID();
      this.exec("INSERT INTO tasks(task_id,dot_id,workspace_id,title,constraints_json,status,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'created',?,?)", taskId, this.dotId, workspaceId, text.slice(0, 120), JSON.stringify({ inputHash, mode }), Date.now(), Date.now());
      this.event(taskId, null, 'task_created'); this.transition(taskId, 'queued'); this.transition(taskId, 'running');
      this.exec('UPDATE tasks SET write_fence=write_fence+1 WHERE task_id=?', taskId);
      this.exec("INSERT INTO task_runs(run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms) VALUES (?,?,?,?,'codex','preparing',3,1,?,1,1,?,?,?)", runId, taskId, this.dotId, key, this.#epoch, this.#instance, Date.now() + 60_000, Date.now());
      if (mode === 'workspaceWrite') {
        if (this.one('SELECT run_id FROM workspace_write_leases WHERE workspace_id=?', workspaceId)) return fail('WORKSPACE_BUSY');
        this.exec('UPDATE workspaces SET write_fence=write_fence+1,state=\'busy\' WHERE workspace_id=?', workspaceId);
        const ws = this.one('SELECT write_fence FROM workspaces WHERE workspace_id=?', workspaceId)!;
        this.exec('INSERT INTO workspace_write_leases VALUES (?,?,?,?)', workspaceId, runId, ws.write_fence!, Date.now() + 60_000);
      }
      this.exec("INSERT INTO prompt_manifests VALUES (?,?,'coding',?,'{}',?,1,1,'[]',NULL)", randomUUID(), runId, mode === 'readOnly' ? 'read-only' : 'execution', hashInput({ mode }));
      this.event(taskId, runId, 'run_claimed', { mode });
      return { token: { runId, epoch: this.#epoch, taskFence: 1 }, created: true };
    });
  }
  private guard(token: RunToken, allowBlocked = false, allowUnknown = false): Row {
    this.owner();
    const row = this.one('SELECT r.*,t.workspace_id,t.write_fence,t.dispatch_blocked,t.constraints_json,t.status AS task_status,d.policy_epoch AS current_policy,d.privacy_epoch AS current_privacy FROM task_runs r JOIN tasks t USING(task_id) JOIN dots d ON d.dot_id=r.dot_id WHERE r.run_id=? AND r.dot_id=?', token.runId, this.dotId);
    if (!row || token.epoch !== this.#epoch || row.runtime_epoch !== this.#epoch || row.task_fence !== token.taskFence || row.write_fence !== token.taskFence) return fail('STALE_RUN');
    if ((!allowUnknown && row.status === 'outcome_unknown') || (!allowBlocked && row.dispatch_blocked === 1) || ['completed','failed','cancelled'].includes(String(row.status))) return fail('RUN_DISPATCH_BLOCKED');
    if (row.policy_epoch !== row.current_policy || row.privacy_epoch !== row.current_privacy || Number(row.lease_until_ms) <= Date.now()) return fail('RUN_GRANT_EXPIRED');
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
      this.exec('UPDATE prompt_manifests SET module_hashes_json=?,tool_snapshot_hash=? WHERE run_id=?', JSON.stringify(moduleHashes), toolProfileHash, token.runId);
      this.event(String(run.task_id), token.runId, 'manifest_bound', { moduleHashes, toolProfileHash });
    });
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
      this.event(String(run.task_id), token.runId, 'run_outcome_unknown');
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
  block(token: RunToken): void { this.tx(() => { const run = this.guard(token); this.exec('UPDATE tasks SET dispatch_blocked=1,version=version+1 WHERE task_id=?', run.task_id!); this.event(String(run.task_id), token.runId, 'stop_requested'); }); }
  finish(token: RunToken, outcome: 'completed' | 'failed' | 'cancelled'): void {
    this.tx(() => {
      const run = this.guard(token, true);
      if (this.one("SELECT intent_id FROM execution_intents WHERE run_id=? AND state IN ('sending','outcome_unknown')", token.runId)) return fail('UNRESOLVED_INTENT');
      if (outcome === 'completed' && !this.one("SELECT intent_id FROM execution_intents WHERE run_id=? AND kind='turn_start' AND state='accepted'", token.runId)) return fail('TURN_NOT_ACCEPTED');
      this.transition(String(run.task_id), outcome === 'completed' ? 'needs_review' : outcome);
      this.exec('UPDATE task_runs SET status=?,finished_at_ms=? WHERE run_id=?', outcome, Date.now(), token.runId);
      this.exec('DELETE FROM workspace_write_leases WHERE run_id=?', token.runId);
      this.exec("UPDATE workspaces SET state='ready' WHERE workspace_id=?", run.workspace_id!);
      this.event(String(run.task_id), token.runId, 'run_finished', { outcome, verification: 'pending' });
    });
  }
  saveSnapshot(token: RunToken, view: ThreadView): void {
    const json = JSON.stringify(view);
    if (json.length > 300_000 || view.items.length > 512 || view.turns.length > 64) return fail('SNAPSHOT_TOO_LARGE');
    this.tx(() => {
      this.owner(); const run = this.one('SELECT * FROM task_runs WHERE run_id=? AND runtime_epoch=?', token.runId, token.epoch);
      if (!run || token.epoch !== this.#epoch || run.task_fence !== token.taskFence || !this.one('SELECT binding_id FROM thread_bindings WHERE task_id=? AND execution_thread_id=?', run.task_id!, view.threadId)) return fail('THREAD_NOT_BOUND');
      const checkpointId = `display-${token.runId}`;
      const task = this.one('SELECT version FROM tasks WHERE task_id=?', run.task_id!)!;
      this.exec('INSERT INTO task_checkpoints VALUES (?,?,?,?,1,?,?) ON CONFLICT(checkpoint_id) DO UPDATE SET task_version=excluded.task_version,summary_json=excluded.summary_json,content_sha256=excluded.content_sha256', checkpointId, run.task_id!, token.runId, task.version!, json, hashInput(view));
      this.exec('UPDATE task_runs SET result_ref=? WHERE run_id=?', checkpointId, token.runId);
    });
  }
  runs(workspaceId: string, options: { snapshots?: boolean; runId?: string } = {}): RunRecord[] {
    if (!id(workspaceId)) return fail('UNKNOWN_PROJECT');
    return this.all(`SELECT r.*,t.workspace_id,t.title,t.status AS task_status,t.dispatch_blocked,b.execution_thread_id,CASE WHEN ? THEN c.summary_json ELSE NULL END AS summary_json FROM task_runs r JOIN tasks t USING(task_id) LEFT JOIN thread_bindings b ON b.task_id=t.task_id AND b.state='active' LEFT JOIN task_checkpoints c ON c.checkpoint_id=r.result_ref WHERE t.workspace_id=? AND t.dot_id=? AND (? IS NULL OR r.run_id=?) ORDER BY r.started_at_ms DESC,r.rowid DESC LIMIT 50`, options.snapshots === false ? 0 : 1, workspaceId, this.dotId, options.runId ?? null, options.runId ?? null).map(row => ({
      runId: String(row.run_id), taskId: String(row.task_id), workspaceId, title: String(row.title), status: String(row.status), taskStatus: String(row.task_status), epoch: Number(row.runtime_epoch), taskFence: Number(row.task_fence), blocked: row.dispatch_blocked === 1,
      threadId: row.execution_thread_id as string | null, turnId: this.one("SELECT execution_turn_id FROM execution_intents WHERE run_id=? AND kind='turn_start' AND execution_turn_id IS NOT NULL", row.run_id!)?.execution_turn_id as string ?? null,
      snapshot: row.summary_json ? JSON.parse(String(row.summary_json)) as ThreadView : null,
    }));
  }
  close(): void {
    if (this.#epoch) this.exec("UPDATE runtime_owners SET state='stopped',updated_at_ms=? WHERE profile_id=? AND runtime_epoch=? AND instance_id=?", Date.now(), this.profileId, this.#epoch, this.#instance);
    this.#db.close();
  }
}
