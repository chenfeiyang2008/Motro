-- 0021_commit_rows_provenance_enforced
-- 阶段 6 工单 03 critical-review-fixes（P1-4）：数据库层强制提交行的来源一致性。
--
-- 目标：
--   - 每个行级提交事实必须绑定「恰好一个已提交词条」；
--   - 每个行级提交事实必须引用「一个属于同一词条的 import 来源」；
--   - 数据库自身拒绝：来源为空、词条引用缺失/冲突、来源属于另一词条。
--
-- 方案（不改写 0001–0020，只追加）：
--   - 新增非空 canonical 列 lexical_entry_id（直接词条身份），供复合外键与触发器引用；
--   - lexical_source_id 由可空改为 NOT NULL；
--   - 保留 created_entry_id / associated_entry_id 仅用于结果分类（二者恰一非空），
--     由既有 CHECK 保证；新增 CHECK 保证 canonical lexical_entry_id 与分类一致
--     （created 时 == created_entry_id，associated 时 == associated_entry_id）；
--   - 新增窄范围约束触发器：插入/更新时证明 lexical_sources.lexical_entry_id
--     与 import_batch_commit_rows.lexical_entry_id 完全一致（来源不能属于另一词条）。
--   - 新增 NOT VALID 唯一索引：同一词条在批内最多一次提交（对既有行友好）。

-- 1) 新增非空 canonical 词条列（先加可空，回填后收紧 NOT NULL）。
ALTER TABLE import_batch_commit_rows
  ADD COLUMN lexical_entry_id uuid;

-- 2) 回填既有行：canonical = created_entry_id 或 associated_entry_id（二者恰一）。
--    0020 的不可变触发器会拦截 UPDATE，故回填期间临时禁用、完成后恢复。
ALTER TABLE import_batch_commit_rows DISABLE TRIGGER import_batch_commit_rows_no_update;
UPDATE import_batch_commit_rows
SET lexical_entry_id = COALESCE(created_entry_id, associated_entry_id)
WHERE lexical_entry_id IS NULL;
ALTER TABLE import_batch_commit_rows ENABLE TRIGGER import_batch_commit_rows_no_update;

-- 3) 收紧 NOT NULL：既然后续所有新行都必须提供。
ALTER TABLE import_batch_commit_rows
  ALTER COLUMN lexical_entry_id SET NOT NULL;

-- 4) 分类一致性：canonical 必须等于分类列（created 或 associated 之一）。
ALTER TABLE import_batch_commit_rows
  ADD CONSTRAINT import_batch_commit_rows_canonical_match_check
  CHECK (
    (created_entry_id IS NOT NULL AND lexical_entry_id = created_entry_id)
    OR (associated_entry_id IS NOT NULL AND lexical_entry_id = associated_entry_id)
  );

-- 5) 来源强制非空。
ALTER TABLE import_batch_commit_rows
  ALTER COLUMN lexical_source_id SET NOT NULL;

-- 6) canonical 词条外键（RESTRICT 保持审计真相）。
ALTER TABLE import_batch_commit_rows
  ADD CONSTRAINT import_batch_commit_rows_lexical_entry_fk
  FOREIGN KEY (lexical_entry_id) REFERENCES lexical_entries (id) ON DELETE RESTRICT;

-- 7) 窄范围约束触发器：证明引用来源属于同一词条。
--    PostgreSQL 无法用纯 FK 表达「来源.entry == 行.entry」（来源是另一张表），
--    用约束触发器在插入/更新时验证，违反则拒绝整行。
CREATE OR REPLACE FUNCTION motro_validate_commit_row_source_provenance()
RETURNS trigger AS $$
DECLARE
  src_entry uuid;
BEGIN
  SELECT lexical_entry_id INTO src_entry
  FROM lexical_sources
  WHERE id = NEW.lexical_source_id;
  IF src_entry IS NULL THEN
    RAISE EXCEPTION 'commit row references a non-existent lexical source';
  END IF;
  IF src_entry IS DISTINCT FROM NEW.lexical_entry_id THEN
    RAISE EXCEPTION 'commit row lexical source belongs to a different lexical entry';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER import_batch_commit_rows_source_provenance
  AFTER INSERT OR UPDATE OF lexical_source_id, lexical_entry_id
  ON import_batch_commit_rows
  FOR EACH ROW
  EXECUTE FUNCTION motro_validate_commit_row_source_provenance();

-- 8) 批内「同一词条至多一次提交」唯一防线（对既有数据友好，NOT VALID）。
--    来源唯一约束已在 lexical_sources 层保证同一 (entry, import, hash) 不重复；
--    此索引兜底「同一词条被同批两个不同行各提交一次」。
CREATE UNIQUE INDEX import_batch_commit_rows_batch_entry_unique
  ON import_batch_commit_rows (commit_id, lexical_entry_id);
