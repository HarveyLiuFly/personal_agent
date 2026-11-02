"""Read-only checks of design examples; no application behavior is asserted."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import sqlite3
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--protocol-dir', type=Path, help='Directory with stable/ and experimental/ generated protocol outputs')
args = parser.parse_args()
ROOT = Path(__file__).resolve().parents[3]
BASELINE = 'c67fbf8c6805b4586ad2288caecd3fcc96eb7cc1'
_baseline_files = tempfile.TemporaryDirectory(prefix='personal-agent-review-baseline-')
BASELINE_ROOT = Path(_baseline_files.name)
baseline_paths = subprocess.check_output(
    ['git', '-C', str(ROOT), 'ls-tree', '-r', '-z', '--name-only', BASELINE, 'docs/design'], text=True
).split('\0')
for name in baseline_paths:
    if not name:
        continue
    destination = BASELINE_ROOT / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(subprocess.check_output(['git', '-C', str(ROOT), 'show', f'{BASELINE}:{name}']))
DOCS = BASELINE_ROOT / 'docs/design'
MAIN = DOCS / 'Codex_Core_桌面Codex_Personal_Dot_技术方案与开发路线_v1.1.md'
CTX = DOCS / 'Dot_单一主对话与多任务上下文管理_子系统技术设计_v1.1.md'
PROTOCOL = args.protocol_dir
if PROTOCOL is not None and not PROTOCOL.is_dir():
    parser.error('--protocol-dir must contain the generated protocol outputs')


def sql_section(path, heading):
    text = path.read_text(encoding='utf-8')
    start = text.index(heading)
    return re.search(r'```sql\n(.*?)```', text[start:], re.S).group(1)


def fields(db, table):
    return [row[1] for row in db.execute(f'PRAGMA table_info({table})')]


def new_context_db():
    db = sqlite3.connect(':memory:')
    db.executescript(context_sql)
    db.execute("INSERT INTO dots VALUES ('d', 'local', '2026-11-02')")
    db.execute("INSERT INTO tasks(task_id,dot_id,title,status,created_at,updated_at) "
               "VALUES ('t','d','fixture','queued','2026-11-02','2026-11-02')")
    return db


main_sql = sql_section(MAIN, '### 9.4 建议的 SQLite Schema')
context_sql = sql_section(CTX, '### 13.3 核心 SQL Migration')
increment_sql = sql_section(MAIN, '### E. 建议的数据库迁移')
checks = []
main_db = sqlite3.connect(':memory:')
main_db.executescript(main_sql)
checks.append({'id': 'E01', 'observation': 'Main SQLite example initializes independently.'})
context_db = new_context_db()
checks.append({'id': 'E02', 'observation': 'Context SQLite example initializes independently.'})
try:
    main_db.executescript(context_sql)
except sqlite3.DatabaseError as exc:
    checks.append({'id': 'E03', 'observation': 'Concatenating the two examples is not a migration.',
                   'sqlite_error': str(exc)})
else:
    raise AssertionError('Expected incompatible schemas to require an explicit migration.')
try:
    context_db.execute("UPDATE tasks SET status='resuming' WHERE task_id='t'")
except sqlite3.IntegrityError as exc:
    checks.append({'id': 'E04', 'observation': 'Prose RESUMING state is not accepted by the context tasks CHECK.',
                   'sqlite_error': str(exc)})
else:
    raise AssertionError('Expected the documented state mismatch.')
db = new_context_db()
for run_id in ['r1', 'r2']:
    db.execute("INSERT INTO task_runs(run_id,task_id,trigger_id,task_snapshot_version,status,lease_owner,lease_epoch) "
               "VALUES (?,'t','same-trigger',1,'running',?,1)", (run_id, run_id))
checks.append({'id': 'E05', 'observation': 'Context schema alone permits two running rows for one task and trigger.',
               'rows': db.execute("SELECT COUNT(*) FROM task_runs WHERE task_id='t' AND status='running'").fetchone()[0],
               'limitation': 'This does not execute or disprove a future service-level claim transaction.'})
db = sqlite3.connect(':memory:')
db.executescript(main_sql)
db.executescript(increment_sql)
db.execute("INSERT INTO agent_assignments VALUES ('a','absent-task','codex',NULL,1,'fence','2099-01-01','running','2026-11-02')")
checks.append({'id': 'E06', 'observation': 'Incremental schema permits an assignment referencing a nonexistent task.',
               'foreign_keys_enabled': db.execute('PRAGMA foreign_keys').fetchone()[0]})
main_only = sqlite3.connect(':memory:')
main_only.executescript(main_sql)
checks.append({'id': 'E07', 'observation': 'Key columns diverge between the two examples.',
               'main': {t: fields(main_only, t) for t in ['tasks', 'task_runs', 'task_events']},
               'context': {t: fields(context_db, t) for t in ['tasks', 'task_runs', 'task_events']}})
deltas = [{'threadId': 'th', 'turnId': 'tu', 'itemId': 'it', 'delta': d} for d in ['a', 'a', 'b']]
seen = set()
output = ''
for delta in deltas:
    key = tuple(delta[k] for k in ['threadId', 'turnId', 'itemId'])
    if key not in seen:
        output += delta['delta']
        seen.add(key)
assert output == 'a'
checks.append({'id': 'E08', 'observation': 'Applying the documented item tuple as event deduplication loses legitimate deltas.',
               'expected_text': 'aab', 'observed_text': output,
               'limitation': 'This is a literal-rule simulation, not a test of application code.'})
if PROTOCOL is not None and PROTOCOL.exists():
    def content(kind, name):
        return (PROTOCOL / kind / name).read_text()
    assert 'developerInstructions?' in content('stable', 'v2/ThreadStartParams.ts')
    assert 'developerInstructions?' not in content('stable', 'v2/TurnStartParams.ts')
    assert 'dynamicTools?' not in content('stable', 'v2/ThreadStartParams.ts')
    assert 'dynamicTools?' in content('experimental', 'v2/ThreadStartParams.ts')
    assert 'supportedMethods' not in content('stable', 'InitializeResponse.ts')
    checks.append({'id': 'E09', 'observation': 'Local codex-cli 0.163.0 protocol generated in stable and experimental modes.',
                   'developerInstructions': ['thread/start', 'thread/resume'],
                   'developerInstructions_on_turn_start': False,
                   'dynamicTools_on_thread_start': 'experimental output only',
                   'initialize_response_supportedMethods': False,
                   'delta_fields': ['threadId', 'turnId', 'itemId', 'delta'],
                   'limitation': 'Generated types establish schema shape, not server behavior or model availability.'})
report = {
    'review_date': '2026-11-02',
    'repository_commit': BASELINE,
    'sqlite_version': sqlite3.sqlite_version,
    'source_documents': [{'path': str(p.relative_to(BASELINE_ROOT)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
                          'lines': len(p.read_text().splitlines())} for p in sorted(DOCS.glob('*.md'))],
    'checks': checks,
    'application_tests_executed': False,
}
print(json.dumps(report, ensure_ascii=False, indent=2))
