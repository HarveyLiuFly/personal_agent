import type { DatabaseSync } from 'node:sqlite';
import type {
  ConversationChoices,
  ConversationGroup,
  ConversationPage,
  ConversationSummary,
  PermissionMode,
} from '../../contracts/src/conversations.ts';

type Row = Record<string, string | number | null>;
const active =
  "('preparing','submitting','running','waiting_input','waiting_approval','outcome_unknown')";
const PAGE = 30;
/** Conversations per project shown in the sidebar before "more". */
const GROUP = 8;
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\x00-\x1f]/.test(value);
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
/** Checks conversation choices from the Renderer (shape only; the catalog decides at run time). */
export function validChoices(
  input: Record<string, unknown>,
  fail: (code: string) => never,
): ConversationChoices {
  const invalid = (): never => fail('INVALID_CONVERSATION_CHOICES');
  const out: ConversationChoices = {};
  if (input.permissionMode !== undefined) {
    if (!['readOnly', 'auto', 'fullAccess'].includes(String(input.permissionMode))) invalid();
    out.permissionMode = input.permissionMode as PermissionMode;
  }
  if (input.model !== undefined) {
    if (input.model !== null && (!id(input.model) || !/^[\w.:/-]+$/.test(input.model))) invalid();
    out.model = input.model as string | null;
  }
  if (input.effort !== undefined) {
    if (input.effort !== null && !efforts.has(String(input.effort))) invalid();
    out.effort = input.effort as string | null;
  }
  return out;
}
/** Keyset handle `<time>.<rowid>`; it carries no data beyond the list position. */
export function decodeCursor(
  value: unknown,
  fail: (code: string) => never,
): { at: number; row: number } | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{1,16}\.\d{1,16}$/.test(value))
    return fail('INVALID_CONVERSATION_CURSOR');
  const [at, row] = value.split('.').map(Number);
  return { at: at!, row: row! };
}
/** Visible conversations: user tasks of this Dot, not assistant-internal, not forgotten. */
const visible =
  "t.dot_id=? AND json_extract(t.constraints_json,'$.internalRole') IS NULL AND NOT EXISTS(SELECT 1 FROM privacy_tombstones p WHERE p.dot_id=t.dot_id AND p.source_ref IN (t.task_id,'task:'||t.task_id))";

/** Private collaborator of ExecutionLedger: the conversation list and its per-user state. */
export class ConversationLedger {
  private db: DatabaseSync;
  private dot: string;
  private fail: (code: string) => never;
  private host: {
    workspace: (projectId: string) => unknown;
    owner: () => void;
    tx: <T>(work: () => T) => T;
  };
  constructor(
    db: DatabaseSync,
    dot: string,
    fail: (code: string) => never,
    host: ConversationLedger['host'],
  ) {
    this.db = db;
    this.dot = dot;
    this.fail = fail;
    this.host = host;
  }
  private one(sql: string, ...args: Array<string | number | null>): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: Array<string | number | null>): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private summary(row: Row): ConversationSummary {
    const taskId = String(row.task_id),
      latest = this.one(
        'SELECT run_id,status,finished_at_ms FROM task_runs WHERE task_id=? ORDER BY started_at_ms DESC,rowid DESC LIMIT 1',
        taskId,
      ),
      running = this.one(
        `SELECT run_id,status FROM task_runs WHERE task_id=? AND status IN ${active}`,
        taskId,
      ),
      turns = Number(this.one('SELECT count(*) AS n FROM task_runs WHERE task_id=?', taskId)!.n),
      binding = this.one(
        "SELECT execution_thread_id FROM thread_bindings WHERE task_id=? AND state='active'",
        taskId,
      );
    const ended =
      latest &&
      ['completed', 'failed', 'cancelled'].includes(String(latest.status)) &&
      Number(latest.finished_at_ms ?? 0) > Number(row.last_read_at_ms ?? 0);
    return {
      projectId: String(row.workspace_id),
      conversationId: taskId,
      title: String(row.title),
      status: row.status as ConversationSummary['status'],
      version: Number(row.version),
      mode:
        JSON.parse(String(row.constraints_json)).mode === 'workspaceWrite'
          ? 'workspaceWrite'
          : 'readOnly',
      permissionMode: row.permission_mode as PermissionMode,
      model: (row.model as string | null) ?? null,
      effort: (row.reasoning_effort as string | null) ?? null,
      pinned: row.pinned_at_ms !== null,
      archived: row.archived_at_ms !== null,
      unread: Boolean(ended),
      attention:
        running?.status === 'waiting_approval'
          ? 'approval'
          : running?.status === 'waiting_input'
            ? 'input'
            : running?.status === 'outcome_unknown'
              ? 'unknown'
              : null,
      activeRunId: (running?.run_id as string | undefined) ?? null,
      latestRunId: (latest?.run_id as string | undefined) ?? null,
      threadId: (binding?.execution_thread_id as string | undefined) ?? null,
      turns,
      blocked: row.dispatch_blocked === 1,
      forkedFrom:
        (JSON.parse(String(row.constraints_json)).forkOf?.conversationId as string | undefined) ??
        null,
      updatedAt: Number(row.updated_at_ms),
    };
  }
  private query(input: unknown, keys: string[]): Record<string, unknown> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !keys.includes(key)) ||
      !id((input as { projectId?: unknown }).projectId)
    )
      return this.fail('INVALID_CONVERSATION_QUERY');
    return input as Record<string, unknown>;
  }
  /**
   * One page of a project's conversations, most recently active first (pinned ones lead the first
   * page). Archived ones are listed only on request. Positions use a keyset handle, so a long list
   * never depends on a "latest N" window.
   */
  list(input: unknown): ConversationPage {
    const q = this.query(input, ['projectId', 'cursor', 'archived', 'query']);
    const filter = this.filter(q);
    this.host.workspace(String(q.projectId));
    return this.page(String(q.projectId), filter, decodeCursor(q.cursor, this.fail), PAGE);
  }
  /**
   * The sidebar: every project's pinned conversations and its few most recent ones, in one read.
   * `nextCursor` continues a project's list through `list`.
   */
  groups(input: unknown): ConversationGroup[] {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['archived', 'query'].includes(key))
    )
      return this.fail('INVALID_CONVERSATION_QUERY');
    const filter = this.filter(input as Record<string, unknown>);
    return this.all(
      "SELECT workspace_id FROM workspaces WHERE dot_id=? AND state<>'archived' ORDER BY rowid LIMIT 100",
      this.dot,
    ).map((row) => ({
      projectId: String(row.workspace_id),
      ...this.page(String(row.workspace_id), filter, null, GROUP),
    }));
  }
  private filter(q: Record<string, unknown>): { archived: number; text: string | null } {
    if (q.archived !== undefined && typeof q.archived !== 'boolean')
      return this.fail('INVALID_CONVERSATION_QUERY');
    if (q.query !== undefined && (typeof q.query !== 'string' || q.query.length > 200))
      return this.fail('INVALID_CONVERSATION_QUERY');
    return {
      archived: q.archived === true ? 1 : 0,
      text: typeof q.query === 'string' && q.query.trim() ? q.query.trim() : null,
    };
  }
  private page(
    projectId: string,
    { archived, text }: { archived: number; text: string | null },
    cursor: { at: number; row: number } | null,
    size: number,
  ): ConversationPage {
    // Search covers the title and the first message; later messages live only in Codex.
    const filter = `t.workspace_id=? AND ${visible} AND (t.archived_at_ms IS NOT NULL)=? AND (? IS NULL OR instr(lower(t.title),lower(?))>0 OR instr(lower(COALESCE(json_extract(t.constraints_json,'$.text'),'')),lower(?))>0)`,
      args = [projectId, this.dot, archived, text, text, text];
    const pinned =
      cursor || archived
        ? []
        : this.all(
            `SELECT t.* FROM tasks t WHERE ${filter} AND t.pinned_at_ms IS NOT NULL ORDER BY t.pinned_at_ms DESC,t.rowid DESC LIMIT 50`,
            ...args,
          );
    const rows = this.all(
      `SELECT t.*,t.rowid AS row_id FROM tasks t WHERE ${filter} AND (t.pinned_at_ms IS NULL OR ?=1) AND (? IS NULL OR t.updated_at_ms<? OR (t.updated_at_ms=? AND t.rowid<?)) ORDER BY t.updated_at_ms DESC,t.rowid DESC LIMIT ?`,
      ...args,
      archived,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.row ?? null,
      size + 1,
    );
    const page = rows.slice(0, size),
      last = page.at(-1);
    return {
      pinned: pinned.map((row) => this.summary(row)),
      items: page.map((row) => this.summary(row)),
      nextCursor: rows.length > size && last ? `${last.updated_at_ms}.${last.row_id}` : null,
    };
  }
  /** One conversation by ID, wherever it sits in the list. */
  get(input: unknown): ConversationSummary {
    const q = this.query(input, ['projectId', 'conversationId']);
    if (!id(q.conversationId)) return this.fail('INVALID_CONVERSATION_QUERY');
    this.host.workspace(String(q.projectId));
    return this.summary(this.row(String(q.projectId), String(q.conversationId)));
  }
  /** The visible task row of a conversation in this project. */
  row(projectId: string, conversationId: string): Row {
    return (
      this.one(
        `SELECT t.* FROM tasks t WHERE t.task_id=? AND t.workspace_id=? AND ${visible}`,
        conversationId,
        projectId,
        this.dot,
      ) ?? this.fail('CONVERSATION_NOT_FOUND')
    );
  }
  /**
   * Checks an archive change before Codex is asked: the conversation is visible and has no turn
   * running or awaiting a check. Returns its bound thread (if any) for the Codex side.
   */
  archiveCheck(input: unknown): {
    projectId: string;
    conversationId: string;
    archived: boolean;
    threadId: string | null;
  } {
    const q = this.query(input, ['projectId', 'conversationId', 'archived']);
    if (!id(q.conversationId) || typeof q.archived !== 'boolean')
      return this.fail('INVALID_CONVERSATION_UPDATE');
    const projectId = String(q.projectId),
      conversationId = String(q.conversationId);
    this.host.workspace(projectId);
    this.row(projectId, conversationId);
    if (
      this.one(
        `SELECT run_id FROM task_runs WHERE task_id=? AND status IN ${active}`,
        conversationId,
      )
    )
      return this.fail('CONVERSATION_RUNNING');
    const binding = this.one(
      "SELECT execution_thread_id FROM thread_bindings WHERE task_id=? AND state='active'",
      conversationId,
    );
    return {
      projectId,
      conversationId,
      archived: q.archived,
      threadId: (binding?.execution_thread_id as string | undefined) ?? null,
    };
  }
  /** Archives (and unpins) or restores a conversation after `archiveCheck`. */
  setArchived(projectId: string, conversationId: string, archived: boolean): ConversationSummary {
    return this.host.tx(() => {
      this.host.owner();
      this.row(projectId, conversationId);
      if (
        this.one(
          `SELECT run_id FROM task_runs WHERE task_id=? AND status IN ${active}`,
          conversationId,
        )
      )
        return this.fail('CONVERSATION_RUNNING');
      if (archived)
        this.db
          .prepare(
            'UPDATE tasks SET archived_at_ms=coalesce(archived_at_ms,?),pinned_at_ms=NULL WHERE task_id=?',
          )
          .run(Date.now(), conversationId);
      else
        this.db.prepare('UPDATE tasks SET archived_at_ms=NULL WHERE task_id=?').run(conversationId);
      return this.summary(this.row(projectId, conversationId));
    });
  }
  /** Pins/unpins or marks read. Neither changes the conversation's activity order or version. */
  update(input: unknown): ConversationSummary {
    const q = this.query(input, [
      'projectId',
      'conversationId',
      'pinned',
      'read',
      'permissionMode',
      'model',
      'effort',
    ]);
    if (
      !id(q.conversationId) ||
      (q.pinned !== undefined && typeof q.pinned !== 'boolean') ||
      (q.read !== undefined && q.read !== true) ||
      ['pinned', 'read', 'permissionMode', 'model', 'effort'].every((key) => q[key] === undefined)
    )
      return this.fail('INVALID_CONVERSATION_UPDATE');
    const choices = validChoices(q, this.fail);
    const projectId = String(q.projectId),
      conversationId = String(q.conversationId);
    this.host.workspace(projectId);
    return this.host.tx(() => {
      this.host.owner();
      const row = this.row(projectId, conversationId),
        now = Date.now();
      if (q.pinned !== undefined) {
        if (q.pinned && row.archived_at_ms !== null) return this.fail('CONVERSATION_ARCHIVED');
        this.db
          .prepare('UPDATE tasks SET pinned_at_ms=? WHERE task_id=?')
          .run(q.pinned ? (row.pinned_at_ms ?? now) : null, conversationId);
      }
      if (q.read)
        this.db
          .prepare('UPDATE tasks SET last_read_at_ms=? WHERE task_id=?')
          .run(now, conversationId);
      // Choices apply from the next turn. A code task keeps its write contract.
      if (choices.permissionMode !== undefined) {
        if (JSON.parse(String(row.constraints_json)).code && choices.permissionMode !== 'auto')
          return this.fail('CODE_TASK_PERMISSION_FIXED');
        this.db
          .prepare('UPDATE tasks SET permission_mode=? WHERE task_id=?')
          .run(choices.permissionMode, conversationId);
      }
      if (choices.model !== undefined)
        this.db
          .prepare('UPDATE tasks SET model=? WHERE task_id=?')
          .run(choices.model, conversationId);
      if (choices.effort !== undefined)
        this.db
          .prepare('UPDATE tasks SET reasoning_effort=? WHERE task_id=?')
          .run(choices.effort, conversationId);
      return this.summary(this.row(projectId, conversationId));
    });
  }
}
