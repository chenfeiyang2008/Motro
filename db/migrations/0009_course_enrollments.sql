-- 0009_course_enrollments
-- 学习者报名与唯一主课程。
-- 软停用保留历史（active=false），不物理删除；partial unique index 保证每用户至多一条
-- active 且 is_primary=true 的报名，是主课程切换并发场景的最终防线。

CREATE TABLE course_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  joined_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  is_primary boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 每 (user, course) 至多一行；重复报名幂等，软停用保留历史。
  UNIQUE (user_id, course_id)
);

-- 每用户至多一个 active 且 is_primary=true 的报名。
CREATE UNIQUE INDEX course_enrollments_one_active_primary_per_user
  ON course_enrollments (user_id) WHERE active = true AND is_primary = true;

CREATE INDEX course_enrollments_user_id_idx ON course_enrollments (user_id);
CREATE INDEX course_enrollments_course_id_idx ON course_enrollments (course_id);
