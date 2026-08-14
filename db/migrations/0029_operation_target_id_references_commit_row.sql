-- 0029_operation_target_id_references_commit_row
-- 阶段 6 工单 04 复核（P1-4）：application_operations.target_id 数据库引用完整性。
--
-- 背景：0028 已把 application_operations.target_type 白名单限制为唯一的
-- import_batch_commit_row。因此目标实体类型唯一，target_id 必须引用
-- import_batch_commit_rows(id)。
--
-- 本 migration 只追加（不改写 0001–0028）：
--   - 为 application_operations.target_id 增加到 import_batch_commit_rows(id) 的
--     ON DELETE RESTRICT 外键（删除被 operation 引用的 commit row 会被拒绝）；
--   - 结合 0028 的 target_type CHECK（仅 import_batch_commit_row），保证
--     target_type=import_batch_commit_row ⇒ target_id 引用真实 commit row；
--   - target_type 与 target_id 不匹配在结构上不可能（唯一白名单类型）。
--
-- 约束：不修改 0001–0028；不使用 session_replication_role / DISABLE TRIGGER；
-- 独立 E2E 数据库通过整体销毁清理，共享库严禁绕过约束删除。

ALTER TABLE application_operations
  ADD CONSTRAINT application_operations_target_id_fkey
  FOREIGN KEY (target_id) REFERENCES import_batch_commit_rows (id) ON DELETE RESTRICT;
