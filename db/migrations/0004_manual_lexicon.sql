-- 0004_manual_lexicon
-- 手工词条与来源：管理员创建可被课程草稿引用的全局词条。
-- 规范化拼写用于查询/去重，但不用唯一约束覆盖同形异义词：保存原始展示拼写，
-- 是否允许为同形异义词条由应用层重复判定显式决定。
-- canonical_spelling 精确唯一：完全相同的展示拼写不允许存在两行（并发安全的重复防线），
-- 同形异义词条因展示拼写不同而天然不冲突。

CREATE TABLE lexical_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_spelling text NOT NULL,
  normalized_spelling text NOT NULL,
  part_of_speech text,
  pronunciation text,
  senses jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 重复判定与搜索按规范化拼写走索引；canonical_spelling 供精确去重/展示排序。
CREATE INDEX lexical_entries_normalized_spelling_idx ON lexical_entries (normalized_spelling);
CREATE UNIQUE INDEX lexical_entries_canonical_spelling_unique ON lexical_entries (canonical_spelling);

CREATE TABLE lexical_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lexical_entry_id uuid NOT NULL REFERENCES lexical_entries (id) ON DELETE CASCADE,
  source_type text NOT NULL
    CHECK (source_type IN ('manual', 'wiktionary', 'import')),
  source_note text,
  content_hash text NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lexical_sources_entry_id_idx ON lexical_sources (lexical_entry_id);
-- 同一来源身份 + 内容哈希防止同一手工来源被重复写入。
CREATE UNIQUE INDEX lexical_sources_manual_idempotency_unique
  ON lexical_sources (lexical_entry_id, source_type, content_hash);
