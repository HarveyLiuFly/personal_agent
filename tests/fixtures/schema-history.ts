/** Turns a live revision 8 ledger back into revision 7: no conversation columns or indexes. */
export const DOWNGRADE_TO_REVISION_7 = `
  DROP INDEX tasks_by_workspace_activity;
  DROP INDEX task_runs_by_task;
  ALTER TABLE tasks DROP COLUMN model;
  ALTER TABLE tasks DROP COLUMN reasoning_effort;
  ALTER TABLE tasks DROP COLUMN permission_mode;
  ALTER TABLE tasks DROP COLUMN pinned_at_ms;
  ALTER TABLE tasks DROP COLUMN archived_at_ms;
  ALTER TABLE tasks DROP COLUMN last_read_at_ms;
  UPDATE schema_metadata SET schema_revision=7;`;

/** Historical migration fixtures derived from the one current schema, not a second design authority. */
export function legacySchema(current: string, revision: 2 | 3 | 4 | 5 | 6 | 7): string {
  let sql = current
    .replace(
      /INSERT INTO schema_metadata VALUES \(1, \d+\)/,
      `INSERT INTO schema_metadata VALUES (1, ${revision})`,
    )
    // Revision 8 added the conversation columns and indexes.
    .replace(/^  -- A task is a conversation \(revision 8\)[\s\S]*?last_read_at_ms INTEGER,\n/m, '')
    .replace(/^CREATE INDEX (tasks_by_workspace_activity|task_runs_by_task) .*\n/gm, '');
  if (revision >= 6) return sql;
  const tables = ['terminal_sessions', 'workspace_terminal_leases', 'terminal_inputs'];
  if (revision <= 4)
    tables.push('worktree_operations', 'project_operation_leases', 'managed_worktrees');
  if (revision <= 3) {
    sql = sql
      .replace(/^  actual_units INTEGER CHECK .*\n/m, '')
      .replace(/^  settlement_hash TEXT,\n/m, '');
    tables.push('budget_policies', 'run_usage', 'thread_usage');
    if (revision === 2) tables.push('runtime_requests');
  }
  for (const table of tables)
    sql = sql.replace(new RegExp(String.raw`CREATE TABLE ${table} \([\s\S]*?\n\);\n`), '');
  return sql;
}
