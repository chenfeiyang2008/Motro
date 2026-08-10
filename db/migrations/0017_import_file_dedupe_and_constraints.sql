-- 0017_import_file_dedup_and_constraints
-- 阶段 6 工单 01 审查修复：修正导入文件去重范围与声明字段约束。
--
-- P1-2：0016 创建了全局 UNIQUE(stored_files.sha256_hex)，导致不同管理员上传同一
--   合法原件被错误拒绝。改为「同上传人 + 同内容」去重：UNIQUE(uploaded_by, sha256_hex)。
-- P1-1：明确声明 MIME 与嗅探 MIME 都保留真实值（库约束不变，应用层负责一致性）。
-- 本 migration 不改已应用的 0016，仅追加修正约束。
DROP INDEX IF EXISTS stored_files_sha256_unique;
CREATE UNIQUE INDEX stored_files_uploader_sha256_unique
  ON stored_files (uploaded_by, sha256_hex);