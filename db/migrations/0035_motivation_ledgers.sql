-- 0035_motivation_ledgers
-- Ticket 09 XP / Challenge Points / weekly leaderboard foundation (internal facts only).
--
-- This migration establishes the *facts* layer for personal XP and Challenge
-- Points, plus a rebuildable weekly leaderboard projection.  It does NOT create
-- any learner-visible UI, quiz engine, provider, or fake ranking data.
--
-- Security / product invariants enforced here:
--   - XP and Challenge Points live in SEPARATE ledgers.  Daily study XP never
--     feeds a public rank; only Challenge Points do (ADR-0007).
--   - xp_entries / challenge_point_entries are INSERT-only (BEFORE UPDATE/DELETE
--     triggers RAISE).  Corrections append a compensating entry; nothing is
--     ever rewritten.
--   - A given source fact may be awarded XP at most once per rule_version
--     (UNIQUE).  Replay of the same event cannot double-award.
--   - amount is never negative in ordinary award entries; compensation entries
--     are allowed only with an explicit reason and are validated in application
--     (negative amounts require reason IN ('correction','void') and a
--     references_xp_entry).
--   - rule_version participates in uniqueness so a rule upgrade never
--     recomputes old facts under a new version.
--   - We do NOT store: prompt, provider raw payload, session token, storage
--     path, full raw error, request hash, or internal idempotency keys on
--     public-facing rows.  Only safe summaries.
--
-- Challenge Points are a SEAM: no quiz/attempt/snapshot tables exist yet.
-- challenge_point_entries is populated only by a future Challenge ticket that
-- produces server-confirmed score facts.  It is never filled by study
-- review_events (ADR-0007: daily XP and challenge points are disjoint).

-- Versioned rule sets: the canonical source of XP amount / threshold / point
-- rules.  A new rule_version changes future awards only; history is not
-- rewritten.
CREATE TABLE game_rule_sets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_version integer NOT NULL UNIQUE CHECK (rule_version >= 1),
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  effective_at timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'retired')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed rule set v1 (recommended defaults per Ticket 09 spec §4):
--   xp per eligible review event = 5, no daily cap, reveal earns 0.
INSERT INTO game_rule_sets (rule_version, label, effective_at, status, configuration)
VALUES (
  1,
  'motro-v1-xp',
  now(),
  'active',
  '{"xpPerEligibleReviewEvent":5,"xpReveal":0,"dailyXpCap":null,"levelThresholds":[0,50,150,350,700,1200,2000]}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Personal XP ledger (append-only, per-user, disjoint from Challenge Points).
-- ---------------------------------------------------------------------------
CREATE TABLE xp_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- The immutable review event that earned this XP.  RESTRICT keeps review
  -- events from being deleted while they back XP.
  review_event_id  uuid NOT NULL REFERENCES review_events (id) ON DELETE RESTRICT,
  rule_version     integer NOT NULL REFERENCES game_rule_sets (rule_version) ON DELETE RESTRICT,
  amount           integer NOT NULL CHECK (amount <> 0),
  reason           text NOT NULL CHECK (reason IN
                    ('initial_review', 'due_review', 'correction', 'void')),
  -- References the original xp_entry for correction/void entries only.
  references_xp_entry uuid REFERENCES xp_entries (id) ON DELETE RESTRICT,
  -- Client idempotency key for the review intent (safe summary, not a hash).
  source_event_id  text NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 200),
  earned_at        timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- A correction/void entry must reference another entry.
  CHECK (
    (reason = 'correction' OR reason = 'void') = (references_xp_entry IS NOT NULL)
  ),
  -- Ordinary awards are positive; only correction/void may carry negative amount.
  CHECK (
    (amount > 0) OR (reason IN ('correction', 'void') AND amount < 0)
  )
);

-- Dedup on ordinary awards only: a given event + rule_version yields one XP row.
-- Corrections/voids (references_xp_entry NOT NULL) may reference a prior base by
-- reusing the same event+rule without colliding.
CREATE UNIQUE INDEX xp_entries_review_event_rule_dedup
  ON xp_entries (review_event_id, rule_version) WHERE references_xp_entry IS NULL;

CREATE INDEX xp_entries_user_created_idx ON xp_entries (user_id, created_at DESC);
CREATE INDEX xp_entries_review_event_idx ON xp_entries (review_event_id);
CREATE INDEX xp_entries_user_earned_idx ON xp_entries (user_id, earned_at DESC);

-- ---------------------------------------------------------------------------
-- Challenge Points ledger (append-only, SEAM).  Populated only by a future
-- server-confirmed Challenge ticket.  Never filled by study review events.
-- ---------------------------------------------------------------------------
CREATE TABLE challenge_point_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  challenge_week   text NOT NULL CHECK (length(challenge_week) BETWEEN 1 AND 40),
  -- The immutable quiz/attempt fact that earned these points.  Kept generic
  -- (uuid reference) as a SEAM: the challenge tables arrive in a later ticket.
  source_attempt_id uuid NOT NULL,
  rule_version     integer NOT NULL REFERENCES game_rule_sets (rule_version) ON DELETE RESTRICT,
  amount           integer NOT NULL CHECK (amount > 0),
  reason           text NOT NULL CHECK (reason IN
                    ('first_correct_answer', 'adjustment', 'void')),
  references_point_entry uuid REFERENCES challenge_point_entries (id) ON DELETE RESTRICT,
  awarded_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- A given attempt/word-direction fact is awarded at most once per rule_version.
  UNIQUE (source_attempt_id, rule_version),
  -- Adjustments/voids must reference an existing entry.
  CHECK (
    (reason = 'adjustment' OR reason = 'void') = (references_point_entry IS NOT NULL)
  )
);

CREATE INDEX challenge_point_entries_user_week_idx
  ON challenge_point_entries (user_id, challenge_week);
CREATE INDEX challenge_point_entries_week_idx
  ON challenge_point_entries (challenge_week, awarded_at DESC);

-- ---------------------------------------------------------------------------
-- Rebuildable weekly leaderboard projection.
--
-- A projection, not a source of truth: any corruption is repaired by
-- rebuilding from challenge_point_entries.  Visibility default = public
-- (opt-out per user), disabled users are excluded, only display_name is
-- exposed (never username/user_id/email/session).
-- ---------------------------------------------------------------------------
CREATE TABLE weekly_leaderboard_projection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_week  text NOT NULL CHECK (length(challenge_week) BETWEEN 1 AND 40),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  total_challenge_points integer NOT NULL CHECK (total_challenge_points >= 0),
  -- Deterministic tie-break: points DESC, first_reached_at ASC, user_id ASC.
  first_reached_at timestamptz,
  rank            integer NOT NULL CHECK (rank >= 1),
  is_public       boolean NOT NULL DEFAULT true,
  rebuilt_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (challenge_week, user_id)
);

CREATE INDEX weekly_leaderboard_projection_week_rank_idx
  ON weekly_leaderboard_projection (challenge_week, rank ASC);
CREATE INDEX weekly_leaderboard_projection_week_points_idx
  ON weekly_leaderboard_projection (challenge_week, total_challenge_points DESC);

-- Per-user leaderboard visibility preference (default public; opt-out via
-- POST /leaderboard/visibility).  A user who opts out keeps their points/rank
-- privately but their row is not shown on the public board.
CREATE TABLE leaderboard_preferences (
  user_id         uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  is_public       boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Immutability: ledgers are INSERT-only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION motro_reject_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'motivation ledger facts are immutable (update/delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER xp_entries_no_update
  BEFORE UPDATE ON xp_entries
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();
CREATE TRIGGER xp_entries_no_delete
  BEFORE DELETE ON xp_entries
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();

CREATE TRIGGER challenge_point_entries_no_update
  BEFORE UPDATE ON challenge_point_entries
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();
CREATE TRIGGER challenge_point_entries_no_delete
  BEFORE DELETE ON challenge_point_entries
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();

-- Leaderboard projection is rebuildable, so it may be updated/deleted by a
-- rebuild (upsert) — but no trigger is needed: it is a derived read model.
