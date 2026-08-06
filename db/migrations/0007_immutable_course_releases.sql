-- 0007_immutable_course_releases
-- 发布不可变课程版本并维护当前版本指针。
-- release rows 禁止 UPDATE/DELETE（触发器保护）；修订只发布新版本，恢复只移动指针。
-- current_release_id 通过复合外键保证只能指向同一课程的 release。

CREATE TABLE course_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  release_number integer NOT NULL CHECK (release_number >= 1),
  title text NOT NULL,
  level text NOT NULL
    CHECK (level IN ('a1', 'a2', 'b1', 'b2', 'c1', 'c2')),
  description text NOT NULL DEFAULT '',
  source_draft_version integer NOT NULL,
  content_hash text NOT NULL,
  release_note text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, release_number),
  -- 供 current pointer 复合外键 (course_id, id) 引用。
  UNIQUE (course_id, id)
);

CREATE INDEX course_releases_course_id_idx ON course_releases (course_id);

CREATE TABLE released_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES course_releases (id) ON DELETE CASCADE,
  unit_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  UNIQUE (release_id, position),
  UNIQUE (release_id, unit_id)
);

CREATE INDEX released_units_release_id_idx ON released_units (release_id);

CREATE TABLE released_course_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES course_releases (id) ON DELETE CASCADE,
  released_unit_id uuid NOT NULL REFERENCES released_units (id) ON DELETE CASCADE,
  course_item_id uuid NOT NULL,
  lexical_entry_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  english_spelling text NOT NULL,
  meaning text NOT NULL,
  hint text,
  content_review_reference uuid NOT NULL,
  UNIQUE (release_id, released_unit_id, position),
  UNIQUE (release_id, course_item_id)
);

CREATE INDEX released_course_items_release_id_idx ON released_course_items (release_id);

-- current pointer：复合外键保证 release 属于同一课程；NULL 表示尚未发布。
ALTER TABLE courses
  ADD COLUMN current_release_id uuid,
  ADD CONSTRAINT courses_current_release_fk
    FOREIGN KEY (id, current_release_id) REFERENCES course_releases (course_id, id);

-- 草稿基于哪个发布版本（nullable；发布后记录）。
ALTER TABLE course_drafts
  ADD COLUMN based_on_release_id uuid REFERENCES course_releases (id);

-- release rows 不可变：禁止 UPDATE 与 DELETE。
CREATE OR REPLACE FUNCTION motro_reject_release_row_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'release rows are immutable (update/delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER course_releases_no_update BEFORE UPDATE ON course_releases
  FOR EACH ROW EXECUTE FUNCTION motro_reject_release_row_change();
CREATE TRIGGER course_releases_no_delete BEFORE DELETE ON course_releases
  FOR EACH ROW EXECUTE FUNCTION motro_reject_release_row_change();
CREATE TRIGGER released_units_no_update BEFORE UPDATE ON released_units
  FOR EACH ROW EXECUTE FUNCTION motro_reject_release_row_change();
CREATE TRIGGER released_units_no_delete BEFORE DELETE ON released_units
  FOR EACH ROW EXECUTE FUNCTION motro_reject_release_row_change();
CREATE TRIGGER released_course_items_no_update BEFORE UPDATE ON released_course_items
  FOR EACH ROW EXECUTE FUNCTION motro_reject_release_row_change();
CREATE TRIGGER released_course_items_no_delete BEFORE DELETE ON released_course_items
  FOR EACH ROW EXECUTE FUNCTION motro_reject_release_row_change();
