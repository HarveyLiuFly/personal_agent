/** Historical migration fixtures derived from the one current schema, not a second design authority. */
export function legacySchema(current:string,revision:2|3):string {
 let sql=current.replace('INSERT INTO schema_metadata VALUES (1, 4)',`INSERT INTO schema_metadata VALUES (1, ${revision})`)
  .replace(/^  actual_units INTEGER CHECK .*\n/m,'').replace(/^  settlement_hash TEXT,\n/m,'');
 for(const table of ['budget_policies','run_usage','thread_usage',...(revision===2?['runtime_requests']:[])])sql=sql.replace(new RegExp('CREATE TABLE '+table+' \\([\\s\\S]*?\\n\\);\\n'),'');
 return sql;
}
