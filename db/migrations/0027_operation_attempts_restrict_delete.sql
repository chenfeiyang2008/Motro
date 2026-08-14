-- 0027_operation_attempts_restrict_delete
-- 阶段 6 工单 04 修复（P1-3）：attempt append-only 审计事实不得被级联删除。
--
-- 背景：0025 里 application_operation_attempts.operation_id 使用 ON DELETE CASCADE，
-- 意味着删除 operation 会级联删除其 attempt 审计事实。工单 04 明确要求 attempt 是
-- append-only 审计事实，任何业务清理都不能删除它们。
--
-- 本 migration 只追加（不改写 0001–0026）：
--   1) 删除 0025 的 CASCADE 外键，改为 ON DELETE RESTRICT；
--   2) 保留 0026 的 attempt 不可变触发器（UPDATE/DELETE 已完成 attempt 继续拒绝）；
--   3) 不修改任何 0001–0026 已应用的内容。
--
-- 独立 E2E 数据库可以通过整体销毁（DROP DATABASE）清理；共享库严禁绕过约束删除。

-- 1) 删除 0025 内联外键（Postgres 自动命名 <table>_<column>_fkey），改为 RESTRICT。
ALTER TABLE application_operation_attempts
  DROP CONSTRAINT application_operation_attempts_operation_id_fkey;

ALTER TABLE application_operation_attempts
  ADD CONSTRAINT application_operation_attempts_operation_id_fkey
  FOREIGN KEY (operation_id) REFERENCES application_operations (id) ON DELETE RESTRICT;

-- 2) 显式验证 attempt 完整性触发器全部启用（防未来误禁）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'application_operation_attempts_no_update_after_completion'
      AND tgrelid = 'application_operation_attempts'::regclass
  ) THEN
    RAISE EXCEPTION '0027: application_operation_attempts_no_update_after_completion 触发器缺失';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'application_operation_attempts_no_delete'
      AND tgrelid = 'application_operation_attempts'::regclass
  ) THEN
    RAISE EXCEPTION '0027: application_operation_attempts_no_delete 触发器缺失';
  END IF;
END $$;
