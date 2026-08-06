// 课程 slug 规范（纯领域规则，无副作用）。
// slug 用于稳定标识与 URL；小写字母/数字/单连字符，不能以连字符开头/结尾。

export const SLUG_MAX_LENGTH = 64;
export const SLUG_MIN_LENGTH = 2;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 查询/存储规范化：外层 trim、小写、内部空白折叠为单个连字符。 */
export function normalizeSlug(input: string): string {
  return input.trim().replace(/\s+/g, "-").toLowerCase();
}

export function validateSlug(input: string): string[] {
  const errors: string[] = [];
  const slug = input.trim();
  if (slug.length === 0) errors.push("slug 不能为空");
  if (slug.length < SLUG_MIN_LENGTH) errors.push(`slug 至少 ${SLUG_MIN_LENGTH} 个字符`);
  if (slug.length > SLUG_MAX_LENGTH) errors.push(`slug 不能超过 ${SLUG_MAX_LENGTH} 个字符`);
  if (slug.length > 0 && !SLUG_RE.test(slug)) {
    errors.push("slug 只允许小写字母、数字与单个连字符");
  }
  return errors;
}
