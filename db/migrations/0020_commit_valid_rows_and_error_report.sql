-- 0020_commit_valid_rows_and_error_report
-- 阶段 6 工单 03：管理员仅提交有效候选行，形成可审计的词条/来源事实；并提供错误报告。
--
-- 设计要点：
--   - import_batch_commits：一次「提交批次」的不可变、幂等可重放事实。锁定并重校验提交
--     前置条件（mapping_version / validated / 非 stale / 校验输入身份）后写入；
--     记录谁在何时从哪个 mapping_version 提交，以及创建/关联/跳过计数。行不能跨提交
--     重复（见 import_row_commit 唯一约束）。本表行不可 UPDATE/DELETE（提交后的事实）。
--   - import_batch_commit_rows（行级提交事实）：一行 <-> 一个提交事实 的一对一关系。
--     唯一约束 (commit_id, import_row_id) 与 (import_row_id) 保证：
--        * 一个导入行在一个提交里恰好出现一次；
--        * 一个导入行绝不能被第二次提交（不论同批或跨批）。
--     每一行记录是否新建词条（created_entry）或关联既有词条（associated_entry），
--     以及不可变关联的词条与来源 ID。
--   - import_rows.lexical_entry_id 保留为「当前关联」（validate 时对 existing_entry 写入）；
--     提交时对该行的关联/创建一并写回，使 UI 可展示最终关联。
--   - lexical_sources 复用既有 (lexical_entry_id, source_type, content_hash) 唯一约束：
--     同一词条同一导入来源不重复写入。content_hash 绑定 import_batch_commit_rows.id，
--     冗余但确定性：重放同一提交 URL，词条/来源已存在 → 关联而非重建。
--
-- 只追加 migration，不改写 0001–0019。

-- 1) 提交批次事实表。
CREATE TABLE import_batch_commits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  committed_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  mapping_version integer NOT NULL CHECK (mapping_version >= 1),
  validation_input_sha256 text,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed')),
  created_entry_count integer NOT NULL DEFAULT 0 CHECK (created_entry_count >= 0),
  associated_existing_entry_count integer NOT NULL DEFAULT 0 CHECK (associated_existing_entry_count >= 0),
  committed_row_count integer NOT NULL DEFAULT 0 CHECK (committed_row_count >= 0),
  skipped_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 供幂等重放返回与首次完全一致的可证明摘要：不可变语义哈希。
  semantic_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_batch_commits_batch_id_idx ON import_batch_commits (batch_id);
CREATE INDEX import_batch_commits_committed_by_idx ON import_batch_commits (committed_by);
CREATE INDEX import_batch_commits_created_at_idx ON import_batch_commits (created_at DESC);
-- 同一批次同一 mapping_version 至多一个提交：防止不同幂等键对同一批重复完整提交。
CREATE UNIQUE INDEX import_batch_commits_batch_mv_unique
  ON import_batch_commits (batch_id, mapping_version);

-- 2) 行级提交事实表（一对一，不可变）。
CREATE TABLE import_batch_commit_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_id uuid NOT NULL REFERENCES import_batch_commits (id) ON DELETE CASCADE,
  import_row_id uuid NOT NULL REFERENCES import_rows (id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  normalized_spelling text NOT NULL,
  created_entry_id uuid REFERENCES lexical_entries (id) ON DELETE RESTRICT,
  associated_entry_id uuid REFERENCES lexical_entries (id) ON DELETE RESTRICT,
  lexical_source_id uuid REFERENCES lexical_sources (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 一个提交事实内一个导入行恰一次：不可能创建额外含义。
  CHECK (
    (created_entry_id IS NOT NULL)::int + (associated_entry_id IS NOT NULL)::int = 1
  )
);

CREATE INDEX import_batch_commit_rows_commit_id_idx ON import_batch_commit_rows (commit_id);
-- 一个导入行在批次提交中最多被引用一次。
CREATE UNIQUE INDEX import_batch_commit_rows_row_unique ON import_batch_commit_rows (import_row_id);
-- 同一提交内 ordinal 唯一（理论重复防御）。
CREATE UNIQUE INDEX import_batch_commit_rows_commit_ordinal_unique
  ON import_batch_commit_rows (commit_id, ordinal);
-- 按词条反查来源/提交（审计可追溯）。
CREATE INDEX import_batch_commit_rows_entry_idx
  ON import_batch_commit_rows (created_entry_id) WHERE created_entry_id IS NOT NULL;
CREATE INDEX import_batch_commit_rows_associated_idx
  ON import_batch_commit_rows (associated_entry_id) WHERE associated_entry_id IS NOT NULL;

-- 3) 提交后批次状态：committed 语义收窄为「本批已提交过有效行」。
--    只有从未提交过的批次才是 uploaded/ready；一旦有提交事实即 committed。
ALTER TABLE import_batches
  DROP CONSTRAINT IF EXISTS import_batches_status_check;
ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_status_check
  CHECK (status IN ('uploaded', 'validating', 'ready', 'committed', 'failed'));

-- 4) 提交批次与行级事实不可变：禁止 UPDATE/DELETE（保持审计真相）。
CREATE OR REPLACE FUNCTION motro_reject_commit_row_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'commit facts are immutable (update/delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER import_batch_commits_no_update BEFORE UPDATE ON import_batch_commits
  FOR EACH ROW EXECUTE FUNCTION motro_reject_commit_row_change();
CREATE TRIGGER import_batch_commits_no_delete BEFORE DELETE ON import_batch_commits
  FOR EACH ROW EXECUTE FUNCTION motro_reject_commit_row_change();
CREATE TRIGGER import_batch_commit_rows_no_update BEFORE UPDATE ON import_batch_commit_rows
  FOR EACH ROW EXECUTE FUNCTION motro_reject_commit_row_change();
CREATE TRIGGER import_batch_commit_rows_no_delete BEFORE DELETE ON import_batch_commit_rows
  FOR EACH ROW EXECUTE FUNCTION motro_reject_commit_row_change();