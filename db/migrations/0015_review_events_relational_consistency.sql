-- 0015_review_events_relationship_fk
-- 为不可变 review_events 补齐数据库级关系一致性（阶段 5 工单 04 P2）。
--
-- 背景：0014 只声明了 session_id → study_sessions(id)、session_item_id → study_session_items(id)、
-- card_id → learning_cards(id) 三个独立外键。PostgreSQL 允许 review_event 的这三列指向
-- 来自【不同】会话 / 不同计划项 / 不同卡的对象（例如 session A + 属于 session B 的 item），
-- 造成审计与重建事实在数据库层就自相矛盾。应用层虽已校验，但不可变审计事实不应只靠应用层保证。
--
-- 本 migration 追加复合约束，保证 review_events 的三列在关系上一致：
--   1) 为 study_session_items 追加支撑复合外键所需的唯一键：
--        UNIQUE (session_id, id)   —— 供 (session_id, session_item_id) 复合引用；
--        UNIQUE (id, card_id)       —— 供 (session_item_id, card_id) 复合引用。
--      这两个键是被引用侧；主键 (id) 已存在，这里补充与 session_id / card_id 组合后的唯一性。
--   2) review_events 追加复合外键：
--        (session_id, session_item_id) → study_session_items (session_id, id)：
--           事件引用的 session_item 必须确实属于其引用的 session；
--        (session_item_id, card_id) → study_session_items (id, card_id)：
--           事件引用的 card 必须确实匹配该 session_item 绑定的卡。
--   两者叠加，等价于「事件的 session、item、card 三元组必须指向同一条 study_session_items」。
--
-- 不修改已应用的 0014（哈希已记录）；本文件是独立追加 migration，与 0013 追加复合外键同风格。
-- 现有的 single-column FK（session_id → study_sessions、session_item_id → study_session_items、
-- card_id → learning_cards）继续存在，各自提供引用完整性；复合 FK 额外强加关系一致性不变量。

-- 支撑复合外键的唯一键（study_session_items 追加）。
CREATE UNIQUE INDEX study_session_items_session_id_id_unique
  ON study_session_items (session_id, id);
CREATE UNIQUE INDEX study_session_items_id_card_id_unique
  ON study_session_items (id, card_id);

-- review_events 复合关系一致性：session / item / card 必须属于同一条计划项。
ALTER TABLE review_events
  ADD CONSTRAINT review_events_session_item_fk
  FOREIGN KEY (session_id, session_item_id)
    REFERENCES study_session_items (session_id, id);

ALTER TABLE review_events
  ADD CONSTRAINT review_events_item_card_fk
  FOREIGN KEY (session_item_id, card_id)
    REFERENCES study_session_items (id, card_id);