import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import type { ProjectView } from '../../contracts/src/views.ts';
import type {
  OpenTerminal,
  TerminalHostSession,
  TerminalInputReceipt,
  TerminalSession,
  WriteTerminal,
} from '../../contracts/src/terminal.ts';
type Row = Record<string, string | number | null>;
interface Hooks {
  owner: () => void;
  epoch: () => number;
  tx: <T>(work: () => T) => T;
  context: (id: string) => { projectId: string; workspace: ProjectView };
  available: (id: string) => void;
  open: (key: string, kind: string, input: unknown) => { operationId: string; created: boolean };
}
export class TerminalLedger {
  private db: DatabaseSync;
  private dot: string;
  private fail: (code: string) => never;
  private h: Hooks;
  private inputKeys = new Map<string, Buffer>();
  constructor(db: DatabaseSync, dot: string, fail: (code: string) => never, h: Hooks) {
    this.db = db;
    this.dot = dot;
    this.fail = fail;
    this.h = h;
  }
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private exec(sql: string, ...args: SQLInputValue[]) {
    this.db.prepare(sql).run(...args);
  }
  recover() {
    for (const row of this.db
      .prepare(
        "SELECT * FROM terminal_sessions WHERE dot_id=? AND state IN ('prepared','starting','running','stopping')",
      )
      .all(this.dot) as Row[]) {
      const state = row.state === 'prepared' ? 'exited' : 'outcome_unknown';
      this.exec(
        'UPDATE terminal_sessions SET state=?,error_code=? WHERE session_id=?',
        state,
        state === 'exited' ? 'OWNER_STOPPED_BEFORE_SHELL' : 'OWNER_RECOVERY_UNKNOWN',
        row.session_id!,
      );
      this.exec(
        'UPDATE operations SET state=? WHERE operation_id=?',
        state === 'exited' ? 'failed' : 'outcome_unknown',
        row.operation_id!,
      );
      this.exec(
        "UPDATE operations SET state=? WHERE kind='STOP_USER_TERMINAL' AND json_extract(input_json,'$.sessionId')=? AND state='executing'",
        state === 'exited' ? 'failed' : 'outcome_unknown',
        row.session_id!,
      );
      if (state === 'exited')
        this.exec('DELETE FROM workspace_terminal_leases WHERE session_id=?', row.session_id!);
      this.exec(
        "UPDATE terminal_inputs SET state='outcome_unknown' WHERE session_id=? AND state='sending'",
        row.session_id!,
      );
    }
  }
  private view(row: Row): TerminalSession {
    const input = this.one(
      'SELECT state FROM terminal_inputs WHERE session_id=? AND sequence=?',
      row.session_id!,
      row.last_input_sequence!,
    );
    return {
      sessionId: String(row.session_id),
      projectId: String(row.workspace_id),
      state: row.state as TerminalSession['state'],
      cols: Number(row.cols),
      rows: Number(row.rows),
      lastInputSequence: Number(row.last_input_sequence),
      lastInputState: (input?.state as TerminalSession['lastInputState']) ?? null,
      exitCode: row.exit_code as number | null,
      errorCode: row.error_code as string | null,
      createdAt: Number(row.created_at_ms),
    };
  }
  host(projectId: string, sessionId: string): TerminalHostSession {
    const context = this.h.context(projectId),
      row =
        this.one(
          'SELECT * FROM terminal_sessions WHERE session_id=? AND workspace_id=? AND dot_id=?',
          sessionId,
          projectId,
          this.dot,
        ) ?? this.fail('TERMINAL_SCOPE_MISMATCH'),
      s = statSync(context.workspace.directory, { bigint: true });
    return {
      ...this.view(row),
      operationId: String(row.operation_id),
      epoch: Number(row.runtime_epoch),
      fence: Number(row.workspace_fence),
      supervisorPid: row.supervisor_pid as number | null,
      ptyPid: row.pty_pid as number | null,
      rootIdentity: { device: String(s.dev), inode: String(s.ino) },
      directory: context.workspace.directory,
    };
  }
  latest(projectId: string): TerminalSession | null {
    this.h.context(projectId);
    const row = this.one(
      'SELECT * FROM terminal_sessions WHERE workspace_id=? AND dot_id=? ORDER BY created_at_ms DESC,rowid DESC LIMIT 1',
      projectId,
      this.dot,
    );
    return row ? this.view(row) : null;
  }
  private owned(projectId: string, sessionId: string) {
    this.h.owner();
    const row = this.host(projectId, sessionId);
    if (
      row.epoch !== this.h.epoch() ||
      !['prepared', 'starting', 'running', 'stopping'].includes(row.state) ||
      !this.one(
        'SELECT l.session_id FROM workspace_terminal_leases l JOIN workspaces w USING(workspace_id) WHERE l.session_id=? AND l.workspace_fence=? AND w.write_fence=l.workspace_fence AND l.runtime_epoch=?',
        sessionId,
        row.fence,
        row.epoch,
      )
    )
      return this.fail('STALE_TERMINAL_SESSION');
    return row;
  }
  open(q: OpenTerminal): { session: TerminalHostSession; created: boolean } {
    const context = this.h.context(q.projectId);
    return this.h.tx(() => {
      this.h.owner();
      const opened = this.h.open('terminal:' + q.commandKey, 'OPEN_USER_TERMINAL', {
        projectId: q.projectId,
        cols: q.cols,
        rows: q.rows,
      });
      if (!opened.created) {
        const previous =
          this.one(
            'SELECT session_id FROM terminal_sessions WHERE operation_id=?',
            opened.operationId,
          ) ?? this.fail('TERMINAL_RESULT_UNAVAILABLE');
        return { session: this.host(q.projectId, String(previous.session_id)), created: false };
      }
      this.h.available(q.projectId);
      if (
        this.one(
          "SELECT r.run_id FROM task_runs r JOIN tasks t USING(task_id) JOIN workspaces w ON w.workspace_id=t.workspace_id WHERE w.project_id=? AND r.status IN ('preparing','submitting','running','waiting_input','waiting_approval','outcome_unknown')",
          context.projectId,
        ) ||
        this.one(
          'SELECT l.run_id FROM workspace_write_leases l JOIN workspaces w USING(workspace_id) WHERE w.project_id=?',
          context.projectId,
        )
      )
        return this.fail('WORKSPACE_BUSY');
      if (
        Number(
          this.one(
            "SELECT COUNT(*) AS n FROM terminal_sessions WHERE dot_id=? AND state<>'exited'",
            this.dot,
          )!.n,
        ) >= 4
      )
        return this.fail('TERMINAL_ACTIVE_LIMIT');
      if (
        Number(
          this.one('SELECT COUNT(*) AS n FROM terminal_sessions WHERE dot_id=?', this.dot)!.n,
        ) >= 10000
      )
        return this.fail('TERMINAL_SESSION_LIMIT');
      this.exec(
        'UPDATE workspaces SET write_fence=write_fence+1 WHERE workspace_id=?',
        q.projectId,
      );
      const fence = Number(
          this.one('SELECT write_fence FROM workspaces WHERE workspace_id=?', q.projectId)!
            .write_fence,
        ),
        sessionId = randomUUID();
      this.exec(
        "INSERT INTO terminal_sessions(session_id,operation_id,dot_id,workspace_id,state,runtime_epoch,workspace_fence,cols,rows,created_at_ms) VALUES (?,?,?,?,'prepared',?,?,?,?,?)",
        sessionId,
        opened.operationId,
        this.dot,
        q.projectId,
        this.h.epoch(),
        fence,
        q.cols,
        q.rows,
        Date.now(),
      );
      this.exec(
        'INSERT INTO workspace_terminal_leases VALUES (?,?,?,?)',
        q.projectId,
        sessionId,
        this.h.epoch(),
        fence,
      );
      this.inputKeys.set(sessionId, randomBytes(32));
      return { session: this.host(q.projectId, sessionId), created: true };
    });
  }
  dispatch(projectId: string, sessionId: string, pid: number) {
    this.h.tx(() => {
      const row = this.owned(projectId, sessionId);
      if (row.state !== 'prepared' || !Number.isSafeInteger(pid) || pid < 2)
        return this.fail('STALE_TERMINAL_SESSION');
      this.exec(
        "UPDATE terminal_sessions SET state='starting',supervisor_pid=? WHERE session_id=?",
        pid,
        sessionId,
      );
      this.exec("UPDATE operations SET state='executing' WHERE operation_id=?", row.operationId);
    });
  }
  started(projectId: string, sessionId: string, pid: number) {
    this.h.tx(() => {
      const row = this.owned(projectId, sessionId);
      if (row.state !== 'starting' || !Number.isSafeInteger(pid) || pid < 2)
        return this.fail('STALE_TERMINAL_SESSION');
      this.exec(
        "UPDATE terminal_sessions SET state='running',pty_pid=? WHERE session_id=?",
        pid,
        sessionId,
      );
    });
  }
  input(q: WriteTerminal): { receipt: TerminalInputReceipt; created: boolean } {
    return this.h.tx(() => {
      this.h.owner();
      const row = this.host(q.projectId, q.sessionId),
        key = this.inputKeys.get(q.sessionId) ?? this.fail('TERMINAL_INPUT_OWNER_CHANGED'),
        digest = createHmac('sha256', key)
          .update(JSON.stringify([q.sessionId, q.sequence, q.text]))
          .digest('hex'),
        previous = this.one(
          'SELECT * FROM terminal_inputs WHERE session_id=? AND sequence=?',
          q.sessionId,
          q.sequence,
        );
      if (previous) {
        if (previous.input_hash !== digest) return this.fail('TERMINAL_INPUT_CONFLICT');
        return {
          receipt: { sequence: q.sequence, state: previous.state as TerminalInputReceipt['state'] },
          created: false,
        };
      }
      this.owned(q.projectId, q.sessionId);
      if (q.sequence <= row.lastInputSequence) return this.fail('TERMINAL_INPUT_EXPIRED');
      if (
        row.state !== 'running' ||
        q.sequence !== row.lastInputSequence + 1 ||
        q.sequence > 2147483647 ||
        row.lastInputState === 'sending' ||
        row.lastInputState === 'outcome_unknown'
      )
        return this.fail('TERMINAL_INPUT_NOT_READY');
      this.exec(
        "INSERT INTO terminal_inputs VALUES (?,?,?,?,'sending')",
        q.sessionId,
        q.sequence,
        digest,
        Buffer.byteLength(q.text),
      );
      this.exec(
        'UPDATE terminal_sessions SET last_input_sequence=? WHERE session_id=?',
        q.sequence,
        q.sessionId,
      );
      return { receipt: { sequence: q.sequence, state: 'sending' }, created: true };
    });
  }
  acceptInput(projectId: string, sessionId: string, sequence: number) {
    this.h.tx(() => {
      this.owned(projectId, sessionId);
      this.exec(
        "UPDATE terminal_inputs SET state='accepted' WHERE session_id=? AND sequence=? AND state='sending'",
        sessionId,
        sequence,
      );
      this.exec(
        "DELETE FROM terminal_inputs WHERE session_id=? AND sequence<? AND state='accepted'",
        sessionId,
        sequence - 999,
      );
    });
  }
  resize(projectId: string, sessionId: string, cols: number, rows: number) {
    this.h.tx(() => {
      this.owned(projectId, sessionId);
      this.exec(
        'UPDATE terminal_sessions SET cols=?,rows=? WHERE session_id=?',
        cols,
        rows,
        sessionId,
      );
    });
  }
  requestClose(projectId: string, sessionId: string, key: string): boolean {
    return this.h.tx(() => {
      this.h.owner();
      const row = this.host(projectId, sessionId),
        opened = this.h.open('terminal-close:' + key, 'STOP_USER_TERMINAL', {
          projectId,
          sessionId,
        });
      if (!opened.created || row.state === 'exited') {
        this.exec(
          "UPDATE operations SET state='completed',result_ref=? WHERE operation_id=?",
          'terminal:' + sessionId,
          opened.operationId,
        );
        return false;
      }
      this.owned(projectId, sessionId);
      this.exec("UPDATE terminal_sessions SET state='stopping' WHERE session_id=?", sessionId);
      this.exec(
        "UPDATE operations SET state='executing',result_ref=? WHERE operation_id=?",
        'terminal:' + sessionId,
        opened.operationId,
      );
      return true;
    });
  }
  finish(
    projectId: string,
    sessionId: string,
    code: number | null,
    errorCode?: string,
    reconciled = false,
  ) {
    this.h.tx(() => {
      this.h.owner();
      const row = this.host(projectId, sessionId);
      if (!reconciled) this.owned(projectId, sessionId);
      else if (row.state !== 'outcome_unknown') return this.fail('TERMINAL_NOT_UNKNOWN');
      this.exec(
        "UPDATE terminal_sessions SET state='exited',exit_code=?,error_code=? WHERE session_id=?",
        code,
        errorCode ?? null,
        sessionId,
      );
      this.exec(
        'UPDATE operations SET state=?,result_ref=? WHERE operation_id=?',
        errorCode ? 'failed' : 'completed',
        'terminal:' + sessionId,
        row.operationId,
      );
      this.exec(
        "UPDATE operations SET state=? WHERE kind='STOP_USER_TERMINAL' AND json_extract(input_json,'$.sessionId')=? AND state IN ('executing','outcome_unknown')",
        errorCode ? 'failed' : 'completed',
        sessionId,
      );
      this.exec('DELETE FROM workspace_terminal_leases WHERE session_id=?', sessionId);
      this.exec(
        "UPDATE terminal_inputs SET state='outcome_unknown' WHERE session_id=? AND state='sending'",
        sessionId,
      );
    });
  }
  unknown(projectId: string, sessionId: string, code: string) {
    this.h.tx(() => {
      const row = this.owned(projectId, sessionId);
      this.exec(
        "UPDATE terminal_sessions SET state='outcome_unknown',error_code=? WHERE session_id=?",
        code,
        sessionId,
      );
      this.exec(
        "UPDATE operations SET state='outcome_unknown' WHERE operation_id=? OR (kind='STOP_USER_TERMINAL' AND json_extract(input_json,'$.sessionId')=? AND state='executing')",
        row.operationId,
        sessionId,
      );
      this.exec(
        "UPDATE terminal_inputs SET state='outcome_unknown' WHERE session_id=? AND state='sending'",
        sessionId,
      );
    });
  }
}
