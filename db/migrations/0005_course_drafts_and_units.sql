-- 0005_course_drafts_and_units
-- 稳定课程、唯一可编辑草稿与单元大纲。
-- 课程未发布前保持不可见；草稿是唯一可编辑工作区，写入用 draftVersion 做乐观并发控制。
-- 本票不添加 current-release 外键，发布版本工单负责补齐。

CREATE TABLE courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  title text NOT NULL,
  level text NOT NULL DEFAULT 'a1'
    CHECK (level IN ('a1', 'a2', 'b1', 'b2', 'c1', 'c2')),
  description text NOT NULL DEFAULT '',
  visibility text NOT NULL DEFAULT 'draft'
    CHECK (visibility IN ('draft', 'published', 'archived')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX courses_slug_unique ON courses (slug);

CREATE TABLE course_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  title text NOT NULL,
  level text NOT NULL DEFAULT 'a1'
    CHECK (level IN ('a1', 'a2', 'b1', 'b2', 'c1', 'c2')),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 一门课程只允许一个 active draft。
CREATE UNIQUE INDEX course_drafts_one_active_per_course_unique
  ON course_drafts (course_id) WHERE status = 'active';

CREATE TABLE draft_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES course_drafts (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 1),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- position 正整数且同一草稿内不重复；unit_id 即该行 id，草稿内唯一。
CREATE UNIQUE INDEX draft_units_draft_position_unique ON draft_units (draft_id, position);
CREATE UNIQUE INDEX draft_units_draft_unit_id_unique ON draft_units (draft_id, id);
