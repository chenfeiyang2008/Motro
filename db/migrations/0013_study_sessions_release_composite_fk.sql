-- 0013_study_sessions_release_composite_fk
-- 为已应用的 0012 追加补丁：study_sessions 必须保证 (course_id, release_id)
-- 引用同一课程的 release，禁止「课程 A + release B」的跨课程快照写入。
--
-- 背景：0012 只声明了 course_id → courses(id) 与 release_id → course_releases(id)
-- 两个独立外键，PostgreSQL 允许 course A 的会话引用课程 B 的 release，造成混合快照。
-- 本 migration 追加复合外键 (course_id, release_id) → course_releases(course_id, id)，
-- 复用 0007 已建立的 course_releases UNIQUE (course_id, id) 作为被引用键。
-- 复合外键与既有单列外键共存；单列外键继续提供各自列的引用完整性，
-- 复合外键额外强加「同一课程」的不变量。
--
-- 不修改已应用的 0012（哈希已记录），本文件是独立追加 migration。

ALTER TABLE study_sessions
  ADD CONSTRAINT study_sessions_course_release_fk
  FOREIGN KEY (course_id, release_id) REFERENCES course_releases (course_id, id);
