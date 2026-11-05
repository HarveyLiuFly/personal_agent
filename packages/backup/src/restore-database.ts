import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LedgerError } from '../../store/src/ledger.ts';
import { prepareRehearsalDatabase } from './rehearsal-database.ts';
import type { RehearsalDatabaseSummary, RehearsalWatermarks } from './rehearsal-database.ts';

export interface RestoreDatabaseSummary extends RehearsalDatabaseSummary {
  mergedBudgetBuckets: number;
}
type Row = Record<string, string | number | null>;
interface State {
  watermarks: RehearsalWatermarks;
  policy: Row;
  buckets: Row[];
  usage: Row[];
  threads: Row[];
  runs: Map<string, Row>;
  goals: Set<string>;
}
function fail(code: string): never {
  throw new LedgerError(code);
}
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < Number.MAX_SAFE_INTEGER;
const nullableInteger = (v: unknown) => v === null || integer(v);
const reference = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f]/.test(v);
function rows(db: DatabaseSync, sql: string): Row[] {
  const result = db.prepare(sql + ' LIMIT 10001').all() as Row[];
  if (result.length > 10000) fail('RESTORE_ACCOUNTING_LIMIT');
  return result;
}
function validate(db: DatabaseSync): State {
  db.exec(
    'PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;',
  );
  if (
    db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length
  )
    fail('RESTORE_DATABASE_INVALID');
  if (db.prepare("SELECT name FROM sqlite_master WHERE name='recovery_quarantine'").get())
    fail('RESTORE_QUARANTINED_DATABASE');
  if (
    db.prepare('SELECT schema_revision FROM schema_metadata WHERE singleton=1').get()
      ?.schema_revision !== 6
  )
    fail('RESTORE_SCHEMA_UNSUPPORTED');
  const profiles = rows(db, 'SELECT * FROM profiles'),
    dots = rows(db, 'SELECT * FROM dots'),
    owners = rows(db, 'SELECT * FROM runtime_owners');
  if (
    profiles.length !== 1 ||
    profiles[0]!.profile_id !== 'local-profile' ||
    dots.length !== 1 ||
    dots[0]!.dot_id !== 'local-dot' ||
    dots[0]!.profile_id !== 'local-profile' ||
    owners.length !== 1 ||
    owners[0]!.profile_id !== 'local-profile'
  )
    fail('RESTORE_SCOPE_MISMATCH');
  const pending = [
    "SELECT count(*) AS n FROM task_runs WHERE status NOT IN ('completed','failed','cancelled')",
    "SELECT count(*) AS n FROM actions WHERE status NOT IN ('succeeded','failed','rejected','cancelled')",
    "SELECT count(*) AS n FROM execution_intents WHERE state IN ('prepared','sending','outcome_unknown')",
    "SELECT count(*) AS n FROM runtime_requests WHERE state IN ('pending','responding','outcome_unknown')",
    "SELECT count(*) AS n FROM pending_interactions WHERE state='pending'",
    "SELECT count(*) AS n FROM approval_receipts WHERE state='granted'",
    "SELECT count(*) AS n FROM terminal_sessions WHERE state<>'exited'",
    "SELECT count(*) AS n FROM terminal_inputs WHERE state IN ('sending','outcome_unknown')",
    "SELECT count(*) AS n FROM worktree_operations WHERE state NOT IN ('completed','failed')",
    "SELECT count(*) AS n FROM operations WHERE state IN ('executing','outcome_unknown')",
    'SELECT count(*) AS n FROM workspace_write_leases',
    'SELECT count(*) AS n FROM project_operation_leases',
    'SELECT count(*) AS n FROM workspace_terminal_leases',
    "SELECT count(*) AS n FROM computer_sessions WHERE state NOT IN ('closed','failed')",
  ];
  if (pending.some((sql) => Number(db.prepare(sql).get()!.n) !== 0))
    fail('RESTORE_UNRESOLVED_EXECUTION');
  if (
    Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM budget_reservations WHERE state<>'settled' OR actual_units IS NULL",
        )
        .get()!.n,
    ) > 0 ||
    Number(
      db.prepare('SELECT count(*) AS n FROM budget_buckets WHERE reserved_units<>0').get()!.n,
    ) > 0
  )
    fail('RESTORE_UNRESOLVED_BUDGET');
  const policies = rows(db, "SELECT * FROM budget_policies WHERE dot_id='local-dot'");
  if (policies.length !== 1) fail('RESTORE_ACCOUNTING_INVALID');
  const policy = policies[0]!;
  if (
    !integer(policy.daily_token_limit) ||
    Number(policy.daily_token_limit) < 1 ||
    Number(policy.daily_token_limit) > 1e12 ||
    !integer(policy.reservation_tokens) ||
    Number(policy.reservation_tokens) < 1 ||
    Number(policy.reservation_tokens) > Number(policy.daily_token_limit) ||
    policy.max_active_runs !== 1
  )
    fail('RESTORE_ACCOUNTING_INVALID');
  const buckets = rows(db, "SELECT * FROM budget_buckets WHERE dot_id='local-dot'");
  for (const b of buckets)
    if (
      !reference(b.bucket_id) ||
      (b.goal_id !== null && !reference(b.goal_id)) ||
      !['tokens', 'estimated_micro_usd'].includes(String(b.unit)) ||
      !Number.isSafeInteger(b.period_start_ms) ||
      !Number.isSafeInteger(b.period_end_ms) ||
      Number(b.period_end_ms) <= Number(b.period_start_ms) ||
      !integer(b.limit_units) ||
      !integer(b.consumed_units) ||
      b.reserved_units !== 0
    )
      fail('RESTORE_ACCOUNTING_INVALID');
  const usage = rows(db, 'SELECT * FROM run_usage'),
    threads = rows(db, 'SELECT * FROM thread_usage');
  for (const u of usage)
    if (
      !reference(u.run_id) ||
      (u.thread_id !== null && !reference(u.thread_id)) ||
      !nullableInteger(u.baseline_tokens) ||
      !nullableInteger(u.latest_total_tokens) ||
      u.invalid_count !== 0 ||
      u.finalized !== 1 ||
      !integer(u.updated_at_ms)
    )
      fail('RESTORE_USAGE_UNKNOWN');
  for (const u of threads)
    if (
      !reference(u.thread_id) ||
      u.dot_id !== 'local-dot' ||
      !reference(u.last_run_id) ||
      !nullableInteger(u.total_tokens) ||
      !integer(u.updated_at_ms)
    )
      fail('RESTORE_ACCOUNTING_INVALID');
  const tombstones = rows(
    db,
    "SELECT source_ref,privacy_epoch,deleted_at_ms FROM privacy_tombstones WHERE dot_id='local-dot'",
  );
  return {
    watermarks: {
      profileId: 'local-profile',
      dotId: 'local-dot',
      runtimeEpoch: Number(owners[0]!.runtime_epoch),
      policyEpoch: Number(dots[0]!.policy_epoch),
      privacyEpoch: Number(dots[0]!.privacy_epoch),
      tombstones: tombstones.map((t) => ({
        sourceRef: String(t.source_ref),
        privacyEpoch: Number(t.privacy_epoch),
        deletedAtMs: Number(t.deleted_at_ms),
      })),
    },
    policy,
    buckets,
    usage,
    threads,
    runs: new Map(
      rows(
        db,
        'SELECT run_id,task_id,dot_id,idempotency_key,executor_kind,task_fence FROM task_runs',
      ).map((r) => [String(r.run_id), r]),
    ),
    goals: new Set(rows(db, 'SELECT goal_id FROM goals').map((g) => String(g.goal_id))),
  };
}
const scope = (b: Row) =>
  JSON.stringify([b.dot_id, b.goal_id, b.unit, b.period_start_ms, b.period_end_ms]);
function bucketMerge(candidate: State, current: State): Row[] {
  const result = new Map<string, Row>(),
    groups = new Map<string, { limit: number; consumed: number }>();
  for (const b of [...candidate.buckets, ...current.buckets]) {
    const id = String(b.bucket_id),
      previous = result.get(id);
    if (previous && scope(previous) !== scope(b)) fail('RESTORE_BUDGET_SCOPE_MISMATCH');
    if (b.goal_id !== null && !candidate.goals.has(String(b.goal_id)))
      fail('RESTORE_BUDGET_GOAL_UNAVAILABLE');
    result.set(id, { ...b });
    const key = scope(b),
      g = groups.get(key);
    groups.set(key, {
      limit: Math.min(g?.limit ?? Infinity, Number(b.limit_units)),
      consumed: Math.max(g?.consumed ?? 0, Number(b.consumed_units)),
    });
  }
  if (result.size > 10000) fail('RESTORE_ACCOUNTING_LIMIT');
  return [...result.values()].map((b) => ({
    ...b,
    limit_units: groups.get(scope(b))!.limit,
    consumed_units: groups.get(scope(b))!.consumed,
    reserved_units: 0,
  }));
}
function sameRun(candidate: State, current: State, id: string): boolean {
  const a = candidate.runs.get(id),
    b = current.runs.get(id);
  if (!a) return false;
  if (
    !b ||
    ['task_id', 'dot_id', 'idempotency_key', 'executor_kind', 'task_fence'].some(
      (k) => a[k] !== b[k],
    )
  )
    fail('RESTORE_USAGE_SCOPE_MISMATCH');
  return true;
}
const maximum = (a: string | number | null | undefined, b: string | number | null | undefined) =>
  a == null ? (b ?? null) : b == null ? a : Math.max(Number(a), Number(b));

/** Prepare only a NEW private copy. The parent keeps its filesystem guard until actual stopped-Owner activation. */
export function prepareRestoreDatabase(
  candidatePath: string,
  currentSnapshotPath: string,
  restoreId: string,
): RestoreDatabaseSummary {
  let candidateFd: number | undefined,
    currentFd: number | undefined,
    currentDb: DatabaseSync | undefined,
    candidateDb: DatabaseSync | undefined,
    transaction = false;
  try {
    const open = (path: string) => {
      if (!isAbsolute(path)) fail('RESTORE_DATABASE_INVALID');
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (
          !info.isFile() ||
          info.size < 100 ||
          info.size > 128 * 1024 * 1024 ||
          realpathSync(path) !== path
        )
          fail('RESTORE_DATABASE_INVALID');
        return { fd, info };
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    };
    const candidate = open(candidatePath);
    candidateFd = candidate.fd;
    const current = open(currentSnapshotPath);
    currentFd = current.fd;
    if (candidate.info.dev === current.info.dev && candidate.info.ino === current.info.ino)
      fail('RESTORE_DATABASE_ALIAS');
    const unchanged = () => {
      for (const [path, info] of [
        [candidatePath, candidate.info],
        [currentSnapshotPath, current.info],
      ] as const) {
        const s = lstatSync(path);
        if (s.isSymbolicLink() || s.dev !== info.dev || s.ino !== info.ino)
          fail('RESTORE_DATABASE_CHANGED');
      }
    };
    candidateDb = new DatabaseSync(candidatePath, { readOnly: true });
    currentDb = new DatabaseSync(currentSnapshotPath, { readOnly: true });
    const old = validate(candidateDb),
      latest = validate(currentDb),
      buckets = bucketMerge(old, latest);
    // Current-only Runs remain in the retained current snapshot. Do not invent their Task/FK or ownership in an older checkpoint.
    const usage = latest.usage.filter((u) => sameRun(old, latest, String(u.run_id))),
      threads = latest.threads.filter((u) => sameRun(old, latest, String(u.last_run_id)));
    for (const u of usage) {
      const previous = old.usage.find((p) => p.run_id === u.run_id);
      if (
        previous &&
        ((previous.thread_id !== null &&
          u.thread_id !== null &&
          previous.thread_id !== u.thread_id) ||
          (previous.baseline_tokens !== null &&
            u.baseline_tokens !== null &&
            previous.baseline_tokens !== u.baseline_tokens))
      )
        fail('RESTORE_USAGE_SCOPE_MISMATCH');
    }
    candidateDb.close();
    candidateDb = undefined;
    unchanged();
    const summary = prepareRehearsalDatabase(candidatePath, latest.watermarks, restoreId);
    candidateDb = new DatabaseSync(candidatePath);
    candidateDb.exec(
      'PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;BEGIN IMMEDIATE;',
    );
    transaction = true;
    candidateDb
      .prepare(
        'INSERT INTO budget_policies VALUES (?,?,?,1) ON CONFLICT(dot_id) DO UPDATE SET daily_token_limit=excluded.daily_token_limit,reservation_tokens=excluded.reservation_tokens,max_active_runs=1',
      )
      .run('local-dot', latest.policy.daily_token_limit!, latest.policy.reservation_tokens!);
    for (const b of buckets)
      candidateDb
        .prepare(
          'INSERT INTO budget_buckets VALUES (?,?,?,?,?,?,?,0,?) ON CONFLICT(bucket_id) DO UPDATE SET limit_units=excluded.limit_units,reserved_units=0,consumed_units=excluded.consumed_units',
        )
        .run(
          b.bucket_id!,
          b.dot_id!,
          b.goal_id!,
          b.unit!,
          b.period_start_ms!,
          b.period_end_ms!,
          b.limit_units!,
          b.consumed_units!,
        );
    for (const u of usage) {
      const previous = candidateDb
          .prepare('SELECT * FROM run_usage WHERE run_id=?')
          .get(u.run_id!) as Row | undefined,
        max = maximum(previous?.latest_total_tokens, u.latest_total_tokens),
        chosen = previous && max !== u.latest_total_tokens ? previous : u;
      candidateDb
        .prepare(
          'INSERT INTO run_usage VALUES (?,?,?,?,0,1,?,?) ON CONFLICT(run_id) DO UPDATE SET thread_id=excluded.thread_id,baseline_tokens=excluded.baseline_tokens,latest_total_tokens=excluded.latest_total_tokens,invalid_count=0,finalized=1,observation_hash=excluded.observation_hash,updated_at_ms=excluded.updated_at_ms',
        )
        .run(
          u.run_id!,
          previous?.thread_id ?? u.thread_id!,
          previous?.baseline_tokens ?? u.baseline_tokens!,
          max,
          chosen.observation_hash!,
          maximum(previous?.updated_at_ms, u.updated_at_ms),
        );
    }
    for (const u of threads) {
      const previous = candidateDb
          .prepare('SELECT * FROM thread_usage WHERE thread_id=?')
          .get(u.thread_id!) as Row | undefined,
        max = maximum(previous?.total_tokens, u.total_tokens),
        chosen = previous && max !== u.total_tokens ? previous : u;
      candidateDb
        .prepare(
          'INSERT INTO thread_usage VALUES (?,?,?,?,0,?) ON CONFLICT(thread_id) DO UPDATE SET total_tokens=excluded.total_tokens,last_run_id=excluded.last_run_id,baseline_known=0,updated_at_ms=excluded.updated_at_ms',
        )
        .run(
          u.thread_id!,
          'local-dot',
          max,
          chosen.last_run_id!,
          maximum(previous?.updated_at_ms, u.updated_at_ms),
        );
    }
    const bytes =
      Number(candidateDb.prepare('PRAGMA page_count').get()!.page_count) *
      Number(candidateDb.prepare('PRAGMA page_size').get()!.page_size);
    if (!Number.isSafeInteger(bytes) || bytes > 128 * 1024 * 1024)
      fail('RESTORE_DATABASE_TOO_LARGE');
    unchanged();
    if (
      candidateDb.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
      candidateDb.prepare('PRAGMA foreign_key_check').all().length
    )
      fail('RESTORE_DATABASE_INVALID');
    candidateDb.exec('DROP TABLE recovery_quarantine;COMMIT;');
    transaction = false;
    return { ...summary, mergedBudgetBuckets: buckets.length };
  } catch (error) {
    if (transaction)
      try {
        candidateDb?.exec('ROLLBACK');
      } catch {}
    throw error instanceof LedgerError
      ? error
      : new LedgerError('RESTORE_DATABASE_PREPARATION_FAILED');
  } finally {
    try {
      candidateDb?.close();
    } finally {
      try {
        currentDb?.close();
      } finally {
        if (candidateFd !== undefined) closeSync(candidateFd);
        if (currentFd !== undefined) closeSync(currentFd);
      }
    }
  }
}
