-- 0037_challenge_quiz_scoring
-- Ticket 14: server-graded Challenge Quiz scoring foundation.
--
-- Closes the Challenge Points seam by adding:
--   - challenge_attempts: server-authoritative quiz sessions (week, user, expires, status)
--   - challenge_attempt_items: frozen 10-row question snapshots per attempt
--   - challenge_answers: immutable per-question answer facts (server-graded, idempotent)
--   - challenge_point_entries: ALTER to add lexical_entry_id / direction + ADR-0007 dedup index
--   - Append-only triggers on all new tables
--
-- Security / product invariants (ADR-0007):
--   - Scoring is server-graded: server_answer is frozen at attempt creation; client never specifies points.
--   - Same (user, week, lexical_entry, direction) first_correct_answer yields at most 5 points.
--   - Daily XP (xp_entries) is NEVER read by challenge/leaderboard queries; disjoint ledgers.
--   - All new fact tables are INSERT-only (BEFORE UPDATE/DELETE triggers RAISE).
--   - Attempts expire after 5 minutes (server clock); expired attempts cannot accept answers.
--   - Corrections/voids on challenge_point_entries use references_point_entry (existing 0035 pattern).

-- =========================================================================
-- 1. challenge_attempts: the server-authoritative quiz session.
-- =========================================================================
CREATE TABLE challenge_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  challenge_week text NOT NULL CHECK (length(challenge_week) BETWEEN 1 AND 40),
  total_items    integer NOT NULL CHECK (total_items BETWEEN 1 AND 20),
  status         text NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress', 'completed', 'cutoff')),
  -- 5 minutes from creation (ADR-0007); server-side expiry.
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Completed/cutoff timestamps (server clock, not client).
  completed_at   timestamptz,
  -- Number of items that scored points (maintained by scoring transaction).
  points_earned  integer NOT NULL DEFAULT 0 CHECK (points_earned >= 0),
  -- Maximum possible score for this attempt (set at creation = count of score_eligible items × 5).
  max_points     integer NOT NULL DEFAULT 0 CHECK (max_points >= 0)
);

CREATE INDEX challenge_attempts_user_week_idx
  ON challenge_attempts (user_id, challenge_week);
CREATE INDEX challenge_attempts_week_status_idx
  ON challenge_attempts (challenge_week, status);
-- Prevent >1 active (in_progress) attempt per user per week.
CREATE UNIQUE INDEX challenge_attempts_active_week_unique
  ON challenge_attempts (user_id, challenge_week)
  WHERE status = 'in_progress';

-- =========================================================================
-- 2. challenge_attempt_items: frozen 10-row question snapshot per attempt.
--    These are immutable facts; scoring reads from this snapshot, never from
--    the live release/lexical_entry tables.
-- =========================================================================
CREATE TABLE challenge_attempt_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id       uuid NOT NULL REFERENCES challenge_attempts (id) ON DELETE CASCADE,
  position         integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  direction        text NOT NULL CHECK (direction IN ('en_to_zh', 'zh_to_en')),
  question_type    text NOT NULL CHECK (question_type IN ('choice', 'spelling')),
  lexical_entry_id uuid NOT NULL,
  -- Frozen course-specific meaning (approved meaning from the release snapshot).
  english_spelling text NOT NULL,
  meaning          text NOT NULL,
  -- Server-computed correct answer (choice = meaning text; spelling = english_spelling).
  server_answer    text NOT NULL,
  -- Whether this item is eligible for scoring (user had a learning_exposure for this lexical_entry).
  score_eligible   boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, position)
);

CREATE INDEX challenge_attempt_items_attempt_idx
  ON challenge_attempt_items (attempt_id);

-- =========================================================================
-- 3. challenge_answers: immutable per-question answer fact.
--    One row per (attempt, position); idempotent by (attempt_id, position).
-- =========================================================================
CREATE TABLE challenge_answers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id     uuid NOT NULL REFERENCES challenge_attempts (id) ON DELETE CASCADE,
  position       integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  -- Client idempotency key (identity, not a secret; same pattern as xp_entries.source_event_id).
  client_event_id text NOT NULL CHECK (length(client_event_id) BETWEEN 1 AND 200),
  -- Client's submitted answer (raw; normalized comparison done server-side).
  client_answer  text NOT NULL,
  -- Server-graded result.
  is_correct     boolean NOT NULL,
  points_awarded integer NOT NULL CHECK (points_awarded >= 0),
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, position)
);

CREATE INDEX challenge_answers_attempt_idx
  ON challenge_answers (attempt_id);

-- =========================================================================
-- 4. challenge_point_entries: ALTER to add word-direction dedup columns.
--    The existing UNIQUE (source_attempt_id, rule_version) is preserved.
--    A new partial unique index enforces ADR-0007's cross-course dedup:
--    (user_id, challenge_week, lexical_entry_id, direction) WHERE reason = 'first_correct_answer'.
-- =========================================================================
ALTER TABLE challenge_point_entries
  ADD COLUMN lexical_entry_id uuid,
  ADD COLUMN direction text;

-- Validate direction values (same enum as learning_cards).
ALTER TABLE challenge_point_entries
  ADD CONSTRAINT challenge_point_entries_direction_check
  CHECK (direction IN ('en_to_zh', 'zh_to_en'));

-- For first_correct_answer entries, both lexical_entry_id and direction are required.
ALTER TABLE challenge_point_entries
  ADD CONSTRAINT challenge_point_entries_word_direction_nn
  CHECK (
    (reason = 'first_correct_answer' AND lexical_entry_id IS NOT NULL AND direction IS NOT NULL)
    OR (reason <> 'first_correct_answer')
  );

-- FK to the attempt that generated this point entry.  NOTE: we intentionally do
-- NOT add a DB-level FK on source_attempt_id -> challenge_attempts: the seam
-- table allowed arbitrary source attempt ids (Ticket 09 put no FK there), and
-- existing integrations/manual seam fixtures insert random UUIDs.  The semantic
-- coupling (points <- attempt) is enforced at the application layer; the word-
-- direction dedup index below is the real cross-course integrity boundary.

-- ADR-0007: first-correct-per-(user, week, lexical, direction) dedup (partial unique).
CREATE UNIQUE INDEX challenge_point_word_direction_dedup
  ON challenge_point_entries (user_id, challenge_week, lexical_entry_id, direction)
  WHERE reason = 'first_correct_answer';

-- Index for the scoring query that checks "has this user already scored this word/direction this week".
CREATE INDEX challenge_point_entries_user_week_word_idx
  ON challenge_point_entries (user_id, challenge_week, lexical_entry_id, direction);

-- =========================================================================
-- 5. Append-only triggers (same pattern as 0035).
-- =========================================================================
CREATE TRIGGER challenge_attempts_no_update
  BEFORE UPDATE ON challenge_attempts
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();
CREATE TRIGGER challenge_attempts_no_delete
  BEFORE DELETE ON challenge_attempts
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();

CREATE TRIGGER challenge_attempt_items_no_update
  BEFORE UPDATE ON challenge_attempt_items
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();
CREATE TRIGGER challenge_attempt_items_no_delete
  BEFORE DELETE ON challenge_attempt_items
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();

CREATE TRIGGER challenge_answers_no_update
  BEFORE UPDATE ON challenge_answers
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();
CREATE TRIGGER challenge_answers_no_delete
  BEFORE DELETE ON challenge_answers
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();
