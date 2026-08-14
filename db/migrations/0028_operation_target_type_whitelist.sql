-- 0028_operation_target_type_whitelist
-- 阶段 6 工单 04 收口（P2-1）：为 application_operations.target_type 增加数据库级白名单校验。
--
-- 背景：target_type 描述 operation 的目标实体类型。当前仅存在 import_batch_commit_row
-- （导入批次提交行触发的 operation）。本 migration 增加数据库 CHECK 白名单，防止
-- 未来写入未知/拼写错误的目标类型。
--
-- 本 migration 只追加，不改写 0001–0027。
-- 若未来新增类型，必须在此追加 migration 白名单扩充（不得改写已应用 migration）。
ALTER TABLE application_operations
  ADD CONSTRAINT application_operations_target_type_whitelist
  CHECK (target_type IN ('import_batch_commit_row'));