-- 0033_enrichment_drafts
-- 阶段 6 工单 06：DeepSeek draft 内网零网络基础（Fake-only foundation）。
--
-- 设计要点：
--   - enrichment_drafts 是「已保存英文来源事实 → 受控 DeepSeek 请求 → 简体中文候选」的
--     不可变审计事实；模型输出绝不是事实/最终词条/课程内容/学习内容；
--   - append-only：已写入的草稿事实不可 UPDATE / DELETE（保持审计真相）；
--   - 同一输入不重复草稿：UNIQUE(import_batch_commit_row_id, provider, configured_model_alias,
--     prompt_template_version, input_hash) → 重放 no-op、重试不重复创建；
--   - 一个 operation 至多产出一个草稿意图：部分 UNIQUE(operation_id) WHERE operation_id IS NOT NULL；
--   - 绝不保存完整 prompt、原始 provider response、secret、路径；只存脱敏 hash 与模型身份；
--   - resolved_provider_model 仅保存 provider 响应明确返回的实际模型标识；不足为空
--     （MD-15：不得把 configured_model_alias / provider_fingerprint 冒充实际版本）；
--   - provider_fingerprint 单独保存，来自 system_fingerprint；不是模型版本；
--   - 与操作关联是可选 FK（operation_id → application_operations，ON DELETE RESTRICT），
--     import_batch_commit_row_id / lexical_entry_id 均为 RESTRICT；
--   - 不改变既有多词/操作/immutable trigger；本表用独立 trigger；
--   - 只追加 migration，不改写 0001–0032。不使用 session_replication_role，不禁用 trigger。
--
-- draft 状态语义（与 operation 状态分开保存）：
--   - drafting           ：请求已发起/已入队；
--   - draft_ready        ：简体中文候选已写入，等待 Ticket 07 人工审核；
--   - retry_wait         ：瞬态失败等待自动重试（由 operation 状态机驱动）；
--   - manual_action      ：认证/预算/缺来源/歧义等不可自动重试，需人工；
--   - failed             ：不可重试或耗尽尝试次数；
--   - superseded         ：同源新输入/新模型/新模板产生新版本草稿，旧草稿标记 superseded（绝不覆盖）；
--   - restricted_model_identity ：resolved_provider_model 空/不足，无法构成可验证实际模型身份
--                                （MD-15；不得伪造版本）。

CREATE TABLE enrichment_drafts (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_commit_row_id   uuid NOT NULL REFERENCES import_batch_commit_rows (id) ON DELETE RESTRICT,
  lexical_entry_id             uuid NOT NULL REFERENCES lexical_entries (id) ON DELETE RESTRICT,
  wiktionary_source_fact_id    text NOT NULL CHECK (wiktionary_source_fact_id ~ '^[0-9a-f]{64}$'),
  operation_id                 uuid REFERENCES application_operations (id) ON DELETE RESTRICT,
  provider                     text NOT NULL DEFAULT 'deepseek' CHECK (provider = 'deepseek'),
  configured_model_alias       text NOT NULL CHECK (length(configured_model_alias) > 0 AND length(configured_model_alias) <= 128),
  resolved_provider_model      text CHECK (resolved_provider_model IS NULL OR length(resolved_provider_model) <= 128),
  provider_fingerprint         text CHECK (provider_fingerprint IS NULL OR length(provider_fingerprint) <= 256),
  prompt_template_version      text NOT NULL CHECK (length(prompt_template_version) > 0 AND length(prompt_template_version) <= 128),
  input_hash                   text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  request_hash                 text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_hash                text CHECK (response_hash IS NULL OR response_hash ~ '^[0-9a-f]{64}$'),
  draft_schema_version         integer NOT NULL DEFAULT 1 CHECK (draft_schema_version >= 1),
  status                       text NOT NULL DEFAULT 'drafting'
                               CHECK (status IN ('drafting','draft_ready','retry_wait','manual_action','failed','superseded','restricted_model_identity')),
  simplified_chinese_meaning   text CHECK (simplified_chinese_meaning IS NULL OR length(simplified_chinese_meaning) <= 120),
  learning_hint                text CHECK (learning_hint IS NULL OR length(learning_hint) <= 80),
  validation_metadata          jsonb NOT NULL DEFAULT '{}',
  created_at                   timestamptz NOT NULL DEFAULT now(),
  completed_at                 timestamptz,
  error_code                   text CHECK (error_code IS NULL OR length(error_code) <= 64),
  safe_error_summary           text CHECK (safe_error_summary IS NULL OR length(safe_error_summary) <= 500),

  -- draft_ready 必须携带成功简体中文含义；其它状态不得携带成功内容。
  CHECK (
    (status = 'draft_ready' AND simplified_chinese_meaning IS NOT NULL AND length(simplified_chinese_meaning) > 0)
    OR (status <> 'draft_ready' AND simplified_chinese_meaning IS NULL)
  ),
  -- 模型身份不足状态：resolved_provider_model 必须为空（不得把别名/fingerprint 冒充实际版本）。
  CHECK (
    (status <> 'restricted_model_identity')
    OR (resolved_provider_model IS NULL)
  ),
  -- completed_at 与终态一致性：终态必须有 completed_at（宽松；可空允许起草）。
  CHECK (
    (status IN ('draft_ready','failed','manual_action','superseded','restricted_model_identity') AND completed_at IS NOT NULL)
    OR (status NOT IN ('draft_ready','failed','manual_action','superseded','restricted_model_identity'))
  )
);

-- 同一输入不重复草稿（幂等重放 no-op，重试不重复创建）。
CREATE UNIQUE INDEX enrichment_drafts_input_unique
  ON enrichment_drafts (import_batch_commit_row_id, provider, configured_model_alias, prompt_template_version, input_hash);

-- 一个 operation 至多产出一个草稿意图（仅非空 operation_id 互斥）。
CREATE UNIQUE INDEX enrichment_drafts_operation_unique
  ON enrichment_drafts (operation_id) WHERE operation_id IS NOT NULL;

-- 查询用索引（管理端列表/过滤）。
CREATE INDEX enrichment_drafts_lexical_status_idx ON enrichment_drafts (lexical_entry_id, status);
CREATE INDEX enrichment_drafts_commit_row_idx ON enrichment_drafts (import_batch_commit_row_id);
CREATE INDEX enrichment_drafts_status_created_idx ON enrichment_drafts (status, created_at DESC);

-- ---- append-only 不可变：禁止 UPDATE / DELETE ----
-- 新输入/新模型/新模板形成【新版本草稿】，绝不覆盖旧草稿；已写入字段不可改。

CREATE OR REPLACE FUNCTION motro_reject_draft_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'enrichment drafts are immutable (update/delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enrichment_drafts_no_update
  BEFORE UPDATE ON enrichment_drafts
  FOR EACH ROW EXECUTE FUNCTION motro_reject_draft_mutation();
CREATE TRIGGER enrichment_drafts_no_delete
  BEFORE DELETE ON enrichment_drafts
  FOR EACH ROW EXECUTE FUNCTION motro_reject_draft_mutation();