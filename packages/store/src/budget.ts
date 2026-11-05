import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { ResourceBudget } from '../../contracts/src/budget.ts';
export interface BudgetPolicy {
  dailyTokens: number;
  reservationTokens: number;
  /** Runs that may execute at once across all projects (1–8). Default 3. */
  maxActiveRuns?: number;
}
/** Default number of conversations that may run at the same time. */
export const DEFAULT_MAX_ACTIVE_RUNS = 3;
type Row = Record<string, string | number | null>;
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const active =
  "('preparing','submitting','running','waiting_input','waiting_approval','outcome_unknown')";
/** Private collaborator of ExecutionLedger. Mutations run inside its Owner-checked transaction. */
export class BudgetLedger {
  private db: DatabaseSync;
  private dot: string;
  private policy: BudgetPolicy;
  private fail: (code: string) => never;
  constructor(
    db: DatabaseSync,
    dot: string,
    fail: (code: string) => never,
    policy: BudgetPolicy = { dailyTokens: 1000000, reservationTokens: 32000 },
  ) {
    if (
      !Number.isSafeInteger(policy.dailyTokens) ||
      policy.dailyTokens < 1 ||
      policy.dailyTokens > 1e12 ||
      !Number.isSafeInteger(policy.reservationTokens) ||
      policy.reservationTokens < 1 ||
      policy.reservationTokens > policy.dailyTokens ||
      (policy.maxActiveRuns !== undefined &&
        (!Number.isSafeInteger(policy.maxActiveRuns) ||
          policy.maxActiveRuns < 1 ||
          policy.maxActiveRuns > 8))
    )
      fail('INVALID_BUDGET_POLICY');
    this.db = db;
    this.dot = dot;
    this.fail = fail;
    this.policy = policy;
  }
  private one(sql: string, ...args: Array<string | number | null>) {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: Array<string | number | null>) {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private exec(sql: string, ...args: Array<string | number | null>) {
    return this.db.prepare(sql).run(...args);
  }
  initialize() {
    this.exec(
      'INSERT OR IGNORE INTO budget_policies VALUES (?,?,?,?)',
      this.dot,
      this.policy.dailyTokens,
      this.policy.reservationTokens,
      this.policy.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS,
    );
  }
  private bucket(now = Date.now()): Row {
    const policy =
        this.one('SELECT * FROM budget_policies WHERE dot_id=?', this.dot) ??
        this.fail('BUDGET_POLICY_UNAVAILABLE'),
      start = Math.floor(now / 86400000) * 86400000,
      key = 'tokens:' + this.dot + ':' + start;
    this.exec(
      "INSERT OR IGNORE INTO budget_buckets VALUES (?,?,NULL,'tokens',?,?,?,0,0)",
      key,
      this.dot,
      start,
      start + 86400000,
      policy.daily_token_limit!,
    );
    return (
      this.one('SELECT * FROM budget_buckets WHERE bucket_id=? AND dot_id=?', key, this.dot) ??
      this.fail('BUDGET_SCOPE_MISMATCH')
    );
  }
  /** Allocate the current-day Goal constraint inside the same claim transaction as its Run. */
  private goalBucket(goalId: string, now: number): void {
    const goal =
      this.one(
        'SELECT status,constraints_json,deadline_at_ms FROM goals WHERE goal_id=? AND dot_id=?',
        goalId,
        this.dot,
      ) ?? this.fail('GOAL_NOT_ACTIVE');
    if (
      goal.status !== 'active' ||
      (goal.deadline_at_ms !== null && Number(goal.deadline_at_ms) <= now)
    )
      this.fail('GOAL_NOT_ACTIVE');
    const constraints: unknown = JSON.parse(String(goal.constraints_json));
    // Legacy M2 Goals have no declared daily quota: their explicit buckets keep their original semantics.
    if (
      !constraints ||
      typeof constraints !== 'object' ||
      Array.isArray(constraints) ||
      !Object.hasOwn(constraints, 'budgetTokens')
    )
      return;
    const units = (constraints as { budgetTokens: unknown }).budgetTokens;
    if (!Number.isSafeInteger(units) || Number(units) < 1 || Number(units) > 1000000000)
      this.fail('INVALID_GOAL_BUDGET');
    const start = Math.floor(now / 86400000) * 86400000,
      key = 'goal-tokens:' + hash([this.dot, goalId, start]);
    this.exec(
      "INSERT OR IGNORE INTO budget_buckets VALUES (?,?,?,'tokens',?,?,?,0,0)",
      key,
      this.dot,
      goalId,
      start,
      start + 86400000,
      Number(units),
    );
    const updated = this.exec(
      "UPDATE budget_buckets SET limit_units=min(limit_units,?) WHERE bucket_id=? AND dot_id=? AND goal_id=? AND unit='tokens' AND period_start_ms=? AND period_end_ms=?",
      Number(units),
      key,
      this.dot,
      goalId,
      start,
      start + 86400000,
    );
    if (Number(updated.changes) !== 1) this.fail('BUDGET_SCOPE_MISMATCH');
  }
  reserve(runId: string, goalId: string | null): void {
    const policy =
        this.one('SELECT * FROM budget_policies WHERE dot_id=?', this.dot) ??
        this.fail('BUDGET_POLICY_UNAVAILABLE'),
      units = Number(policy.reservation_tokens),
      now = Date.now(),
      primary = this.bucket(now);
    if (goalId !== null) this.goalBucket(goalId, now);
    const readOnly =
      this.one(
        "SELECT json_extract(t.constraints_json,'$.mode') AS mode FROM task_runs r JOIN tasks t USING(task_id) WHERE r.run_id=? AND r.dot_id=?",
        runId,
        this.dot,
      )?.mode === 'readOnly';
    // Privacy revocation plus a real Host closure can release execution capacity
    // for a fresh read-only Run. Its unknown Token reservation remains held.
    const executing = this.one(
      `SELECT COUNT(*) AS n FROM task_runs r JOIN tasks t USING(task_id) WHERE r.dot_id=? AND r.status IN ${active} AND NOT (?=1 AND r.status='outcome_unknown' AND coalesce(json_extract(t.constraints_json,'$.mode'),'')='readOnly' AND coalesce(json_extract(t.constraints_json,'$.privacyRevoked'),0)=1 AND NOT EXISTS(SELECT 1 FROM workspace_write_leases l WHERE l.run_id=r.run_id) AND EXISTS(SELECT 1 FROM task_events e WHERE e.run_id=r.run_id AND e.event_type='executor_closed'))`,
      this.dot,
      readOnly ? 1 : 0,
    )!;
    if (Number(executing.n) > Number(policy.max_active_runs)) this.fail('RUNTIME_BUSY');
    const extra = this.all(
      'SELECT * FROM budget_buckets WHERE dot_id=? AND bucket_id<>? AND (goal_id IS NULL OR goal_id=?) AND period_start_ms<=? AND period_end_ms>?',
      this.dot,
      primary.bucket_id!,
      goalId,
      now,
      now,
    );
    if (extra.length > 16) this.fail('BUDGET_BUCKET_LIMIT');
    if (extra.some((b) => b.unit !== 'tokens')) this.fail('COST_ESTIMATE_UNAVAILABLE');
    for (const bucket of [primary, ...extra]) {
      const updated = this.exec(
        'UPDATE budget_buckets SET reserved_units=reserved_units+? WHERE bucket_id=? AND dot_id=? AND limit_units-consumed_units-reserved_units>=?',
        units,
        bucket.bucket_id!,
        this.dot,
        units,
      );
      if (Number(updated.changes) !== 1) this.fail('TOKEN_BUDGET_EXHAUSTED');
      this.exec(
        "INSERT INTO budget_reservations(reservation_id,bucket_id,run_id,units,state) VALUES (?,?,?,?,'active')",
        randomUUID(),
        bucket.bucket_id!,
        runId,
        units,
      );
    }
    this.exec('INSERT INTO run_usage(run_id,updated_at_ms) VALUES (?,?)', runId, now);
  }
  bind(runId: string, threadId: string, isNew: boolean): void {
    const usage = this.one('SELECT * FROM run_usage WHERE run_id=?', runId);
    if (!usage) return;
    if (usage.thread_id) {
      if (usage.thread_id !== threadId) this.fail('USAGE_SCOPE_MISMATCH');
      return;
    }
    const previous = this.one('SELECT * FROM thread_usage WHERE thread_id=?', threadId);
    if (previous && previous.dot_id !== this.dot) this.fail('USAGE_SCOPE_MISMATCH');
    const baseline = isNew
      ? 0
      : previous?.baseline_known === 1
        ? (previous.total_tokens ?? null)
        : null;
    this.exec(
      'UPDATE run_usage SET thread_id=?,baseline_tokens=?,updated_at_ms=? WHERE run_id=?',
      threadId,
      baseline,
      Date.now(),
      runId,
    );
    this.exec(
      'INSERT INTO thread_usage VALUES (?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET last_run_id=excluded.last_run_id,updated_at_ms=excluded.updated_at_ms',
      threadId,
      this.dot,
      isNew ? 0 : (previous?.total_tokens ?? null),
      runId,
      isNew ? 1 : (previous?.baseline_known ?? 0),
      Date.now(),
    );
  }
  observe(runId: string, threadId: string, total: unknown): 'updated' | 'duplicate' | 'invalid' {
    const row =
      this.one('SELECT * FROM run_usage WHERE run_id=?', runId) ?? this.fail('USAGE_NOT_TRACKED');
    if (row.thread_id !== threadId) this.fail('USAGE_SCOPE_MISMATCH');
    if (row.finalized === 1) this.fail('USAGE_ALREADY_FINALIZED');
    if (
      typeof total !== 'number' ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total > 1e12 ||
      total < Number(row.latest_total_tokens ?? row.baseline_tokens ?? 0)
    ) {
      this.exec(
        'UPDATE run_usage SET invalid_count=invalid_count+1,updated_at_ms=? WHERE run_id=?',
        Date.now(),
        runId,
      );
      return 'invalid';
    }
    if (row.latest_total_tokens === total) return 'duplicate';
    this.exec(
      'UPDATE run_usage SET latest_total_tokens=?,observation_hash=?,updated_at_ms=? WHERE run_id=?',
      total,
      hash([runId, threadId, total]),
      Date.now(),
      runId,
    );
    this.exec(
      'UPDATE thread_usage SET total_tokens=CASE WHEN total_tokens IS NULL OR total_tokens<? THEN ? ELSE total_tokens END,updated_at_ms=? WHERE thread_id=? AND dot_id=? AND last_run_id=?',
      total,
      total,
      Date.now(),
      threadId,
      this.dot,
      runId,
    );
    const observed =
      row.baseline_tokens === null ? 0 : Math.max(0, total - Number(row.baseline_tokens));
    for (const reservation of this.all(
      "SELECT r.* FROM budget_reservations r JOIN budget_buckets b USING(bucket_id) WHERE r.run_id=? AND b.dot_id=? AND r.state IN ('active','held_unknown')",
      runId,
      this.dot,
    )) {
      if (observed > Number(reservation.units)) {
        this.exec(
          'UPDATE budget_buckets SET reserved_units=reserved_units+? WHERE bucket_id=?',
          observed - Number(reservation.units),
          reservation.bucket_id!,
        );
        this.exec(
          'UPDATE budget_reservations SET units=? WHERE reservation_id=?',
          observed,
          reservation.reservation_id!,
        );
      }
    }
    return 'updated';
  }
  unknown(runId: string, seal = false): void {
    this.exec(
      "UPDATE budget_reservations SET state='held_unknown' WHERE run_id=? AND state='active'",
      runId,
    );
    if (seal) {
      this.exec('UPDATE run_usage SET finalized=1 WHERE run_id=?', runId);
      this.exec(
        'UPDATE thread_usage SET baseline_known=0 WHERE last_run_id=? AND dot_id=?',
        runId,
        this.dot,
      );
    }
  }
  finish(runId: string): { known: boolean; tokens: number | null } {
    const row = this.one('SELECT * FROM run_usage WHERE run_id=?', runId);
    if (!row) return { known: false, tokens: null };
    const sent = this.one(
      "SELECT intent_id FROM execution_intents WHERE run_id=? AND kind='turn_start' AND state IN ('sending','accepted','outcome_unknown','reconciled')",
      runId,
    );
    const delta =
      row.latest_total_tokens === null || row.baseline_tokens === null
        ? null
        : Number(row.latest_total_tokens) - Number(row.baseline_tokens);
    const known = !sent || (row.invalid_count === 0 && delta !== null && delta > 0);
    if (!known) {
      this.unknown(runId, true);
      if (row.invalid_count === 0 && Number(row.latest_total_tokens) > 0)
        this.exec(
          'UPDATE thread_usage SET baseline_known=1 WHERE last_run_id=? AND dot_id=?',
          runId,
          this.dot,
        );
      return { known: false, tokens: null };
    }
    const tokens = sent ? delta! : 0,
      evidence = hash({
        runId,
        tokens,
        baseline: row.baseline_tokens,
        total: row.latest_total_tokens,
        source: sent ? 'reported_thread_total_delta' : 'no_turn_sent',
      });
    for (const reservation of this.all(
      'SELECT r.* FROM budget_reservations r JOIN budget_buckets b USING(bucket_id) WHERE r.run_id=? AND b.dot_id=?',
      runId,
      this.dot,
    )) {
      if (reservation.state === 'settled') {
        if (reservation.actual_units !== tokens || reservation.settlement_hash !== evidence)
          this.fail('BUDGET_SETTLEMENT_CONFLICT');
        continue;
      }
      this.exec(
        'UPDATE budget_buckets SET reserved_units=reserved_units-?,consumed_units=consumed_units+? WHERE bucket_id=?',
        reservation.units!,
        tokens,
        reservation.bucket_id!,
      );
      this.exec(
        "UPDATE budget_reservations SET state='settled',actual_units=?,settlement_hash=? WHERE reservation_id=?",
        tokens,
        evidence,
        reservation.reservation_id!,
      );
    }
    this.exec('UPDATE run_usage SET finalized=1 WHERE run_id=?', runId);
    if (sent)
      this.exec(
        'UPDATE thread_usage SET baseline_known=1 WHERE last_run_id=? AND dot_id=?',
        runId,
        this.dot,
      );
    return { known: true, tokens };
  }
  snapshot(): ResourceBudget {
    const bucket = this.bucket(),
      policy = this.one('SELECT * FROM budget_policies WHERE dot_id=?', this.dot)!;
    return {
      periodStart: Number(bucket.period_start_ms),
      periodEnd: Number(bucket.period_end_ms),
      limitTokens: Number(bucket.limit_units),
      reservationPerRun: Number(policy.reservation_tokens),
      reservedTokens: Number(bucket.reserved_units),
      reportedTokens: Number(bucket.consumed_units),
      availableTokens: Math.max(
        0,
        Number(bucket.limit_units) - Number(bucket.reserved_units) - Number(bucket.consumed_units),
      ),
      unknownHeldTokens: Number(
        this.one(
          "SELECT COALESCE(SUM(units),0) AS n FROM (SELECT MAX(r.units) AS units FROM budget_reservations r JOIN budget_buckets b USING(bucket_id) WHERE b.dot_id=? AND b.unit='tokens' AND r.state='held_unknown' GROUP BY r.run_id)",
          this.dot,
        )!.n,
      ),
      activeRuns: Number(
        this.one(
          `SELECT COUNT(*) AS n FROM task_runs WHERE dot_id=? AND status IN ${active}`,
          this.dot,
        )!.n,
      ),
      maxConcurrentRuns: 1,
      estimatedUsd: null,
      coverage: 'runs_admitted_since_budget_enabled',
    };
  }
}
