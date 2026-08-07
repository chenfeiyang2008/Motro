-- 0012_study_sessions_and_items
-- 每日计划与可恢复学习会话（阶段 5 工单 03）。
--
-- 背景：学习者按时间预算 + 主课程 current release + 卡状态生成服务端计划；
-- 会话是计划的可恢复快照，不是调度真相的来源（调度真相在 learning_cards）。
-- 本工单不提交评分、不创建 ReviewEvent、不更新 FSRS 卡状态。
--
-- study_sessions：
--   - 一个用户至多一个 active（未完成/未放弃）会话；数据库部分唯一索引作最终并发防线，
--     应用层在同一事务内按用户序列化创建（见 API 实现）。
--   - 快照字段：session 创建时刻的 daily_budget_minutes（users 预算）与 plan_rule_version
--     （计划规则版本），保证之后规则演进不影响既有会话。
--   - release_id 冻结会话创建时刻的 current release；之后课程指针切换不影响既有会话。
--   - cursor 为计划推进位置（下一个待展示的 item position），用于刷新恢复。
--
-- study_session_items：
--   - 计划项绑定 card_id（学习卡）与稳定 course_item_id（课程词项）；
--     每方向独立卡 → 同一词项可有两张不同方向的计划项。
--   - item_kind：due_review（到期复习，state=review 且 due_at<=now）、
--     initial_review（首次复习，state=learning）、new_learning（新卡，state=new）。
--   - state：pending（未展示）| shown（已展示，由后续展示端点推进）| completed |
--     skipped_by_server（服务端跳过，如卡已不再可调度）。
--   - position 在会话内唯一（顺序来源，绝不用创建时间排序）。

CREATE TABLE study_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES course_releases (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'abandoned')),
  daily_budget_minutes integer NOT NULL,
  plan_rule_version text NOT NULL,
  cursor integer NOT NULL DEFAULT 1,
  planned_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (daily_budget_minutes BETWEEN 1 AND 120),
  CHECK (cursor >= 1)
);

-- 一个用户至多一个可恢复 active 会话：创建会话的最终并发防线。
CREATE UNIQUE INDEX study_sessions_user_active_unique
  ON study_sessions (user_id) WHERE status = 'active';

CREATE INDEX study_sessions_user_id_idx ON study_sessions (user_id);
CREATE INDEX study_sessions_release_id_idx ON study_sessions (release_id);

CREATE TABLE study_session_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES study_sessions (id) ON DELETE CASCADE,
  position integer NOT NULL,
  card_id uuid NOT NULL REFERENCES learning_cards (id) ON DELETE RESTRICT,
  course_item_id uuid NOT NULL,
  item_kind text NOT NULL
    CHECK (item_kind IN ('due_review', 'initial_review', 'new_learning')),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'shown', 'completed', 'skipped_by_server')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (position >= 1)
);

-- 会话内顺序唯一：position 是计划顺序来源。
CREATE UNIQUE INDEX study_session_items_session_position_unique
  ON study_session_items (session_id, position);

CREATE INDEX study_session_items_session_id_idx ON study_session_items (session_id);
CREATE INDEX study_session_items_card_id_idx ON study_session_items (card_id);
