-- 0006_draft_course_items
-- 草稿课程词项：在课程草稿单元中引用全局词条并填写课程专属中文展示内容。
-- 词项只存在于草稿（不建 release 快照）；手工中文内容通过 content_review_reference
-- 关联到对应管理员审计事件，发布校验据此判断内容是否有人工作为依据。

CREATE TABLE draft_course_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_unit_id uuid NOT NULL REFERENCES draft_units (id) ON DELETE CASCADE,
  lexical_entry_id uuid NOT NULL REFERENCES lexical_entries (id),
  position integer NOT NULL CHECK (position >= 1),
  meaning text NOT NULL,
  hint text,
  content_review_reference uuid NOT NULL REFERENCES audit_events (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 同一单元内 position 不重复；稳定 course_item_id（即 id）在草稿内唯一（由主键保证全局唯一）。
CREATE UNIQUE INDEX draft_course_items_unit_position_unique
  ON draft_course_items (draft_unit_id, position);
CREATE UNIQUE INDEX draft_course_items_draft_item_id_unique
  ON draft_course_items (draft_unit_id, id);

CREATE INDEX draft_course_items_unit_id_idx ON draft_course_items (draft_unit_id);
CREATE INDEX draft_course_items_lexical_entry_id_idx ON draft_course_items (lexical_entry_id);
