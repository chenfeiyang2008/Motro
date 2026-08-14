-- 0030_application_operation_status_transition_guard
-- 阶段 6 工单 04 收口：application_operations 状态跃迁的数据库最终防线。
--
-- 0025 只限制 status 的枚举与局部时间不变量；应用层的 operation-state.ts 已定义合法
-- 状态机。此 migration 把同一转换表复制到 PostgreSQL trigger，避免直接 SQL、未来服务
-- 或故障恢复路径把终态/运行态非法倒退。允许 status 未变的诊断字段更新。
--
-- 只追加，不改写 0001–0029。

CREATE OR REPLACE FUNCTION motro_guard_application_operation_status_transition()
RETURNS trigger AS $$
BEGIN
  -- 同状态更新（例如续租、更新错误摘要、刷新 graphile_job_id）不是状态迁移。
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'queued' AND NEW.status IN ('running', 'succeeded', 'failed'))
     OR (OLD.status = 'running' AND NEW.status IN ('retry_wait', 'succeeded', 'failed', 'manual_action'))
     OR (OLD.status = 'retry_wait' AND NEW.status IN ('running', 'queued'))
     OR (OLD.status IN ('failed', 'manual_action') AND NEW.status = 'queued') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'application operation status transition is invalid: % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_operations_status_transition_guard
  BEFORE UPDATE OF status ON application_operations
  FOR EACH ROW
  EXECUTE FUNCTION motro_guard_application_operation_status_transition();
