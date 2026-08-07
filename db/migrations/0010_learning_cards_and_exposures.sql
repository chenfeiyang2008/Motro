-- 0010_learning_cards_and_exposures
-- 学习卡与学习展示：阶段 5 学习核心的初始数据结构。
--
-- learning_cards：每 (user, course_item, direction) 一张可调度记忆对象，保存 new 状态与 FSRS 初始字段。
--   - 只绑定已发布课程词项的稳定 course_item_id：应用层校验该 ID 属于某已报名课程的 current release，
--     绝不读取草稿表。
--   - course_item_id 不设外键：稳定身份同时存在于可变草稿（draft_course_items）与不可变 release 快照
--     （released_course_items）中，没有父表可引用；0007 的 released_course_items 是唯一真实来源，
--     由应用层保证只引用已发布词项。
--   - 课程版本变更或 current pointer 切换不破坏历史卡；从当前版本移除的词项保留历史卡（不物理删除）。
--
-- learning_exposures：首次看过学习面的事实。
--   - 幂等写入：UNIQUE (user_id, course_item_id)，重复展示返回首次事实。
--   - 不可变：UPDATE/DELETE 由触发器拒绝。
--   - 不改变任何学习卡 FSRS 状态，不产生 ReviewEvent 或 XP。

CREATE TABLE learning_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  course_item_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('en_to_zh', 'zh_to_en')),
  state text NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'learning', 'review')),
  -- FSRS v6 初始字段：工单 02 接入确定性调度后由服务端权威更新，本工单只落初始状态。
  stability double precision NOT NULL DEFAULT 0,
  difficulty double precision NOT NULL DEFAULT 0,
  scheduled_days integer NOT NULL DEFAULT 0,
  elapsed_days integer NOT NULL DEFAULT 0,
  reps integer NOT NULL DEFAULT 0,
  lapses integer NOT NULL DEFAULT 0,
  last_review_at timestamptz,
  due_at timestamptz NOT NULL DEFAULT now(),
  scheduler_version text NOT NULL DEFAULT 'fsrs-v6',
  state_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 每 (user, course_item, direction) 至多一张卡：同一词项两方向独立卡，重复创建幂等。
CREATE UNIQUE INDEX learning_cards_user_item_direction_unique
  ON learning_cards (user_id, course_item_id, direction);

CREATE INDEX learning_cards_user_due_idx ON learning_cards (user_id, due_at);
CREATE INDEX learning_cards_course_item_idx ON learning_cards (course_item_id);
CREATE INDEX learning_cards_course_id_idx ON learning_cards (course_id);

CREATE TABLE learning_exposures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  course_item_id uuid NOT NULL,
  lexical_entry_id uuid NOT NULL,
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  -- 首次展示的来源 release 与 released row：同一 course_item 再次展示仍引用首次事实。
  release_id uuid NOT NULL REFERENCES course_releases (id) ON DELETE RESTRICT,
  released_item_id uuid NOT NULL REFERENCES released_course_items (id) ON DELETE RESTRICT,
  first_exposed_at timestamptz NOT NULL DEFAULT now(),
  request_id text
);

-- 每 (user, course_item) 首次展示至多一行：重复展示幂等，首次事实不可变。
CREATE UNIQUE INDEX learning_exposures_user_item_unique
  ON learning_exposures (user_id, course_item_id);

CREATE INDEX learning_exposures_user_lexical_idx ON learning_exposures (user_id, lexical_entry_id);
CREATE INDEX learning_exposures_course_item_idx ON learning_exposures (course_item_id);

-- 首次展示事实不可变：禁止 UPDATE 与 DELETE。
CREATE OR REPLACE FUNCTION motro_reject_exposure_row_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'learning exposure rows are immutable (update/delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER learning_exposures_no_update BEFORE UPDATE ON learning_exposures
  FOR EACH ROW EXECUTE FUNCTION motro_reject_exposure_row_change();
CREATE TRIGGER learning_exposures_no_delete BEFORE DELETE ON learning_exposures
  FOR EACH ROW EXECUTE FUNCTION motro_reject_exposure_row_change();
