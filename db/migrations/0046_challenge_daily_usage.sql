-- 0046_challenge_daily_usage
-- Allow challenge answers to accrue toward the non-member daily study-time budget.
--
-- The daily_usage table was initially tightly coupled to review_events (NOT NULL FK).
-- To let challenge answers also count toward the 15-minute free-user budget, we:
--   1. Make review_event_id nullable (challenge rows set challenge_answer_id instead)
--   2. Add source_type discriminator ('review' | 'challenge_answer')
--   3. Add challenge_answer_id with a partial UNIQUE index
--   4. Add a CHECK ensuring exactly one of the two FKs is set

-- Make review_event_id nullable.
ALTER TABLE daily_usage
  ALTER COLUMN review_event_id DROP NOT NULL;

-- Add source_type discriminator.
ALTER TABLE daily_usage
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'review';

ALTER TABLE daily_usage
  DROP CONSTRAINT IF EXISTS daily_usage_source_type_check;
ALTER TABLE daily_usage
  ADD CONSTRAINT daily_usage_source_type_check
  CHECK (source_type IN ('review', 'challenge_answer'));

-- Add challenge_answer_id FK.
ALTER TABLE daily_usage
  ADD COLUMN IF NOT EXISTS challenge_answer_id uuid;

ALTER TABLE daily_usage
  DROP CONSTRAINT IF EXISTS daily_usage_challenge_answer_id_fkey;
ALTER TABLE daily_usage
  ADD CONSTRAINT daily_usage_challenge_answer_id_fkey
  FOREIGN KEY (challenge_answer_id)
  REFERENCES challenge_answers (id)
  ON DELETE RESTRICT;

-- Idempotency: a given challenge answer is accrued at most once per user.
-- Partial UNIQUE so review rows (challenge_answer_id NULL) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS daily_usage_challenge_answer_unique
  ON daily_usage (user_id, challenge_answer_id)
  WHERE challenge_answer_id IS NOT NULL;

-- Cross-check: exactly one of review_event_id / challenge_answer_id is set.
ALTER TABLE daily_usage
  DROP CONSTRAINT IF EXISTS daily_usage_source_exclusive_check;
ALTER TABLE daily_usage
  ADD CONSTRAINT daily_usage_source_exclusive_check
  CHECK (
    (source_type = 'review' AND review_event_id IS NOT NULL AND challenge_answer_id IS NULL)
    OR
    (source_type = 'challenge_answer' AND challenge_answer_id IS NOT NULL AND review_event_id IS NULL)
  );
