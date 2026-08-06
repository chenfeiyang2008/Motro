// 课程元数据校验（纯领域规则，无副作用）。

export const COURSE_TITLE_MAX = 200;
export const COURSE_DESCRIPTION_MAX = 2000;

export const COURSE_LEVELS = ["a1", "a2", "b1", "b2", "c1", "c2"] as const;
export type CourseLevel = (typeof COURSE_LEVELS)[number];

export function validateCourseTitle(input: string): string[] {
  const errors: string[] = [];
  const title = input.trim();
  if (title.length === 0) errors.push("课程标题不能为空");
  if (title.length > COURSE_TITLE_MAX) errors.push(`课程标题不能超过 ${COURSE_TITLE_MAX} 个字符`);
  return errors;
}

export function validateCourseLevel(level: string | undefined): string[] {
  if (level === undefined) return [];
  const trimmed = level.trim();
  if (trimmed.length === 0) return [];
  return COURSE_LEVELS.includes(trimmed as CourseLevel) ? [] : [`级别不合法：${trimmed}`];
}

export function validateCourseDescription(description: string | undefined): string[] {
  if (description === undefined) return [];
  const trimmed = description.trim();
  if (trimmed.length === 0) return [];
  return trimmed.length <= COURSE_DESCRIPTION_MAX
    ? []
    : [`课程描述不能超过 ${COURSE_DESCRIPTION_MAX} 个字符`];
}
