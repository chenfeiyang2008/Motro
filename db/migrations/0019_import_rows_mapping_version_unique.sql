-- 0019_import_rows_mapping_version_unique
-- 阶段 6 工单 02 关键修复（P1-3）：保留跨映射版本的历史行事实。
--
-- 背景：
--   0018 的 import_rows 用 UNIQUE(batch_id, ordinal) 保证批次内 ordinal 唯一。
--   这使「同一批次的两个映射版本不能在同一 ordinal 并存」——映射变更后重新校验
--   只能删除旧行（replaceRows 全部删除）才能插入新行，导致历史行事实丢失。
--
-- 修复：
--   把唯一约束改为 UNIQUE(batch_id, mapping_version, ordinal)：
--   - 同一 (batch, mappingVersion) 内 ordinal 唯一（当前映射版本一行一个 ordinal）；
--   - 不同 mappingVersion 的历史行可并存（旧的被标记 stale，不被当作当前有效结果）；
--   - 当前映射版本的默认读取（rows 端点）仍按当前批次 mapping_version 过滤，
--     不混入历史行。
--
-- 只新增 migration，不改写 0001–0018。

-- 1) 先去掉 0018 的 duplicate_of_ordinal 自引用外键（它依赖旧的全局唯一索引）。
ALTER TABLE import_rows DROP CONSTRAINT IF EXISTS import_rows_duplicate_ref_fk;

-- 2) 再去掉 0018 的批次内 ordinal 唯一索引（同 (batch, ordinal) 全局唯一）。
DROP INDEX IF EXISTS import_rows_batch_ordinal_unique;

-- 3) 新建「版本内 ordinal 唯一」：同一 (batch, mapping_version) 内一行一个 ordinal。
CREATE UNIQUE INDEX import_rows_batch_mv_ordinal_unique
  ON import_rows (batch_id, mapping_version, ordinal);

-- 4) duplicate_of_ordinal 自引用：引用同 (batch, mapping_version, ordinal)。
--    重复行总指向同一版本内的更早 ordinal，满足即时外键检查。
ALTER TABLE import_rows
  ADD CONSTRAINT import_rows_duplicate_ref_fk
  FOREIGN KEY (batch_id, mapping_version, duplicate_of_ordinal)
  REFERENCES import_rows (batch_id, mapping_version, ordinal)
  ON DELETE RESTRICT;
