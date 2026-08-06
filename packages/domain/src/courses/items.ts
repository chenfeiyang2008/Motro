// 课程词项校验（纯领域规则，无副作用）。
// 课程专属中文释义必填；提示可选；完整顺序提交复用单元的排列校验（无重复、无遗漏、无陌生 ID）。

export const ITEM_MEANING_MAX = 500;
export const ITEM_HINT_MAX = 500;

export function validateItemMeaning(input: string): string[] {
  const errors: string[] = [];
  const meaning = input.trim();
  if (meaning.length === 0) errors.push("中文释义不能为空");
  if (meaning.length > ITEM_MEANING_MAX) {
    errors.push(`中文释义不能超过 ${ITEM_MEANING_MAX} 个字符`);
  }
  return errors;
}

export function validateItemHint(hint: string | undefined): string[] {
  if (hint === undefined) return [];
  const trimmed = hint.trim();
  if (trimmed.length === 0) return [];
  return trimmed.length <= ITEM_HINT_MAX ? [] : [`提示不能超过 ${ITEM_HINT_MAX} 个字符`];
}
