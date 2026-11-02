-- Personal Agent local single-profile design contract.
-- One authoritative initialization schema; not an installed application database.
-- SQLite >= 3.37 with JSON1; FTS5 is optional and is not required here.
-- Open every runtime connection with foreign_keys=ON and busy_timeout configured.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

BEGIN IMMEDIATE;

CREATE TABLE schema_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_revision INTEGER NOT NULL CHECK (schema_revision > 0)
);
INSERT INTO schema_metadata VALUES (1, 2);

CREATE TABLE profiles (
  profile_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE runtime_owners (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id),
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch > 0),
  instance_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('main','daemon')),
  state TEXT NOT NULL CHECK (state IN ('starting','ready','draining','stopped')),
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE dots (
  dot_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
  display_name TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL DEFAULT 1 CHECK (policy_epoch > 0),
  privacy_epoch INTEGER NOT NULL DEFAULT 1 CHECK (privacy_epoch > 0)
);

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  canonical_git_root TEXT NOT NULL,
  display_name TEXT NOT NULL,
  UNIQUE(project_id, dot_id),
  UNIQUE(dot_id, canonical_git_root)
);

CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  dot_id TEXT NOT NULL,
  canonical_cwd TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('main','worktree','external')),
  state TEXT NOT NULL CHECK (state IN ('ready','busy','archived','invalid')),
  write_fence INTEGER NOT NULL DEFAULT 0 CHECK (write_fence >= 0),
  UNIQUE(workspace_id, dot_id),
  FOREIGN KEY(project_id, dot_id) REFERENCES projects(project_id, dot_id)
);
CREATE UNIQUE INDEX one_workspace_per_directory ON workspaces(dot_id, canonical_cwd);
CREATE TABLE workspace_identities (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id),
  device_id TEXT NOT NULL,
  inode TEXT NOT NULL
);

CREATE TABLE goals (
  goal_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','completed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  plan_version INTEGER NOT NULL DEFAULT 1 CHECK (plan_version > 0),
  constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
  criteria_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criteria_json)),
  deadline_at_ms INTEGER,
  UNIQUE(goal_id, dot_id)
);

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  goal_id TEXT,
  parent_task_id TEXT,
  workspace_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
  criteria_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criteria_json)),
  status TEXT NOT NULL CHECK (status IN (
    'created','queued','running','waiting_input','waiting_approval',
    'waiting_trigger','paused','needs_review','completed','failed',
    'cancelled','outcome_unknown'
  )),
  dispatch_blocked INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_blocked IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  write_fence INTEGER NOT NULL DEFAULT 0 CHECK (write_fence >= 0),
  last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(task_id, dot_id),
  FOREIGN KEY(goal_id, dot_id) REFERENCES goals(goal_id, dot_id),
  FOREIGN KEY(parent_task_id, dot_id) REFERENCES tasks(task_id, dot_id),
  FOREIGN KEY(workspace_id, dot_id) REFERENCES workspaces(workspace_id, dot_id)
);
CREATE INDEX tasks_by_dot_status ON tasks(dot_id, status, updated_at_ms);

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL UNIQUE REFERENCES dots(dot_id),
  UNIQUE(conversation_id, dot_id)
);

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  dot_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system_event')),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  route_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (route_state IN ('pending','decided','clarification','failed')),
  created_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(message_id, dot_id),
  FOREIGN KEY(conversation_id, dot_id) REFERENCES conversations(conversation_id, dot_id)
);
CREATE INDEX messages_by_conversation ON messages(conversation_id, created_at_ms, message_id);

CREATE TABLE message_task_links (
  message_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dot_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('primary','reference','constraint','progress')),
  PRIMARY KEY(message_id, task_id, relation),
  FOREIGN KEY(message_id, dot_id) REFERENCES messages(message_id, dot_id),
  FOREIGN KEY(task_id, dot_id) REFERENCES tasks(task_id, dot_id)
);

CREATE TABLE focus_states (
  conversation_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL,
  focused_task_id TEXT,
  established_by_message_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY(conversation_id, dot_id) REFERENCES conversations(conversation_id, dot_id),
  FOREIGN KEY(focused_task_id, dot_id) REFERENCES tasks(task_id, dot_id),
  FOREIGN KEY(established_by_message_id, dot_id) REFERENCES messages(message_id, dot_id)
);

CREATE TABLE pending_interactions (
  interaction_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  origin_message_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('clarification','task_input','approval')),
  state TEXT NOT NULL CHECK (state IN ('pending','resolved','expired','cancelled')),
  expected_task_version INTEGER,
  options_json TEXT NOT NULL CHECK (json_valid(options_json)),
  expires_at_ms INTEGER NOT NULL,
  FOREIGN KEY(origin_message_id, dot_id) REFERENCES messages(message_id, dot_id),
  FOREIGN KEY(task_id, dot_id) REFERENCES tasks(task_id, dot_id)
);

CREATE TABLE router_decisions (
  decision_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
  router_revision TEXT NOT NULL,
  candidate_snapshot_json TEXT NOT NULL CHECK (json_valid(candidate_snapshot_json)),
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES router_decisions(decision_id),
  operation_index INTEGER NOT NULL CHECK (operation_index >= 0),
  task_id TEXT REFERENCES tasks(task_id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending','blocked','executing','completed','failed','cancelled','outcome_unknown'
  )),
  expected_task_version INTEGER,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  input_hash TEXT NOT NULL,
  result_ref TEXT,
  UNIQUE(decision_id, operation_index)
);

CREATE TABLE operation_dependencies (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  prerequisite_id TEXT NOT NULL REFERENCES operations(operation_id),
  PRIMARY KEY(operation_id, prerequisite_id),
  CHECK (operation_id <> prerequisite_id)
);

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  kind TEXT NOT NULL CHECK (kind IN ('desktop','scheduler','github','device','connector')),
  identity_binding_ref TEXT NOT NULL,
  cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  UNIQUE(source_id, dot_id)
);

CREATE TABLE incoming_triggers (
  trigger_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  dot_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_thread_ref TEXT,
  actor_ref TEXT NOT NULL,
  verification_ref TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  UNIQUE(source_id, source_event_id),
  UNIQUE(trigger_id, dot_id),
  FOREIGN KEY(source_id, dot_id) REFERENCES sources(source_id, dot_id)
);
CREATE TRIGGER incoming_trigger_is_immutable BEFORE UPDATE ON incoming_triggers
BEGIN
  SELECT RAISE(ABORT, 'incoming trigger is immutable');
END;

CREATE TABLE task_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  dot_id TEXT NOT NULL,
  origin_trigger_id TEXT,
  operation_id TEXT REFERENCES operations(operation_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  executor_kind TEXT NOT NULL CHECK (executor_kind IN ('codex','dsh-experimental')),
  status TEXT NOT NULL CHECK (status IN (
    'preparing','submitting','running','waiting_input','waiting_approval',
    'completed','failed','cancelled','outcome_unknown'
  )),
  task_snapshot_version INTEGER NOT NULL,
  goal_plan_version INTEGER,
  task_fence INTEGER NOT NULL CHECK (task_fence > 0),
  runtime_epoch INTEGER NOT NULL CHECK (runtime_epoch > 0),
  policy_epoch INTEGER NOT NULL CHECK (policy_epoch > 0),
  privacy_epoch INTEGER NOT NULL CHECK (privacy_epoch > 0),
  worker_id TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  result_ref TEXT,
  UNIQUE(run_id, task_id),
  UNIQUE(task_id, task_fence),
  FOREIGN KEY(task_id, dot_id) REFERENCES tasks(task_id, dot_id),
  FOREIGN KEY(origin_trigger_id, dot_id) REFERENCES incoming_triggers(trigger_id, dot_id)
);
CREATE UNIQUE INDEX one_active_run_per_task ON task_runs(task_id)
WHERE status IN ('preparing','submitting','running','waiting_input','waiting_approval','outcome_unknown');

CREATE TABLE workspace_write_leases (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id),
  run_id TEXT NOT NULL UNIQUE REFERENCES task_runs(run_id),
  workspace_fence INTEGER NOT NULL CHECK (workspace_fence > 0),
  lease_until_ms INTEGER NOT NULL
);

CREATE TABLE thread_bindings (
  binding_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  executor_kind TEXT NOT NULL CHECK (executor_kind IN ('codex','dsh-experimental')),
  execution_thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  privacy_epoch INTEGER NOT NULL CHECK (privacy_epoch > 0),
  state TEXT NOT NULL CHECK (state IN ('active','invalidated','archived')),
  rollover_reason TEXT,
  UNIQUE(task_id, generation),
  UNIQUE(executor_kind, execution_thread_id)
);
CREATE UNIQUE INDEX one_active_binding_per_task ON thread_bindings(task_id) WHERE state = 'active';

CREATE TABLE execution_intents (
  intent_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(run_id),
  intent_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('thread_start','thread_resume','turn_start','turn_steer','turn_interrupt')),
  execution_thread_id TEXT,
  execution_turn_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('prepared','sending','accepted','rejected','outcome_unknown','reconciled')),
  input_hash TEXT NOT NULL,
  connection_epoch INTEGER,
  rpc_request_id TEXT,
  response_ref TEXT,
  created_at_ms INTEGER NOT NULL,
  CHECK (kind = 'thread_start' OR execution_thread_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_initial_intent_per_run ON execution_intents(run_id,kind)
WHERE kind IN ('thread_start','thread_resume','turn_start');

CREATE TABLE task_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  run_id TEXT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  task_version INTEGER NOT NULL CHECK (task_version > 0),
  event_type TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at_ms INTEGER NOT NULL,
  UNIQUE(task_id, sequence),
  FOREIGN KEY(run_id, task_id) REFERENCES task_runs(run_id, task_id)
);

CREATE TABLE outbox_events (
  outbox_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  aggregate_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','delivered','dead_letter')),
  claim_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER
);

CREATE TABLE main_feed (
  projection_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  source_event_id TEXT NOT NULL UNIQUE,
  item_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  privacy_epoch INTEGER NOT NULL,
  display_json TEXT NOT NULL CHECK (json_valid(display_json))
);

CREATE TABLE mandates (
  mandate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  origin_trigger_id TEXT REFERENCES incoming_triggers(trigger_id),
  policy_epoch INTEGER NOT NULL CHECK (policy_epoch > 0),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  granted_by_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoked','expired')),
  expires_at_ms INTEGER
);

CREATE TABLE subscriptions (
  subscription_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  dot_id TEXT NOT NULL,
  source_thread_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('context_only','wake','actionable')),
  event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
  state TEXT NOT NULL CHECK (state IN ('active','paused','cancelled')),
  UNIQUE(task_id, source_id, source_thread_ref, purpose),
  FOREIGN KEY(task_id, dot_id) REFERENCES tasks(task_id, dot_id),
  FOREIGN KEY(source_id, dot_id) REFERENCES sources(source_id, dot_id)
);

CREATE TABLE trigger_deliveries (
  delivery_id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dot_id TEXT NOT NULL,
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('context','wake','actionable')),
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','acknowledged','ignored','dead_letter')),
  reason_code TEXT,
  UNIQUE(trigger_id, task_id, delivery_kind),
  FOREIGN KEY(trigger_id, dot_id) REFERENCES incoming_triggers(trigger_id, dot_id),
  FOREIGN KEY(task_id, dot_id) REFERENCES tasks(task_id, dot_id)
);

CREATE TABLE schedules (
  schedule_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  kind TEXT NOT NULL CHECK (kind IN ('once','cron')),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
  timezone TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','paused','cancelled','fulfilled')),
  misfire_policy TEXT NOT NULL CHECK (misfire_policy IN ('skip','coalesce','bounded_catch_up')),
  overlap_policy TEXT NOT NULL CHECK (overlap_policy IN ('skip','coalesce')),
  max_catch_up INTEGER NOT NULL DEFAULT 1 CHECK (max_catch_up BETWEEN 1 AND 10),
  next_fire_at_ms INTEGER,
  expires_at_ms INTEGER
);
CREATE INDEX schedules_due ON schedules(state, next_fire_at_ms);

CREATE TABLE schedule_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id),
  schedule_version INTEGER NOT NULL CHECK (schedule_version > 0),
  scheduled_at_ms INTEGER NOT NULL,
  trigger_id TEXT UNIQUE REFERENCES incoming_triggers(trigger_id),
  state TEXT NOT NULL CHECK (state IN ('pending','waiting_host','enqueued','skipped','cancelled')),
  UNIQUE(schedule_id, scheduled_at_ms, schedule_version)
);

CREATE TABLE computer_sessions (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  run_id TEXT REFERENCES task_runs(run_id),
  driver_kind TEXT NOT NULL CHECK (driver_kind IN ('browser','x11','wayland')),
  state TEXT NOT NULL CHECK (state IN ('starting','ready','revoking','paused','closing','closed','failed')),
  control_owner TEXT NOT NULL CHECK (control_owner IN ('none','agent','human')),
  control_epoch INTEGER NOT NULL DEFAULT 1 CHECK (control_epoch > 0),
  policy_epoch INTEGER NOT NULL CHECK (policy_epoch > 0),
  allowed_scope_json TEXT NOT NULL CHECK (json_valid(allowed_scope_json)),
  current_frame_id TEXT,
  driver_instance_id TEXT NOT NULL
);

CREATE TABLE actions (
  action_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT REFERENCES computer_sessions(session_id),
  action_key TEXT NOT NULL UNIQUE,
  capability TEXT NOT NULL,
  canonical_payload_json TEXT NOT NULL CHECK (json_valid(canonical_payload_json)),
  payload_hash TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  task_fence INTEGER NOT NULL,
  policy_epoch INTEGER NOT NULL,
  control_epoch INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'prepared','awaiting_approval','approved','reserved','dispatched',
    'succeeded','failed','outcome_unknown','rejected','cancelled'
  )),
  approval_receipt_id TEXT,
  provider_idempotency_key TEXT,
  provider_object_id TEXT,
  outcome_ref TEXT,
  FOREIGN KEY(run_id, task_id) REFERENCES task_runs(run_id, task_id),
  FOREIGN KEY(approval_receipt_id, action_id) REFERENCES approval_receipts(receipt_id, action_id)
);

CREATE TABLE approval_receipts (
  receipt_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL UNIQUE REFERENCES actions(action_id),
  approved_payload_hash TEXT NOT NULL,
  granted_by_ref TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  uses_remaining INTEGER NOT NULL CHECK (uses_remaining IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('granted','consumed','revoked','expired')),
  UNIQUE(receipt_id, action_id),
  CHECK ((state = 'granted' AND uses_remaining = 1) OR (state <> 'granted' AND uses_remaining = 0))
);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  task_id TEXT REFERENCES tasks(task_id),
  content_sha256 TEXT NOT NULL,
  relative_storage_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staging','quarantined','published','deleting','deleted')),
  sensitivity TEXT NOT NULL,
  privacy_epoch INTEGER NOT NULL CHECK (privacy_epoch > 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  retain_until_ms INTEGER
);

CREATE TABLE prompt_manifests (
  manifest_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(run_id),
  role TEXT NOT NULL,
  mode TEXT NOT NULL,
  module_hashes_json TEXT NOT NULL CHECK (json_valid(module_hashes_json)),
  tool_snapshot_hash TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL,
  privacy_epoch INTEGER NOT NULL,
  context_refs_json TEXT NOT NULL CHECK (json_valid(context_refs_json)),
  rendered_artifact_id TEXT REFERENCES artifacts(artifact_id)
);

CREATE TABLE task_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  privacy_epoch INTEGER NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  content_sha256 TEXT NOT NULL,
  FOREIGN KEY(run_id, task_id) REFERENCES task_runs(run_id, task_id)
);

CREATE TABLE episodes (
  episode_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  privacy_epoch INTEGER NOT NULL,
  dirty INTEGER NOT NULL CHECK (dirty IN (0,1)),
  source_digest TEXT NOT NULL
);

CREATE TABLE episode_message_links (
  episode_id TEXT NOT NULL REFERENCES episodes(episode_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  PRIMARY KEY(episode_id, message_id)
);

CREATE TABLE memory_entries (
  entry_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  source_ref TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  privacy_epoch INTEGER NOT NULL,
  deleted_at_ms INTEGER
);

CREATE TABLE memory_claims (
  claim_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  fact_key TEXT NOT NULL,
  fact_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','disputed','expired','deleted')),
  trust TEXT NOT NULL CHECK (trust IN ('explicit_user','verified_connector','agent_inference','untrusted_external')),
  valid_from_ms INTEGER,
  valid_until_ms INTEGER,
  recorded_at_ms INTEGER NOT NULL,
  supersedes_claim_id TEXT REFERENCES memory_claims(claim_id),
  version INTEGER NOT NULL CHECK (version > 0),
  privacy_epoch INTEGER NOT NULL
);

CREATE TABLE claim_evidence (
  evidence_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES memory_claims(claim_id),
  entry_id TEXT REFERENCES memory_entries(entry_id),
  source_message_id TEXT REFERENCES messages(message_id),
  quote_hash TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  CHECK (entry_id IS NOT NULL OR source_message_id IS NOT NULL)
);

CREATE TABLE derivation_edges (
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  source_ref TEXT NOT NULL,
  derived_ref TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  privacy_epoch INTEGER NOT NULL,
  PRIMARY KEY(dot_id, source_ref, derived_ref, source_revision)
);

CREATE TABLE privacy_tombstones (
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  source_ref TEXT NOT NULL,
  privacy_epoch INTEGER NOT NULL CHECK (privacy_epoch > 0),
  deleted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(dot_id, source_ref)
);

CREATE TABLE budget_buckets (
  bucket_id TEXT PRIMARY KEY,
  dot_id TEXT NOT NULL REFERENCES dots(dot_id),
  goal_id TEXT REFERENCES goals(goal_id),
  unit TEXT NOT NULL CHECK (unit IN ('tokens','estimated_micro_usd')),
  period_start_ms INTEGER NOT NULL,
  period_end_ms INTEGER NOT NULL,
  limit_units INTEGER NOT NULL CHECK (limit_units >= 0),
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  consumed_units INTEGER NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
  CHECK (period_end_ms > period_start_ms)
);

CREATE TABLE budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL REFERENCES budget_buckets(bucket_id),
  run_id TEXT NOT NULL REFERENCES task_runs(run_id),
  units INTEGER NOT NULL CHECK (units >= 0),
  state TEXT NOT NULL CHECK (state IN ('active','settled','held_unknown')),
  UNIQUE(bucket_id, run_id)
);

CREATE TABLE verification_specs (
  spec_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  baseline_commit TEXT,
  command_argv_json TEXT NOT NULL CHECK (json_valid(command_argv_json)),
  required_targets_json TEXT NOT NULL CHECK (json_valid(required_targets_json)),
  expectation_json TEXT NOT NULL CHECK (json_valid(expectation_json)),
  verifier_hash TEXT NOT NULL,
  UNIQUE(task_id, revision)
);

CREATE TABLE verification_results (
  verification_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(run_id),
  spec_id TEXT NOT NULL REFERENCES verification_specs(spec_id),
  status TEXT NOT NULL CHECK (status IN ('passed','failed','needs_review','unknown')),
  discovered_count INTEGER CHECK (discovered_count >= 0),
  executed_count INTEGER CHECK (executed_count >= 0),
  skipped_count INTEGER CHECK (skipped_count >= 0),
  evidence_ref TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL
);

COMMIT;
