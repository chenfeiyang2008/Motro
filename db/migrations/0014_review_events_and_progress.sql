-- 0014_review_events_and_progress
-- 首测、复习事件与可重建进度（阶段 5 工单 04）。
--
-- ReviewEvent 是学习者对单张学习卡提交一次评分的不可变事实，幂等键为 (user_id, client_event_id)：
--   - 重复提交同一幂等键 + 相同请求 → 返回首次已保存的 response_json（不再调用 FSRS、不再推进 cursor）；
--   - 同一幂等键 + 不同 card/rating/item → 409 IDEMPOTENCY_CONFLICT；
--   - 不同幂等键并发就同一张卡提交 → 第一个有效提交推进，其余在锁释放后安全拒绝或按明确规则处理。
--
-- 本表只记录「复习这一事实」与调度前后的完整 FSRS 状态快照；不创建 XP/进度缓存/单元解锁表。
-- 首测完成、item 已稳定（两方向 scheduled_days >= 21）、单元解锁均必须由 ReviewEvent +
-- 当前发布版本 + learning_cards 完全派生重建（见工单 04 API 实现的唯一派生入口）。
--
-- 不可变：UPDATE/DELETE 由触发器拒绝（不只靠应用约定）。state_before / state_after 存完整 JSON
-- 快照作为审计与重建依据，绝不只存模糊摘要。NOT NULL is_initial_review 明确区分首测与后续复习。
--
-- Scheduler 版本与参数版本随事件冻结：保证之后参数演进时对既有事件驱动的状态可追溯重放。

CREATE TABLE review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES study_sessions (id) ON DELETE RESTRICT,
  session_item_id uuid NOT NULL REFERENCES study_session_items (id) ON DELETE RESTRICT,
  card_id uuid NOT NULL REFERENCES learning_cards (id) ON DELETE RESTRICT,
  -- 用户范围幂等键：客户端每次「对同一评分意图」生成唯一 ID；重试请求复用同一 ID。
  client_event_id text NOT NULL,
  -- 请求规范化哈希：用于区分同一幂等键下的重放（哈希一致）与篡改（哈希不一致 → 409）。
  request_hash text NOT NULL,
  rating text NOT NULL CHECK (rating IN ('again', 'hard', 'good', 'easy')),
  -- 每个方向独立的「首次有效评分」事实：该卡在本次有效评分前还没有任何有效 Review 时即为 true。
  -- 同一词项英文→中文与中文→英文各有自己的首次事件，各自独立判定首测完成。
  is_initial_review boolean NOT NULL,
  scheduler_version text NOT NULL,
  scheduler_parameters_version text NOT NULL,
  -- 完整 FS 状态快照（审计与重建依据）。state_before 为评分前卡内存状态，state_after 为评分后。
  state_before jsonb NOT NULL,
  state_after jsonb NOT NULL,
  -- 权威服务器时间；客户端不得传入 reviewedAt / nextDue / FSRS 数值 / cursor。
  reviewed_at timestamptz NOT NULL,
  -- 幂等重放返回同一 response_json；服务进程内存中只以事件已获批的 response 回放。
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 用户范围幂等：同一 (user_id, client_event_id) 至多一行，防止并发重复提交产生多条事件。
CREATE UNIQUE INDEX review_events_user_client_event_unique
  ON review_events (user_id, client_event_id);

-- 查询用索引：按卡与时间回溯复习史、按会话回溯事件。
CREATE INDEX review_events_card_reviewed_idx ON review_events (card_id, reviewed_at DESC);
CREATE INDEX review_events_session_id_idx ON review_events (session_id);
CREATE INDEX review_events_session_item_idx ON review_events (session_item_id);
CREATE INDEX review_events_user_id_idx ON review_events (user_id);
CREATE INDEX review_events_card_is_initial_idx ON review_events (card_id, is_initial_review);

-- 复习事件不可变：禁止 UPDATE 与 DELETE（数据库触发器，不只靠应用约定）。
CREATE OR REPLACE FUNCTION motro_reject_review_event_row_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'review event rows are immutable (update/delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER review_events_no_update BEFORE UPDATE ON review_events
  FOR EACH ROW EXECUTE FUNCTION motro_reject_review_event_row_change();
CREATE TRIGGER review_events_no_delete BEFORE DELETE ON review_events
  FOR EACH ROW EXECUTE FUNCTION motro_reject_review_event_row_change();