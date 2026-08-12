-- 0023_referenced_import_sources_immutable
-- 阶段 6 工单 03 final-integrity-and-e2e-isolation-fixes（P1-1）：
-- 已被 import_batch_commit_rows 引用的 lexical_sources 身份不可被事后篡改。
--
-- 背景：
--   0021/0022 只在「写入 commit row」时验证来源归属与类型；若来源已被 commit row 引用，
--   未来错误 SQL/代码仍可执行：
--     UPDATE lexical_sources SET lexical_entry_id = <另一词条> WHERE id = <已引用来源>;
--     UPDATE lexical_sources SET source_type = 'manual'  WHERE id = <已引用来源>;
--     DELETE FROM lexical_sources WHERE id = <已引用来源>;
--   这会破坏「提交事实携带同一词条的 import 来源」的不可变审计语义。
--
-- 方案（不改写 0001–0022，只追加）：
--   - 对 lexical_sources 增加 BEFORE UPDATE / BEFORE DELETE 约束触发器：
--     若该来源被任一 import_batch_commit_rows.lexical_source_id 引用，则拒绝更新/删除。
--   - 只禁止 UPDATE（全行）与 DELETE；INSERT 不受影响（commit row 总是先有来源）。
--   - 触发器不区分被哪些 commit row 引用：任何引用都使来源不可变（审计真相）。
CREATE OR REPLACE FUNCTION motro_reject_mutation_of_referenced_import_source()
RETURNS trigger AS $$
DECLARE
  ref_count bigint;
BEGIN
  SELECT count(*) INTO ref_count
  FROM import_batch_commit_rows
  WHERE lexical_source_id = OLD.id;
  IF ref_count > 0 THEN
    RAISE EXCEPTION 'import source is referenced by a commit row and is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- UPDATE：被引用来源的任何字段变更都拒绝（RETURN NEW 在无引用时放行）。
CREATE TRIGGER lexical_sources_no_update_when_referenced
  BEFORE UPDATE ON lexical_sources
  FOR EACH ROW
  EXECUTE FUNCTION motro_reject_mutation_of_referenced_import_source();

-- DELETE：被引用来源删除拒绝（RETURN OLD 在无引用时放行）。
CREATE TRIGGER lexical_sources_no_delete_when_referenced
  BEFORE DELETE ON lexical_sources
  FOR EACH ROW
  EXECUTE FUNCTION motro_reject_mutation_of_referenced_import_source();
