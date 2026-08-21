-- 0045_membership_daily_limit
-- Per-user non-member daily study-time policy.  This is a mutable policy
-- projection; the membership_audit row records every administrator change.
ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS free_daily_limit_minutes integer NOT NULL DEFAULT 15;

ALTER TABLE memberships
  DROP CONSTRAINT IF EXISTS memberships_free_daily_limit_minutes_check;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_free_daily_limit_minutes_check
  CHECK (free_daily_limit_minutes BETWEEN 0 AND 1440);

ALTER TABLE membership_audit
  ADD COLUMN IF NOT EXISTS daily_limit_minutes integer;

ALTER TABLE membership_audit
  DROP CONSTRAINT IF EXISTS membership_audit_action_check;

ALTER TABLE membership_audit
  ADD CONSTRAINT membership_audit_action_check
  CHECK (action IN ('grant', 'renew', 'revoke', 'daily_limit'));

ALTER TABLE membership_audit
  DROP CONSTRAINT IF EXISTS membership_audit_daily_limit_minutes_check;

ALTER TABLE membership_audit
  ADD CONSTRAINT membership_audit_daily_limit_minutes_check
  CHECK (daily_limit_minutes IS NULL OR daily_limit_minutes BETWEEN 0 AND 1440);

CREATE INDEX IF NOT EXISTS memberships_free_daily_limit_idx
  ON memberships (free_daily_limit_minutes);
