-- 0003_auth_hardening
-- 一次性密码消费标记 + 幂等请求语义哈希。

ALTER TABLE users
  ADD COLUMN otp_consumed boolean NOT NULL DEFAULT false;

ALTER TABLE idempotency_keys
  ADD COLUMN request_hash text NOT NULL DEFAULT '';
