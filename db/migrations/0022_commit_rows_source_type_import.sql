-- 0022_commit_rows_source_type_import
-- 阶段 6 工单 03 provenance-and-error-report-fixes（P1-2）：数据库强制提交行引用的来源
-- 必须是「同一词条」且「source_type = import」的导入来源。
--
-- 背景：
--   0021 的约束触发器 motro_validate_commit_row_source_provenance 只验证
--   lexical_sources.lexical_entry_id == import_batch_commit_rows.lexical_entry_id，
--   未验证来源类型。这允许提交行引用同一词条的 manual/wiktionary 来源，
--   破坏「提交事实只携带 import 来源」的不可变审计语义。
--
-- 方案（不改写 0001–0021，只追加）：
--   - 重建该约束触发器函数，额外要求 lexical_sources.source_type = 'import'；
--   - 触发器已存在（AFTER INSERT OR UPDATE），保持原名字，函数体替换即可；
--   - 既有合法行不受影响：所有既有 commit row 的来源都是 service 写入的 import 来源。
CREATE OR REPLACE FUNCTION motro_validate_commit_row_source_provenance()
RETURNS trigger AS $$
DECLARE
  src_entry uuid;
  src_type text;
BEGIN
  SELECT lexical_entry_id, source_type INTO src_entry, src_type
  FROM lexical_sources
  WHERE id = NEW.lexical_source_id;
  IF src_entry IS NULL THEN
    RAISE EXCEPTION 'commit row references a non-existent lexical source';
  END IF;
  IF src_type <> 'import' THEN
    RAISE EXCEPTION 'commit row lexical source must be source_type = import';
  END IF;
  IF src_entry IS DISTINCT FROM NEW.lexical_entry_id THEN
    RAISE EXCEPTION 'commit row lexical source belongs to a different lexical entry';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
