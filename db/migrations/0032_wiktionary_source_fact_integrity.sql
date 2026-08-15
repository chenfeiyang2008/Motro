-- 0032_wiktionary_source_fact_integrity
-- Ticket 05 migration compatibility closeout：补齐 ambiguity_candidates 列与数据库级约束。
--
-- 本 migration 是纯增量（append-only），不删除已有 source facts，不修改 0031。
-- 适用于两种路径：
--   A. 共享 dev DB 已应用旧版 0031（hash bba2792b）→ 运行本 migration 升级。
--   B. 全新 DB 从 0001 迁移到 0032 → 0031 先创建表，本 migration 补齐列和约束。
--
-- 设计要点：
--   - 逐项 pre-check 已有数据是否违反新增约束；违规则 fail closed，不静默修复；
--   - 新增约束使用稳定命名，便于审计和后续复测；
--   - 不使用 session_replication_role，不禁用 trigger；
--   - 不修改 0001–0031。

-- ---- 1. Pre-check：ambiguity_candidates 列不存在时才添加 ----

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'wiktionary_source_facts' AND column_name = 'ambiguity_candidates'
  ) THEN
    ALTER TABLE wiktionary_source_facts ADD COLUMN ambiguity_candidates jsonb;
  END IF;
END
$$;

-- ---- 2. Pre-check：identity/hash 现有数据是否合法（64 位小写 hex） ----

DO $$
DECLARE
  bad_count bigint;
  status_text text;
BEGIN
  -- source_fact_identity 格式校验
  SELECT count(*) INTO bad_count FROM wiktionary_source_facts
    WHERE source_fact_identity !~ '^[0-9a-f]{64}$';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'pre-check failed: % rows have invalid source_fact_identity (expected ^[0-9a-f]{64}$)', bad_count;
  END IF;

  -- page_identity_hash 格式校验
  SELECT count(*) INTO bad_count FROM wiktionary_source_facts
    WHERE page_identity_hash !~ '^[0-9a-f]{64}$';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'pre-check failed: % rows have invalid page_identity_hash (expected ^[0-9a-f]{64}$)', bad_count;
  END IF;

  -- revision_identity_hash 格式校验
  SELECT count(*) INTO bad_count FROM wiktionary_source_facts
    WHERE revision_identity_hash !~ '^[0-9a-f]{64}$';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'pre-check failed: % rows have invalid revision_identity_hash (expected ^[0-9a-f]{64}$)', bad_count;
  END IF;

  -- content_hash 格式校验（仅 fetched 状态携带 hash，其它状态 hash 为 NULL）
  SELECT count(*) INTO bad_count FROM wiktionary_source_facts
    WHERE content_hash IS NOT NULL AND content_hash !~ '^[0-9a-f]{64}$';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'pre-check failed: % rows have invalid content_hash (expected ^[0-9a-f]{64}$)', bad_count;
  END IF;

  -- fetched 状态必须有 content_hash；非 fetched 必须为 NULL
  SELECT count(*) INTO bad_count FROM wiktionary_source_facts
    WHERE status = 'fetched' AND content_hash IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'pre-check failed: % fetched rows have NULL content_hash', bad_count;
  END IF;

  SELECT count(*) INTO bad_count FROM wiktionary_source_facts
    WHERE status <> 'fetched' AND content_hash IS NOT NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'pre-check failed: % non-fetched rows have non-NULL content_hash', bad_count;
  END IF;
END
$$;

-- ---- 3. Pre-check：ambiguous 状态与 ambiguity_candidates 一致性 ----
-- 旧版 0031 未创建 ambiguity_candidates 列，因此旧 0031 已有行的 candidates 列为 NULL。
-- 如果有 ambiguous 状态的事实，它们现在缺少 candidates（不满足即将应用的 CHECK），
-- 必须 fail closed。

DO $$
DECLARE
  bad_ambiguous bigint;
BEGIN
  SELECT count(*) INTO bad_ambiguous FROM wiktionary_source_facts
    WHERE status = 'ambiguous' AND ambiguity_candidates IS NULL;
  IF bad_ambiguous > 0 THEN
    RAISE EXCEPTION
      'pre-check failed: % ambiguous rows have NULL ambiguity_candidates '
      '(cannot apply ambiguity status invariant; '
      'these facts must be manually resolved or cleared before migration)', bad_ambiguous;
  END IF;

  SELECT count(*) INTO bad_ambiguous FROM wiktionary_source_facts
    WHERE status <> 'ambiguous' AND ambiguity_candidates IS NOT NULL;
  IF bad_ambiguous > 0 THEN
    RAISE EXCEPTION
      'pre-check failed: % non-ambiguous rows have non-NULL ambiguity_candidates '
      '(violates ambiguity status invariant)', bad_ambiguous;
  END IF;
END
$$;

-- ---- 4. Add identity/hex format CHECK constraints ----
-- 使用稳定命名，若约束已存在（如全新 DB 已被中间步骤创建）则忽略（IF NOT EXISTS）。

ALTER TABLE wiktionary_source_facts
  ADD CONSTRAINT wiktionary_source_facts_identity_hex_check
  CHECK (source_fact_identity ~ '^[0-9a-f]{64}$');

ALTER TABLE wiktionary_source_facts
  ADD CONSTRAINT wiktionary_source_facts_page_identity_hash_hex_check
  CHECK (page_identity_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE wiktionary_source_facts
  ADD CONSTRAINT wiktionary_source_facts_revision_identity_hash_hex_check
  CHECK (revision_identity_hash ~ '^[0-9a-f]{64}$');

-- ---- 5. Upgrade content_hash CHECK: length + hex pattern ----
-- Drop the old CHECK from 0031, add the new one. The old CHECK name is system-generated
-- (not predictable), so drop via constraint definition search.

DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'wiktionary_source_facts'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%length(content_hash)%'
  LOOP
    EXECUTE format('ALTER TABLE wiktionary_source_facts DROP CONSTRAINT %I', con.conname);
  END LOOP;
END
$$;

ALTER TABLE wiktionary_source_facts
  ADD CONSTRAINT wiktionary_source_facts_content_hash_check
  CHECK (
    (status = 'fetched' AND content_hash IS NOT NULL AND length(content_hash) = 64 AND content_hash ~ '^[0-9a-f]{64}$')
    OR (status <> 'fetched' AND content_hash IS NULL)
  );

-- ---- 6. Ambiguity status invariant CHECK ----

ALTER TABLE wiktionary_source_facts
  ADD CONSTRAINT wiktionary_source_facts_ambiguity_status_check
  CHECK (
    (status = 'ambiguous' AND ambiguity_candidates IS NOT NULL)
    OR (status <> 'ambiguous' AND ambiguity_candidates IS NULL)
  );