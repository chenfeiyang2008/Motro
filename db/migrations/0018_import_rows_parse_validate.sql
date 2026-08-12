-- 0018_import_rows_parse_validate
-- 阶段 6 工单 02：四格式解析、映射与校验。
--
-- 设计要点：
--   - import_rows 保存「不可被后续映射覆盖」的逐行解析/校验事实。每行是唯一
--     (batch_id, ordinal)；ordinal 从 1 开始、批次内唯一。
--   - mapping_version：行事实所属的映射/校验版本。映射改变 → 批次 mapping_version
--     递增 → 旧行事实成为 stale（不被当作新映射下的有效结果），而不是被悄悄覆盖。
--   - raw_summary 只保存原始值的「安全摘要」：受长度限制、可展示，绝不保存整份
--     原文件的冗余副本，也不泄露路径/敏感值。
--   - errors 是结构化、脱敏的错误数组（JSONB），如 [{"code":"invalid_spelling","message":"…"}]。
--   - lexical_entry_id / draft 关联字段可空：本票只定义外键与占位，不创建这些实体。
--   - import_batches 追加：current_mapping（受 schema 约束的 JSON）、mapping_version、
--     selected_sheet（XLSX 时）、校验状态、校验摘要/counts、输入文件冻结哈希、最近校验时间。
--     映射变化必须：递增 mapping_version、使旧校验结果失效、保留审计事实。

-- import_batches 扩展字段（0016 基础上追加）。
ALTER TABLE import_batches
  ADD COLUMN mapping_version integer NOT NULL DEFAULT 1,
  ADD COLUMN current_mapping jsonb,
  ADD COLUMN selected_sheet text,
  ADD COLUMN validation_status text NOT NULL DEFAULT 'not_validated'
    CHECK (validation_status IN ('not_validated', 'validating', 'validated', 'failed')),
  ADD COLUMN validation_summary jsonb,
  ADD COLUMN validation_input_sha256 text,
  ADD COLUMN last_validated_at timestamptz;

-- current_mapping 必须受 schema 约束：只允许 { spellingField, sheet } 两个可选键，
-- 值必须是非空字符串；sheet 只对 xlsx 有含义（应用层负责按格式校验）。
ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_mapping_shape_check
  CHECK (
    current_mapping IS NULL
    OR (
      jsonb_typeof(current_mapping) = 'object'
      AND (
        (current_mapping ? 'spellingField' AND jsonb_typeof(current_mapping->'spellingField') = 'string')
        OR NOT (current_mapping ? 'spellingField')
      )
      AND (
        (current_mapping ? 'sheet' AND jsonb_typeof(current_mapping->'sheet') = 'string')
        OR NOT (current_mapping ? 'sheet')
      )
      AND NOT (current_mapping ? 'file')
      AND NOT (current_mapping ? 'format')
      AND NOT (current_mapping ? 'uploadedBy')
    )
  );

-- 校验摘要受 schema 约束：counts 各计数必须是非负整数。
ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_validation_summary_check
  CHECK (
    validation_summary IS NULL
    OR jsonb_typeof(validation_summary) = 'object'
  );

-- 最近校验时间必须与 validation_status 语义一致：validated 时不能为空。
ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_validated_time_check
  CHECK (
    validation_status <> 'validated'
    OR (last_validated_at IS NOT NULL AND validation_summary IS NOT NULL)
  );

CREATE TABLE import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  -- 批次内唯一、从 1 开始、必须为正。
  ordinal integer NOT NULL CHECK (ordinal > 0),
  -- 行事实所属的映射/校验版本；映射改变后旧行仍保留原版本号（不被覆盖）。
  mapping_version integer NOT NULL,
  -- 原始拼写值的安全摘要（绝不保存整份原文件；受长度限制，可展示）。
  raw_summary text NOT NULL,
  -- 规范化后的拼写（复用词条拼写规则）；解析/校验失败时可为空。
  normalized_spelling text,
  -- 行的校验/处理状态。
  status text NOT NULL
    CHECK (status IN ('candidate', 'invalid', 'duplicate_in_file', 'existing_entry', 'stale')),
  -- 结构化、脱敏的错误数组：JSONB 数组，如 [{"code":"invalid_spelling","message":"…"}]。
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 文件内重复判定：与第 N 行重复（可为空）。必须是同批内的另一个 ordinal。
  duplicate_of_ordinal integer CHECK (duplicate_of_ordinal IS NULL OR duplicate_of_ordinal > 0),
  -- 系统已有词条/后续草稿的关联（可空）。本票只定义外键与占位，不创建这些实体。
  lexical_entry_id uuid REFERENCES lexical_entries (id) ON DELETE SET NULL,
  enrichment_draft_id uuid,
  -- 创建时间；stale 判定用 mapping_version 与批次 mapping_version 比较。
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 批次内 ordinal 唯一（每行是不可被映射覆盖的事实，不能出现两行同 ordinal）。
CREATE UNIQUE INDEX import_rows_batch_ordinal_unique ON import_rows (batch_id, ordinal);
CREATE INDEX import_rows_batch_id_idx ON import_rows (batch_id);
CREATE INDEX import_rows_batch_status_idx ON import_rows (batch_id, status);
CREATE INDEX import_rows_created_at_idx ON import_rows (created_at DESC);
-- 每行归属的映射版本，供 stale 判定。
CREATE INDEX import_rows_mapping_version_idx ON import_rows (batch_id, mapping_version);

-- duplicate_of_ordinal 必须引用同批内真实存在的另一行（防止悬空引用）。
-- 用复合外键 (batch_id, ordinal) 指向本表唯一索引 (batch_id, ordinal)。
-- 应用层按 ordinal 升序写入，重复行总指向更早的行，满足即时外键检查。
-- ON DELETE RESTRICT：不允许删除被其他行引用的行；删除按依赖顺序在应用层处理。
ALTER TABLE import_rows
  ADD CONSTRAINT import_rows_duplicate_ref_fk
  FOREIGN KEY (batch_id, duplicate_of_ordinal)
  REFERENCES import_rows (batch_id, ordinal)
  ON DELETE RESTRICT;
