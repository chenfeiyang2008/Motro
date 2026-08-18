-- 0038_account_membership_and_daily_usage
-- Ticket 20 · Account / Membership foundation + non-member daily study-time limit.
--
-- This migration is NOT a payment system. It adds an intranet membership state
-- and a server-side limit on accrued effective study time for non-members.
-- It deliberately does NOT add: Stripe/WeChat/Alipay, orders, coupons, trials,
-- auto-renewal, or payment secrets.
--
-- Product invariants (enforced here + in application code):
--   - Effective membership status is computed SERVER-SIDE. A row whose
--     expires_at < now is immediately treated as 'expired' → free limits.
--   - No row / dirty data / expired / unknown → fail-closed to free limits.
--   - 'member' in status='active' with not-yet-expired expires_at = unlimited
--     daily study time. On expiry the very next server judgment restores free.
--   - Membership is entirely separate from users.role, XP, leaderboard, and
--     users.daily_budget_minutes (which remains the study-plan/course budget).
--   - Admin grant/renew/revoke is permission-checked, idempotent, audited via
--     append-only membership_audit.
--   - We never store payment card numbers, payment keys, or provider raw text.
--   - Immutability is enforced by BEFORE UPDATE/DELETE triggers (append-only).
--     Nothing is bypassed with session_replication_role / DISABLE TRIGGER.

-- ---------------------------------------------------------------------------
-- membership grants (one row per user, the *authoritative entitlement fact*).
-- 'free' plan rows may exist but carry no duration; effective status for the
-- free plan is always 'free'. A 'member' row is 'active' only while
-- expires_at is null (indefinite) or >= now.
-- ---------------------------------------------------------------------------
CREATE TABLE memberships (
  user_id   uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  plan      text NOT NULL CHECK (plan IN ('member', 'free')),
  status    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  -- Base grant timestamp (created_at is the row's immutable creation time).
  started_at timestamptz NOT NULL DEFAULT now(),
  -- NULL = indefinite. Non-null expired-at ≥ started_at enforced below.
  expires_at timestamptz,
  -- Timezone snapshot used for entitlement's local-day boundary, copied from
  -- the user at grant time. Effective day boundary defers to users.timezone.
  timezone  text NOT NULL DEFAULT 'Asia/Shanghai',
  -- Last applied action + actor for human-readable audit complement.
  last_action text NOT NULL DEFAULT 'grant' CHECK (last_action IN ('grant', 'renew', 'revoke')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memberships_expires_idx ON memberships (expires_at);
CREATE INDEX memberships_plan_idx ON memberships (plan);

-- ---------------------------------------------------------------------------
-- membership_audit: append-only, immutable change record.
-- actor_id references who performed the admin grant/renew/revoke.
-- ---------------------------------------------------------------------------
CREATE TABLE membership_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  actor_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  action        text NOT NULL CHECK (action IN ('grant', 'renew', 'revoke')),
  plan          text NOT NULL CHECK (plan IN ('member', 'free')),
  started_at    timestamptz NOT NULL,
  expired_at    timestamptz,
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX membership_audit_user_id_idx ON membership_audit (user_id, created_at DESC);
CREATE INDEX membership_audit_actor_id_idx ON membership_audit (actor_id);

CREATE OR REPLACE FUNCTION motro_reject_membership_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'membership_audit facts are immutable (update/delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER membership_audit_no_update
  BEFORE UPDATE ON membership_audit
  FOR EACH ROW EXECUTE FUNCTION motro_reject_membership_audit_mutation();
CREATE TRIGGER membership_audit_no_delete
  BEFORE DELETE ON membership_audit
  FOR EACH ROW EXECUTE FUNCTION motro_reject_membership_audit_mutation();

-- ---------------------------------------------------------------------------
-- daily_usage: append-only per-user daily accrued study-time (minutes).
-- Only accepted review events accrue minutes (a real, accepted learning
-- activity). src event id + user + local-day enforces idempotency: replay of
-- the same client event can never double-accrue.
--
-- minutes_accrued is fractional (float) minutes computed from a fixed per-card
-- duration. It is explicitly NOT request-count.
-- ---------------------------------------------------------------------------
CREATE TABLE daily_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  local_day     text NOT NULL CHECK (length(local_day) = 10), -- YYYY-MM-DD
  -- The IMMUTABLE review event that accrued this usage. RESTRICT keeps review
  -- events from being deleted while they back usage.
  review_event_id uuid NOT NULL REFERENCES review_events (id) ON DELETE RESTRICT,
  -- Client idempotency key (safe summary, not a token).
  source_event_id text NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 200),
  minutes_accrued numeric NOT NULL CHECK (minutes_accrued > 0),
  accrued_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A given review event is accrued at most once per user.
  UNIQUE (user_id, review_event_id)
);

CREATE INDEX daily_usage_user_day_idx ON daily_usage (user_id, local_day);
CREATE INDEX daily_usage_user_created_idx ON daily_usage (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION motro_reject_daily_usage_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'daily_usage facts are immutable (update/delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER daily_usage_no_update
  BEFORE UPDATE ON daily_usage
  FOR EACH ROW EXECUTE FUNCTION motro_reject_daily_usage_mutation();
CREATE TRIGGER daily_usage_no_delete
  BEFORE DELETE ON daily_usage
  FOR EACH ROW EXECUTE FUNCTION motro_reject_daily_usage_mutation();