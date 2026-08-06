-- 0008_idempotency_resource_id
-- 幂等记录增加可关联的资源 ID：发布事务把 release_id 写入 resource_id，
-- 使同 key 恢复能唯一确定其对应的 release，避免按 (course, draft_version) 误匹配其他版本。

ALTER TABLE idempotency_keys
  ADD COLUMN resource_id text;
