/** Historical migration fixtures derived from the one current schema, not a second design authority. */
export function legacySchema(current:string,revision:2|3|4):string {
 let sql=current.replace(/INSERT INTO schema_metadata VALUES \(1, \d+\)/,`INSERT INTO schema_metadata VALUES (1, ${revision})`);
 const tables=['worktree_operations','project_operation_leases','managed_worktrees'];
 if(revision<=3){sql=sql.replace(/^  actual_units INTEGER CHECK .*\n/m,'').replace(/^  settlement_hash TEXT,\n/m,'');tables.push('budget_policies','run_usage','thread_usage');if(revision===2)tables.push('runtime_requests');}
 for(const table of tables)sql=sql.replace(new RegExp(String.raw`CREATE TABLE ${table} \([\s\S]*?\n\);\n`),'');
 return sql;
}
