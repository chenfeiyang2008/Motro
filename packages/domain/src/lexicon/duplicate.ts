// 词条重复判定（纯领域规则）：命中已有候选时先给可解释警告，不静默合并。
// - 完全相同展示拼写已存在 → 冲突（无论是否确认）；
// - 规范化拼写命中其他候选（同形异义等）且未显式确认 → 重复警告；
// - 管理员显式确认后才允许创建另一个稳定词条。

export interface DuplicateCandidate {
  id: string;
  canonicalSpelling: string;
  normalizedSpelling: string;
}

export type DuplicateEvaluation =
  | { kind: "create" }
  | { kind: "duplicate_warning"; candidates: DuplicateCandidate[] }
  | { kind: "duplicate_exact"; candidate: DuplicateCandidate };

export interface EvaluateDuplicatesInput {
  /** 已 trim 的展示拼写（与库中 canonical_spelling 字节比较判“完全相同”）。 */
  canonicalSpelling: string;
  /** 同规范化拼写下的已有候选。 */
  existing: DuplicateCandidate[];
  /** 管理员是否显式确认允许创建同形异义词条。 */
  confirmDuplicate: boolean;
}

export function evaluateDuplicates(input: EvaluateDuplicatesInput): DuplicateEvaluation {
  const exact = input.existing.find((c) => c.canonicalSpelling === input.canonicalSpelling);
  if (exact) return { kind: "duplicate_exact", candidate: exact };
  if (input.existing.length > 0 && !input.confirmDuplicate) {
    return { kind: "duplicate_warning", candidates: input.existing };
  }
  return { kind: "create" };
}
