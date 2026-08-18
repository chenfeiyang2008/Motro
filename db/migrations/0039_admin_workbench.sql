-- Ticket 19 — Admin complete workbench: additive query-support indices.
--
-- Scope: PURELY additive. No table rewrites, no column changes, no mutation of
-- immutable facts, no weakening of any existing trigger/CHECK/FK/RESTRICT.
-- Rationale: the admin workbench added filters/pagination across users, XP ledger,
-- review queue, import batches, and operations. The queries they back are already
-- expressible against the existing schema; these indices make them efficient.
--
-- Migration policy (Ticket 19 §11):
--   - append-only, migratable from zero (0001..0037) AND from current HEAD (0001..0036 then 0037);
--   - never edit existing migration files;
--   - never use session_replication_role, DISABLE TRIGGER, or fact-deleting recovery.

-- users: filtered list (status) + keyset (created_at, id), and (role, created_at).
CREATE INDEX IF NOT EXISTS users_status_created_idx
  ON users (status, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS users_role_created_idx
  ON users (role, created_at ASC, id ASC);

-- users: q search on username/display_name (ILIKE prefix). A btree on lower() is a
-- pragmatic partial aid for prefix search; full-text/ngram is out of scope.
CREATE INDEX IF NOT EXISTS users_username_lower_idx
  ON users (lower(username));
CREATE INDEX IF NOT EXISTS users_display_name_lower_idx
  ON users (lower(display_name));

-- xp_entries: void/correct lookups target ordinary (non-correction/void) entries
-- by their reference chain. The dedup index on (review_event_id, rule_version) is
-- partial (references_xp_entry IS NULL); add a general pointer index for the
-- "already voided?" guard and for correction/void lineage queries.
CREATE INDEX IF NOT EXISTS xp_entries_references_idx
  ON xp_entries (references_xp_entry);

-- xp_entries: admin ledger list (userId/kind filter + created_at keyset).
CREATE INDEX IF NOT EXISTS xp_entries_user_id_created_idx
  ON xp_entries (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS xp_entries_reason_created_idx
  ON xp_entries (reason, created_at DESC, id DESC);

-- import_batches: existing per-column indices (status, created_at DESC) already cover
-- the batch filters; add a composite for the common status+time combination.
CREATE INDEX IF NOT EXISTS import_batches_status_created_idx
  ON import_batches (status, created_at DESC, id ASC);

-- application_operations: existing status / target / created_at indices cover the
-- added filters; add last_error_code for the errorCode filter.
CREATE INDEX IF NOT EXISTS application_operations_error_code_idx
  ON application_operations (last_error_code);