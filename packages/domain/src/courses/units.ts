// 单元与排序校验（纯领域规则，无副作用）。
// position 必须为正整数；重排必须提交现有 unit ID 的完整排列（无重复、无遗漏）。

export const UNIT_TITLE_MAX = 200;
export const UNIT_DESCRIPTION_MAX = 2000;

export function validateUnitTitle(input: string): string[] {
  const errors: string[] = [];
  const title = input.trim();
  if (title.length === 0) errors.push("单元标题不能为空");
  if (title.length > UNIT_TITLE_MAX) errors.push(`单元标题不能超过 ${UNIT_TITLE_MAX} 个字符`);
  return errors;
}

export function validateUnitDescription(description: string | undefined): string[] {
  if (description === undefined) return [];
  const trimmed = description.trim();
  if (trimmed.length === 0) return [];
  return trimmed.length <= UNIT_DESCRIPTION_MAX
    ? []
    : [`单元描述不能超过 ${UNIT_DESCRIPTION_MAX} 个字符`];
}

export function validateUnitPosition(position: number): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(position)) errors.push("单元位置必须为整数");
  if (position < 1) errors.push("单元位置必须为正整数");
  return errors;
}

/**
 * 校验提交的单元顺序是否为现有单元 ID 的完整排列。
 * 返回字段错误；空数组表示通过。existingIds 为草稿当前单元 ID（按 position 升序）。
 */
export function validateUnitOrder(existingIds: string[], submittedIds: string[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(submittedIds) || submittedIds.some((id) => typeof id !== "string")) {
    return ["单元顺序必须是单元 ID 数组"];
  }
  if (existingIds.length === 0 && submittedIds.length === 0) {
    return [];
  }
  const existingSet = new Set(existingIds);
  if (submittedIds.length !== existingIds.length) {
    errors.push(`单元顺序必须包含全部 ${existingIds.length} 个单元，不能多也不能少`);
    return errors;
  }
  const seen = new Set<string>();
  for (const id of submittedIds) {
    if (!existingSet.has(id)) {
      errors.push("单元顺序包含不存在的单元 ID");
      break;
    }
    if (seen.has(id)) {
      errors.push("单元顺序包含重复的单元 ID");
      break;
    }
    seen.add(id);
  }
  return errors;
}
