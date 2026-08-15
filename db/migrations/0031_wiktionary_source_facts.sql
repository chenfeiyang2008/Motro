-- 0031_wiktionary_source_facts
-- 阶段 6 工单 05：Wiktionary source fact 内网零网络基础（Fake-only foundation）。
--
-- 设计要点：
--   - source fact 是「同 page + revision + parser version 的一次抓取结局」的不可变审计事实；
--   - append-only：已写入的事实不可 UPDATE / DELETE（保持审计真相）；
--   - 同 page + revision + parser 只产生一条（source_fact_identity 唯一）→ 重放 no-op、
--     重试不重复创建；
--   - 新 revision 产生新事实；旧 revision 保留；
--   - content hash 不可静默覆盖；license / attribution 不被静默改写（全部 immutable）；
--   - raw wikitext、provider payload、例句、引用、图片、音频一律【不落库】（无此类列）；
--   - 事务失败不会留下半条事实（单条 INSERT 原子性）；
--   - 与 import commit row 的关联是【可选外键】（commit_row_id → import_batch_commit_rows，
--     ON DELETE RESTRICT），不新增 wiktionary_source_fact operation target，
--     不扩展 0028 target_type 白名单；
--   - 不改变 Ticket 04 的 target_type/target_id 结构；
--   - 不破坏既有 immutable trigger（本表用独立 trigger，不复用/不改写其它表）。
--
-- status 语义（与 operation 状态分开保存）：
--   - fetched    ：成功抓取（有真实 definition content 与 64 位 content_hash）；
--   - ambiguous  ：拼写歧义（WIKI_AMBIGUOUS，无单一事实内容）；
--   - error      ：抓取失败（page/revision missing、malformed、oversized、license/
--                   attribution incomplete 等 WIKI 错误的具体事实，以 operation 的
--                  error_code 区分；本表只记 status=error）；
--   - pending    ：占位（保留，当前 Fake handler 不产生，逻辑模型预留）；
--   - superseded ：保留（本票不实现；后续真实 adapter 新 revision 产生新事实时，
--                  旧 fetched 事实作为历史保留，不主动改写 status —— append-only）。
--
-- 只追加 migration，不改写 0001–0030。不使用 session_replication_role，不禁用 trigger。

CREATE TABLE wiktionary_source_facts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_fact_identity  text NOT NULL,
  page_identity_hash    text NOT NULL,
  revision_identity_hash text NOT NULL,
  page_id               text NOT NULL CHECK (length(page_id) > 0 AND length(page_id) <= 256),
  revision_id           text NOT NULL CHECK (length(revision_id) > 0 AND length(revision_id) <= 256),
  revision_timestamp    timestamptz,
  canonical_title       text NOT NULL CHECK (length(canonical_title) > 0 AND length(canonical_title) <= 512),
  normalized_spelling   text NOT NULL CHECK (length(normalized_spelling) > 0 AND length(normalized_spelling) <= 512),
  language              text NOT NULL CHECK (length(language) > 0 AND length(language) <= 16),
  part_of_speech        text CHECK (part_of_speech IS NULL OR length(part_of_speech) <= 32),
  definition_excerpt    text NOT NULL CHECK (length(definition_excerpt) > 0 AND length(definition_excerpt) <= 2000),
  content_hash          text CHECK (content_hash IS NULL OR length(content_hash) = 64),
  source_url            text NOT NULL CHECK (length(source_url) > 0 AND length(source_url) <= 2000),
  license_name          text CHECK (license_name IS NULL OR length(license_name) <= 200),
  license_version       text CHECK (license_version IS NULL OR length(license_version) <= 64),
  license_url           text CHECK (license_url IS NULL OR length(license_url) <= 2000),
  attribution           text CHECK (attribution IS NULL OR length(attribution) <= 2000),
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  parser_version        text NOT NULL CHECK (length(parser_version) > 0 AND length(parser_version) <= 128),
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','fetched','ambiguous','error','superseded')),
  ambiguity_note        text CHECK (ambiguity_note IS NULL OR length(ambiguity_note) <= 2000),
  commit_row_id         uuid REFERENCES import_batch_commit_rows (id) ON DELETE RESTRICT,
  input_version_used    integer CHECK (input_version_used IS NULL OR input_version_used >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- content hash 不变量：fetched 状态必须携带一个 64 位 hex content_hash；
  -- 其它状态（ambiguous/error/pending/superseded）无 definition 内容，content_hash 必须为 NULL。
  CHECK (
    (status = 'fetched' AND content_hash IS NOT NULL AND length(content_hash) = 64)
    OR (status <> 'fetched' AND content_hash IS NULL)
  )
);

-- 同 page + revision + parser 只产生一条事实（幂等重放 no-op，重试不重复创建）。
CREATE UNIQUE INDEX wiktionary_source_facts_identity_unique
  ON wiktionary_source_facts (source_fact_identity);

-- 按 page/revision 反查（审计可追溯）。
CREATE INDEX wiktionary_source_facts_page_revision_idx
  ON wiktionary_source_facts (page_identity_hash, revision_identity_hash);
-- 按 content hash 反查（不可静默覆盖的校验来源）。
CREATE INDEX wiktionary_source_facts_content_hash_idx
  ON wiktionary_source_facts (content_hash);
-- 按 commit row 反查（业务关联可追溯）。
CREATE INDEX wiktionary_source_facts_commit_row_idx
  ON wiktionary_source_facts (commit_row_id) WHERE commit_row_id IS NOT NULL;
-- 按状态/创建时间（管理端查询）。
CREATE INDEX wiktionary_source_facts_status_idx ON wiktionary_source_facts (status);
CREATE INDEX wiktionary_source_facts_created_at_idx ON wiktionary_source_facts (created_at DESC);

-- ---- append-only 不可变：禁止 UPDATE / DELETE ----
--
-- content_hash / license / attribution 的「不可静默覆盖」由本触发器 + 数据库 CHECK 共同保证：
-- 任何 UPDATE / DELETE 都被拒绝，因此不存在改写既有事实的路径。

CREATE OR REPLACE FUNCTION motro_reject_source_fact_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wiktionary source facts are immutable (update/delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wiktionary_source_facts_no_update
  BEFORE UPDATE ON wiktionary_source_facts
  FOR EACH ROW EXECUTE FUNCTION motro_reject_source_fact_mutation();
CREATE TRIGGER wiktionary_source_facts_no_delete
  BEFORE DELETE ON wiktionary_source_facts
  FOR EACH ROW EXECUTE FUNCTION motro_reject_source_fact_mutation();