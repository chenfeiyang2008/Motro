-- 0002_auth_idempotency
-- 幂等键表：账号创建/重置等写操作的幂等边界（scope + key 唯一）。

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at);
