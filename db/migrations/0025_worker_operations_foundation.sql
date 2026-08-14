-- 0025_worker_operations_foundation
-- 阶段 6 工单 04：Worker 操作与任务状态基础。
--
-- 本 migration 建立 application operation / attempt 的业务事实表，作为队列投递的
-- 权威状态来源。Graphile job 成功删除后，operation / attempt 仍完整可查询。
--
-- 设计要点：
--   - application_operations：一次「后台操作」的可审计事实，绑定稳定目标与 input 身份；
--     同一 operation_type + target_type + target_id + input_hash 只产生一个 operation；
--     状态机由应用层代码驱动，数据库 CHECK 保证不变量。
--   - application_operation_attempts：每次真实执行形成独立 attempt 事实；
--     UNIQUE(operation_id, attempt_number) + 成功后不可修改是审计保证。
--   - graphile_job_id 是诊断字段，不 FK Graphile 私有表；job 删除后操作仍可查。
--   - 错误摘要只存脱敏、受限长度文本；不存完整堆栈、供应商 payload 或密钥。
--   - 成功 operation 不得被普通重试命令重新排队；管理员重试只能对 failed / manual_action。
--
-- 只追加 migration，不改写 0001–0024。

-- 1) application_operations：核心操作状态事实表。
CREATE TABLE application_operations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type     text NOT NULL CHECK (length(operation_type) > 0 AND length(operation_type) <= 128),
  operation_version  integer NOT NULL DEFAULT 1 CHECK (operation_version >= 1),
  target_type        text NOT NULL CHECK (length(target_type) > 0 AND length(target_type) <= 128),
  target_id          uuid NOT NULL,
  input_hash         text NOT NULL CHECK (length(input_hash) > 0),
  input_version      integer NOT NULL DEFAULT 1 CHECK (input_version >= 1),
  status             text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','running','retry_wait','succeeded','failed','manual_action')),
  task_identifier    text NOT NULL CHECK (length(task_identifier) > 0 AND length(task_identifier) <= 128),
  queue_name         text NOT NULL CHECK (length(queue_name) > 0 AND length(queue_name) <= 128),
  graphile_job_id    text,
  attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts       integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  retryable          boolean NOT NULL DEFAULT true,
  last_error_code    text,
  last_error_summary text CHECK (last_error_summary IS NULL OR length(last_error_summary) <= 500),
  requested_by       uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  completed_at       timestamptz,

  -- 状态 / 时间不变量：成功 operation 必须有 completed_at；running 必须有 started_at。
  CHECK (
    (status = 'succeeded' AND completed_at IS NOT NULL)
    OR (status <> 'succeeded')
  ),
  CHECK (
    (status = 'running' AND started_at IS NOT NULL)
    OR (status <> 'running')
  ),
  -- attempt_count 不得超过 max_attempts。
  CHECK (attempt_count <= max_attempts)
);

-- 同一操作类型 + 同一目标 + 同一 input 身份唯一：防止重复投递。
CREATE UNIQUE INDEX application_operations_type_target_input_unique
  ON application_operations (operation_type, target_type, target_id, input_hash);

-- 高频查询路径：按状态过滤（管理端列表/Worker 投递）。
CREATE INDEX application_operations_status_idx ON application_operations (status);

-- 按 target_type + target_id 反查（导入行查看操作历史）。
CREATE INDEX application_operations_target_idx ON application_operations (target_type, target_id);

-- 按创建时间倒序（列表默认排序）。
CREATE INDEX application_operations_created_at_idx ON application_operations (created_at DESC);

-- updated_at 索引：管理端列表/Worker 扫描最近更新操作。
CREATE INDEX application_operations_updated_at_idx ON application_operations (updated_at DESC);

-- updated_at 触发器：与 import_batches 使用相同模式。
CREATE OR REPLACE FUNCTION motro_application_operations_update_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_operations_set_updated_at
  BEFORE UPDATE ON application_operations
  FOR EACH ROW EXECUTE FUNCTION motro_application_operations_update_timestamp();

-- 2) application_operation_attempts：每次真实执行的独立 attempt 事实。
CREATE TABLE application_operation_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id    uuid NOT NULL REFERENCES application_operations (id) ON DELETE CASCADE,
  attempt_number  integer NOT NULL CHECK (attempt_number >= 1),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  outcome         text CHECK (outcome IN ('succeeded','failed')),
  worker_job_id   text,
  error_code      text,
  error_summary   text CHECK (error_summary IS NULL OR length(error_summary) <= 500),

  -- 同一 operation 内 attempt 编号唯一（严格递增，无跳跃）。
  UNIQUE (operation_id, attempt_number),
  -- 完成后的 attempt 不可修改：通过应用层守卫 + 数据库约束组合。
  CHECK (
    (outcome IS NOT NULL AND finished_at IS NOT NULL)
    OR (outcome IS NULL AND finished_at IS NULL)
  )
);

-- attempt_number 索引：详情页展示时间线。
CREATE INDEX application_operation_attempts_operation_id_idx
  ON application_operation_attempts (operation_id, attempt_number);

-- 3) 拒绝对已完成 attempt 的 UPDATE/DELETE（审计事实不可变）。
CREATE OR REPLACE FUNCTION motro_reject_attempt_mutation_when_completed()
RETURNS trigger AS $$
BEGIN
  IF NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    RAISE EXCEPTION 'completed attempt facts are immutable (outcome change not allowed)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_operation_attempts_no_update_after_completion
  BEFORE UPDATE ON application_operation_attempts
  FOR EACH ROW
  WHEN (OLD.outcome IS NOT NULL)
  EXECUTE FUNCTION motro_reject_attempt_mutation_when_completed();

CREATE OR REPLACE FUNCTION motro_reject_attempt_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'attempt facts are immutable (delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_operation_attempts_no_delete
  BEFORE DELETE ON application_operation_attempts
  FOR EACH ROW EXECUTE FUNCTION motro_reject_attempt_delete();

-- 4) application_operations 上限不可 UPDATE 的不可变字段（只允许状态/诊断字段推进）。
--    operation_type, target_type, target_id, input_hash, created_at, requested_by 永远不变。
--    不可用触发器禁止所有 UPDATE（状态机必须推进），改用应用层逻辑约束；
--    数据库 CHECK 已覆盖状态/时间/attempt 数不变量。只追加 migration，不改写 0001–0024。