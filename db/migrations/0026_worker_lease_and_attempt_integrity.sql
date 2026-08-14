-- 0026_worker_lease_and_attempt_integrity
-- 阶段 6 工单 04 关键修复：claim/lease 模型 + attempt 不可变性强化。
--
-- 本 migration 只追加，不改写 0001–0025。
--
-- 1) claim/lease：application_operations 增加持久化、可恢复的 claim 身份。
--    - claim_token：不透明 worker claim 身份（重复 job 校验归属）；
--    - lease_owner：worker/进程标识（诊断）；
--    - lease_expires_at：租约到期时间。worker 崩溃后 operation 保持 running 直到
--      lease 到期，随后允许安全重领；过期 worker 不得覆盖新 claim 的状态。
--
-- 2) attempt outcome 扩展：允许 abandoned / expired（lease 重领时标记旧 running attempt），
--    它不是成功或失败的伪装，而是一个独立的审计事实。
--
-- 3) attempt 不可变性强化：0025 只禁止修改 outcome；本 migration 改为：
--    - 已完成 attempt（outcome IS NOT NULL）：任何 UPDATE 一律拒绝；
--    - 完成 attempt 的 DELETE 一律拒绝（0025 已建，保留）；
--    - running attempt：身份字段（operation_id / attempt_number / started_at）不可变；
--    - running attempt 完成转换必须一次写齐 outcome + finished_at（一致性由 trigger 保证）；
--    - running attempt 未完成时不得写入完成字段（worker_job_id 在 INSERT 时写入，见 0025 语义）。

-- 1) lease 列。
ALTER TABLE application_operations
  ADD COLUMN claim_token text,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz;

-- 2) attempt outcome 扩展：abandoned / expired。
ALTER TABLE application_operation_attempts
  DROP CONSTRAINT application_operation_attempts_outcome_check;
ALTER TABLE application_operation_attempts
  ADD CONSTRAINT application_operation_attempts_outcome_check
  CHECK (outcome IN ('succeeded', 'failed', 'abandoned', 'expired'));

-- 3) 强化 attempt 不可变性触发器（替换 0025 的弱版）。
DROP TRIGGER application_operation_attempts_no_update_after_completion
  ON application_operation_attempts;

CREATE OR REPLACE FUNCTION motro_guard_attempt_updates()
RETURNS trigger AS $$
BEGIN
  -- 已完成 attempt 完全不可变：任何 UPDATE 一律拒绝。
  IF OLD.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'completed attempt facts are immutable (update not allowed)';
  END IF;

  -- running attempt：身份字段不可变。
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'running attempt identity fields are immutable';
  END IF;

  -- running → 完成转换必须一次写齐 outcome + finished_at。
  IF NEW.outcome IS NOT NULL THEN
    IF NEW.finished_at IS NULL THEN
      RAISE EXCEPTION 'completing attempt requires finished_at';
    END IF;
  ELSE
    -- 仍是 running：不允许写完成字段（worker_job_id 在 INSERT 时写入）。
    IF NEW.finished_at IS NOT NULL
       OR NEW.worker_job_id IS NOT NULL
       OR NEW.error_code IS NOT NULL
       OR NEW.error_summary IS NOT NULL THEN
      RAISE EXCEPTION 'running attempt cannot set completion fields before outcome';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_operation_attempts_no_update_after_completion
  BEFORE UPDATE ON application_operation_attempts
  FOR EACH ROW EXECUTE FUNCTION motro_guard_attempt_updates();

-- 4) 索引：按 lease 到期时间查找可重领的 running operation（低频恢复扫描）。
CREATE INDEX application_operations_lease_expiry_idx
  ON application_operations (lease_expires_at)
  WHERE status = 'running';