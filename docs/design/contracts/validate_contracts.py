"""Validate the current design contracts without starting an application or network call."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import sqlite3

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
DESIGN = HERE.parent
SQL = (HERE / 'schema.sql').read_text()
TYPES = (HERE / 'domain.ts').read_text()
results = []


def check(name, function):
    function()
    results.append({'check': name, 'status': 'passed'})


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def rejected(db, statement, args=()):
    try:
        db.execute(statement, args)
    except sqlite3.IntegrityError:
        return
    raise AssertionError(f'Expected a constraint rejection: {statement}')


def new_db():
    db = sqlite3.connect(':memory:')
    db.executescript(SQL)
    db.execute("INSERT INTO profiles VALUES ('p','local',0)")
    db.execute("INSERT INTO dots(dot_id,profile_id,display_name) VALUES ('d','p','dot')")
    db.execute("INSERT INTO dots(dot_id,profile_id,display_name) VALUES ('other','p','other')")
    db.execute("INSERT INTO conversations VALUES ('c','d')")
    for task in ['t', 't2']:
        add_task(db, task)
    return db


def add_task(db, task, dot='d', status='queued'):
    db.execute('INSERT INTO tasks(task_id,dot_id,title,status,created_at_ms,updated_at_ms) VALUES (?,?,?,?,0,0)',
               (task, dot, task, status))


def add_run(db, run='r', task='t', fence=1, dot='d', status='running'):
    db.execute('''INSERT INTO task_runs(
        run_id,task_id,dot_id,idempotency_key,executor_kind,status,task_snapshot_version,
        task_fence,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms
    ) VALUES (?,?,?,?,'codex',?,1,?,1,1,1,'worker',1000,0)''',
               (run, task, dot, run, status, fence))


def add_source_event(db, trigger='e', event='upstream-event'):
    db.execute("INSERT OR IGNORE INTO sources(source_id,dot_id,kind,identity_binding_ref,enabled) VALUES ('s','d','desktop','binding',1)")
    db.execute('''INSERT INTO incoming_triggers VALUES (?, 's','d',?,'thread','actor',
                  'verified','payload','hash',0,0)''', (trigger, event))


def add_action(db, action='a'):
    db.execute('''INSERT INTO actions(action_id,task_id,run_id,action_key,capability,
      canonical_payload_json,payload_hash,task_version,task_fence,policy_epoch,status)
      VALUES (?,'t','r',?,'test.send','{}','hash',1,1,1,'awaiting_approval')''', (action, action))


def check_initialization():
    db = new_db()
    require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'Foreign key inconsistency')
    require(db.execute('PRAGMA foreign_keys').fetchone()[0] == 1, 'Foreign keys disabled')
    tables = {x[0] for x in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    require(not {'tickets', 'assignments', 'agent_assignments'} & tables, 'Duplicate execution authority')


def check_enums():
    db = new_db()
    for variable, table, field in [('taskStatuses','tasks','status'),
                                  ('runStatuses','task_runs','status'),
                                  ('actionStatuses','actions','status')]:
        found = re.search(r'export const ' + variable + r' = (\[.*?\]) as const;', TYPES, re.S)
        values = set(json.loads(found.group(1)))
        ddl = db.execute('SELECT sql FROM sqlite_master WHERE name=?', (table,)).fetchone()[0]
        storage = re.search(r'\b' + field + r' TEXT NOT NULL CHECK \(' + field + r' IN \((.*?)\)\)', ddl, re.S)
        allowed = set(re.findall(r"'([^']+)'", storage.group(1)))
        require(values == allowed, f'{variable} disagrees with SQL: {values ^ allowed}')
    for index, status in enumerate(json.loads(re.search(r'taskStatuses = (\[.*?\]) as const;', TYPES, re.S).group(1))):
        add_task(db, f'state-{index}', status=status)
    rejected(db, "UPDATE tasks SET status='resuming' WHERE task_id='t'")


def check_transition_contract():
    states = set(json.loads(re.search(r'taskStatuses = (\[.*?\]) as const;', TYPES, re.S).group(1)))
    body = re.search(r'export const taskTransitions:.*?= \{(.*?)\n\};', TYPES, re.S).group(1)
    edges = {k: json.loads(v) for k, v in re.findall(r'^  (\w+): (\[[^\n]*\])', body, re.M)}
    require(set(edges) == states, 'Every Task state needs a transition entry')
    require(all(set(v) <= states for v in edges.values()), 'Unknown transition target')
    # A task is a conversation: an ended one reopens only by queueing a new turn.
    require(edges['completed'] == ['queued'] and edges['cancelled'] == ['queued'],
            'Ended Task states may only reopen through a new turn')
    require('queued' not in edges['outcome_unknown'], 'Unknown must not enter ordinary retry')


def check_run_uniqueness():
    db = new_db()
    add_run(db)
    rejected(db, "INSERT INTO task_runs SELECT 'r2',task_id,dot_id,origin_trigger_id,operation_id,'key2',executor_kind,status,task_snapshot_version,goal_plan_version,2,runtime_epoch,policy_epoch,privacy_epoch,worker_id,lease_until_ms,started_at_ms,finished_at_ms,result_ref FROM task_runs WHERE run_id='r'")
    db.execute("UPDATE task_runs SET status='completed' WHERE run_id='r'")
    try:
        add_run(db, 'duplicate-fence', fence=1)
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError('Task Fence must not be reused')
    add_run(db, 'r2', fence=2)


def check_orphan_and_scope():
    db = new_db()
    for task, dot in [('absent','d'),('t','other')]:
        try:
            add_run(db, 'invalid-' + task + dot, task=task, dot=dot)
        except sqlite3.IntegrityError:
            continue
        raise AssertionError('Orphan or cross-Dot Run accepted')
    db.execute("INSERT INTO messages(message_id,conversation_id,dot_id,role,content,content_hash,created_at_ms) VALUES ('m','c','d','user','x','h',0)")
    add_task(db, 'foreign-task', dot='other')
    rejected(db, "INSERT INTO message_task_links VALUES ('m','foreign-task','d','primary')")


def check_fence_cas():
    db = new_db()
    db.execute("UPDATE tasks SET write_fence=2 WHERE task_id='t'")
    count = db.execute("UPDATE tasks SET summary='stale' WHERE task_id='t' AND write_fence=1").rowcount
    require(count == 0, 'Stale Fence wrote state')
    require(db.execute("UPDATE tasks SET summary='current' WHERE task_id='t' AND write_fence=2").rowcount == 1,
            'Current Fence could not update')


def check_stop_admission():
    db = new_db()
    db.execute("UPDATE tasks SET dispatch_blocked=1,version=version+1 WHERE task_id='t'")
    claimed = db.execute("UPDATE tasks SET write_fence=write_fence+1,status='running' WHERE task_id='t' AND status='queued' AND dispatch_blocked=0").rowcount
    require(claimed == 0, 'A stop-requested Task was claimed before acknowledgment')
    rejected(db, "UPDATE tasks SET dispatch_blocked=2 WHERE task_id='t'")


def check_event_identity():
    db = new_db()
    add_run(db)
    db.execute("INSERT INTO task_events VALUES ('ev','t','r',1,1,'test',NULL,NULL,'{}',0)")
    rejected(db, "INSERT INTO task_events VALUES ('ev2','t','r',1,1,'test',NULL,NULL,'{}',0)")
    rejected(db, "INSERT INTO task_events VALUES ('ev3','t2','r',1,1,'test',NULL,NULL,'{}',0)")


def check_bindings_and_workspace():
    db = new_db()
    db.execute("INSERT INTO thread_bindings VALUES ('b','t','codex','th',1,1,'active',NULL)")
    rejected(db, "INSERT INTO thread_bindings VALUES ('b2','t','codex','th2',2,1,'active',NULL)")
    rejected(db, "INSERT INTO thread_bindings VALUES ('b3','t2','codex','th',1,1,'active',NULL)")
    db.execute("INSERT INTO projects VALUES ('proj','d','/fixture','fixture')")
    db.execute("INSERT INTO workspaces VALUES ('ws','proj','d','/fixture','main','ready',1)")
    add_run(db)
    add_run(db, 'r2', task='t2')
    db.execute("INSERT INTO workspace_write_leases VALUES ('ws','r',1,1000)")
    rejected(db, "INSERT INTO workspace_write_leases VALUES ('ws','r2',2,1000)")


def check_intent_ordering():
    db = new_db()
    add_run(db)
    rejected(db, "INSERT INTO execution_intents(intent_id,run_id,intent_key,kind,state,input_hash,created_at_ms) VALUES ('i','r','i','turn_start','prepared','h',0)")
    db.execute("INSERT INTO execution_intents(intent_id,run_id,intent_key,kind,state,input_hash,created_at_ms) VALUES ('i','r','i','thread_start','prepared','h',0)")
    rejected(db, "INSERT INTO execution_intents(intent_id,run_id,intent_key,kind,state,input_hash,created_at_ms) VALUES ('i2','r','i','thread_start','prepared','h',0)")


def check_operation_keys():
    db = new_db()
    db.execute("INSERT INTO messages(message_id,conversation_id,dot_id,role,content,content_hash,created_at_ms) VALUES ('m','c','d','user','x','h',0)")
    db.execute("INSERT INTO router_decisions VALUES ('dec','m','router','[]','{}',0)")
    db.execute("INSERT INTO operations VALUES ('op','dec',0,'t','QUERY_TASK','pending',1,'{}','h',NULL)")
    rejected(db, "INSERT INTO operations VALUES ('op2','dec',0,'t','QUERY_TASK','pending',1,'{}','h',NULL)")
    rejected(db, "INSERT INTO operation_dependencies VALUES ('op','op')")


def check_source_events():
    db = new_db()
    add_source_event(db)
    rejected(db, "UPDATE incoming_triggers SET actor_ref='forged' WHERE trigger_id='e'")
    try:
        add_source_event(db, 'e2')
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError('Duplicate source event accepted')
    db.execute("INSERT INTO trigger_deliveries VALUES ('del','e','t','d','context','pending',NULL)")
    rejected(db, "INSERT INTO trigger_deliveries VALUES ('del2','e','t','d','context','pending',NULL)")
    db.execute("INSERT INTO trigger_deliveries VALUES ('del3','e','t2','d','context','pending',NULL)")


def check_schedule_occurrences():
    db = new_db()
    db.execute("INSERT INTO schedules(schedule_id,task_id,kind,spec_json,timezone,state,misfire_policy,overlap_policy) VALUES ('sc','t','cron','{}','America/Vancouver','active','coalesce','coalesce')")
    db.execute("INSERT INTO schedule_occurrences VALUES ('oc','sc',1,1000,NULL,'pending')")
    rejected(db, "INSERT INTO schedule_occurrences VALUES ('oc2','sc',1,1000,NULL,'pending')")
    db.execute("UPDATE schedules SET version=2 WHERE schedule_id='sc'")
    count = db.execute("UPDATE schedule_occurrences SET state='enqueued' WHERE occurrence_id='oc' AND EXISTS (SELECT 1 FROM schedules s WHERE s.schedule_id=schedule_occurrences.schedule_id AND s.version=schedule_occurrences.schedule_version AND s.state='active')").rowcount
    require(count == 0, 'Stale schedule occurrence enqueued')
    db.execute("INSERT INTO schedule_occurrences VALUES ('oc-new','sc',2,1000,NULL,'pending')")


def check_receipt_consumption():
    db = new_db()
    add_run(db)
    add_action(db)
    add_action(db, 'a2')
    db.execute("INSERT INTO approval_receipts VALUES ('receipt','a','hash','user',1000,1,'granted')")
    db.execute("UPDATE actions SET approval_receipt_id='receipt' WHERE action_id='a'")
    rejected(db, "UPDATE actions SET approval_receipt_id='receipt' WHERE action_id='a2'")
    sql = "UPDATE approval_receipts SET uses_remaining=0,state='consumed' WHERE receipt_id='receipt' AND action_id='a' AND approved_payload_hash='hash' AND state='granted' AND uses_remaining=1 AND expires_at_ms>0"
    require(db.execute(sql).rowcount == 1, 'First receipt consumption failed')
    require(db.execute(sql).rowcount == 0, 'Receipt consumed twice')
    rejected(db, "UPDATE approval_receipts SET uses_remaining=1 WHERE receipt_id='receipt'")


def check_budget_admission():
    db = new_db()
    db.execute("INSERT INTO budget_buckets VALUES ('bucket','d',NULL,'tokens',0,1000,100,0,0)")
    sql = "UPDATE budget_buckets SET reserved_units=reserved_units+? WHERE bucket_id='bucket' AND limit_units-consumed_units-reserved_units>=?"
    require(db.execute(sql, (60, 60)).rowcount == 1, 'First reservation failed')
    require(db.execute(sql, (60, 60)).rowcount == 0, 'Budget allocated twice')
    db.execute("UPDATE budget_buckets SET reserved_units=0,consumed_units=120 WHERE bucket_id='bucket'")
    require(db.execute(sql, (1, 1)).rowcount == 0, 'Overspent bucket admits new work')
    require(db.execute("SELECT consumed_units FROM budget_buckets").fetchone()[0] == 120, 'Real overrun was lost')


def check_privacy_marker():
    db = new_db()
    db.execute("UPDATE dots SET privacy_epoch=privacy_epoch+1 WHERE dot_id='d'")
    db.execute("INSERT INTO privacy_tombstones VALUES ('d','source:deleted',2,0)")
    db.execute("INSERT INTO derivation_edges VALUES ('d','source:deleted','episode:x','rev',1)")
    count = db.execute("SELECT COUNT(*) FROM derivation_edges e JOIN privacy_tombstones t ON t.dot_id=e.dot_id AND t.source_ref=e.source_ref WHERE e.privacy_epoch<t.privacy_epoch").fetchone()[0]
    require(count == 1, 'Invalidated derivation cannot be found')


def check_document_and_matrix():
    files = sorted(DESIGN.glob('*.md'))
    overview = DESIGN / '00_总体架构与开发规划.md'
    require(overview in files and len(files) > 1, 'Overview and technical documents are required')
    text = overview.read_text()
    indexed = set()
    for link in re.findall(r'\]\(([^)]+)\)', text):
        if not link.startswith(('https://','http://','#')) and Path(link.split('#')[0]).suffix == '.md':
            indexed.add((DESIGN / link.split('#')[0]).resolve())
    require(indexed == {p.resolve() for p in files}, 'Overview must index every current design document')
    for document in files:
        body = document.read_text()
        for link in re.findall(r'\]\(([^)]+)\)', body):
            if link.startswith(('https://','http://','#')):
                continue
            require((document.parent / link.split('#')[0]).is_file(), f'Broken design link: {link}')
        require('v1.0' not in body and 'v1.1' not in body and '增量修订' not in body, 'Historical overlays remain')
        if document != overview:
            require('适用阶段：' in body and '对应工作包' in body and '开发验证要求' in body,
                    f'Technical document lacks stage, package or verification requirements: {document.name}')
            require('真实开发时' in body and '并行' in body,
                    f'Case refinement must be planned alongside development: {document.name}')
    package_ids = re.findall(r'\| M[^|]* / ([A-Z]+-\d+) \|', text)
    require(len(package_ids) == len(set(package_ids)), 'Repeated milestone package ID')
    matrix = json.loads((HERE / 'protocol-capabilities.json').read_text())
    lock = json.loads((ROOT / matrix['binary_lock']).read_text())
    require(lock['cliVersion'] == matrix['cli_version'], 'Binary lock and matrix versions differ')
    require('linux-x64' in lock['platforms'], 'Original Linux binary baseline lost')
    for pin in lock['platforms'].values():
        require(re.fullmatch(r'[0-9a-f]{64}', pin['executableSha256']) is not None, 'Invalid binary pin')
        require((ROOT / pin['protocolEvidence']).is_file(), 'Missing platform protocol evidence')
    for platform, path in matrix.get('platform_schema_evidence', {}).items():
        evidence = json.loads((ROOT / path).read_text())
        require(evidence['status'] == 'passed' and evidence['platform'] == platform, 'Platform schema not verified')
        require(evidence['cliVersion'] == lock['cliVersion'], 'Platform CLI version differs')
        require(evidence['executableSha256'] == lock['platforms'][platform]['executableSha256'], 'Platform binary differs')
        require(evidence['schemaFingerprint'] == lock['schemaFingerprint'], 'Platform schema differs')
    for platform, paths in matrix.get('platform_runtime_evidence', {}).items():
        require(platform in lock['platforms'], 'Runtime platform is not pinned')
        for path in paths:
            evidence = json.loads((ROOT / path).read_text())
            require(evidence['status'] == 'passed' and evidence['platform'] == platform, 'Platform runtime did not pass')
            require(evidence['cliVersion'] == lock['cliVersion'], 'Platform runtime CLI differs')
            require(bool(evidence.get('verifiedMethods')), 'Platform runtime has no verified methods')
    require(all(x['schema_observed'] for x in matrix['methods'] if x['requirement']=='required'), 'Required schema is unavailable')
    for method in matrix['methods']:
        status = method['runtime_verification']
        require(status in ('pending', 'passed'), 'Unknown runtime verification status')
        if status == 'passed':
            evidence_path = ROOT / method.get('runtime_evidence', '')
            require(evidence_path.is_file(), f'Missing runtime evidence: {method["method"]}')
            evidence = json.loads(evidence_path.read_text())
            require(evidence.get('status') == 'passed', 'Runtime evidence did not pass')
            require(evidence.get('cliVersion') == matrix['cli_version'], 'Runtime evidence uses another CLI')
            require(method['method'] in evidence.get('verifiedMethods', []),
                    f'Method not covered by runtime evidence: {method["method"]}')
    require(len({x['method'] for x in matrix['methods']}) == len(matrix['methods']), 'Duplicate RPC matrix entry')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='Print machine-readable results')
    args = parser.parse_args()
    for name, fn in [
        ('single_schema_initialization_and_foreign_keys',check_initialization),
        ('sql_typescript_status_consistency',check_enums),
        ('task_transition_guards_shape',check_transition_contract),
        ('single_active_run_and_nonreused_fence',check_run_uniqueness),
        ('orphan_and_cross_dot_references_rejected',check_orphan_and_scope),
        ('stale_fence_cas_rejected',check_fence_cas),
        ('stop_requested_task_blocks_new_claims',check_stop_admission),
        ('task_event_sequence_and_run_scope',check_event_identity),
        ('active_thread_and_workspace_writer_uniqueness',check_bindings_and_workspace),
        ('intent_ordering_and_idempotency',check_intent_ordering),
        ('per_operation_identity_and_dependency',check_operation_keys),
        ('immutable_source_and_per_task_delivery',check_source_events),
        ('occurrence_dedup_and_schedule_version_guard',check_schedule_occurrences),
        ('single_use_hash_bound_action_receipt',check_receipt_consumption),
        ('budget_admission_and_actual_overrun_accounting',check_budget_admission),
        ('privacy_tombstone_dependency_lookup',check_privacy_marker),
        ('stage_document_navigation_requirements_and_protocol_evidence',check_document_and_matrix),
    ]:
        check(name, fn)
    report = {
        'scope': 'Design SQL constraints, DTO consistency and documented conditional statements only.',
        'sqlite_version': sqlite3.sqlite_version,
        'checks': results,
        'passed': len(results),
        'application_e2e_executed': False,
        'runtime_security_verified': False,
        'files': [{'path': str(p.relative_to(ROOT)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                  for p in sorted(DESIGN.glob('*.md')) + [HERE/'schema.sql', HERE/'domain.ts', HERE/'protocol-capabilities.json', HERE/'validate_contracts.py']],
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for item in results:
            print('PASS', item['check'])
        print(f'{len(results)} design checks passed. Application E2E and runtime security are not verified.')


if __name__ == '__main__':
    main()
