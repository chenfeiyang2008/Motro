-- 0024_referenced_import_source_trigger_return_fix
-- 阶段 6 工单 03 last-p1-transaction-trigger-and-e2e-safety-fixes（P1-4）：
-- 修正 0023 的 BEFORE DELETE trigger 返回值。
--
-- 背景：
--   motro_reject_mutation_of_referenced_import_source() 固定 RETURN NEW。
--   在 BEFORE DELETE trigger 中 NEW 为 NULL，PostgreSQL 会把「返回 NULL」理解为
--   「取消该 DELETE」。于是未被任何 commit row 引用的 source 也无法删除，
--   与迁移注释「无引用时放行」矛盾。
--
-- 方案（不改写 0023，只追加 0024）：
--   - 重建该函数：
--       已被 import_batch_commit_rows 引用 → RAISE EXCEPTION（不可篡改）；
--       UPDATE 且未被引用 → RETURN NEW；
--       DELETE 且未被引用 → RETURN OLD。
--   - 触发器本身（BEFORE UPDATE / BEFORE DELETE）保持不变，函数体替换即可。
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
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
