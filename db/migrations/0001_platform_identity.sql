-- 0001_platform_identity
-- 平台身份/会话基础结构：管理员与学习者账号、会话与审计。
-- 不含任何业务领域表（无课程、词条、学习、FSRS、XP、挑战、导入或补全）。

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'learner'
    CHECK (role IN ('learner', 'admin')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  timezone text NOT NULL,
  daily_budget_minutes integer NOT NULL DEFAULT 10
    CHECK (daily_budget_minutes BETWEEN 1 AND 120),
  password_hash text NOT NULL,
  password_version integer NOT NULL DEFAULT 1,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_username_unique ON users (username);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  client_summary jsonb
);

CREATE UNIQUE INDEX auth_sessions_token_digest_unique ON auth_sessions (token_digest);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (absolute_expires_at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users (id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before_summary jsonb,
  after_summary jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_actor_id_idx ON audit_events (actor_id);
CREATE INDEX audit_events_created_at_idx ON audit_events (created_at DESC);
