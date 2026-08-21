-- 0043_challenge_attempt_state
-- Ticket 14 follow-up: challenge_attempts is a mutable session projection.
-- Its points/status/expiry fields are updated by the scoring service; only the
-- answer and points ledgers are append-only facts.  The original 0037 triggers
-- were therefore incorrect and also prevented expired attempts from being
-- closed before a new weekly attempt was created.
DROP TRIGGER IF EXISTS challenge_attempts_no_update ON challenge_attempts;
DROP TRIGGER IF EXISTS challenge_attempts_no_delete ON challenge_attempts;
