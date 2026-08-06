// 学习者报名状态映射（纯规则）：根据报名行计算 isEnrolled / isPrimary。
// 软停用（active=false）的报名视为未报名，但历史行仍保留。

export interface EnrollmentState {
  isEnrolled: boolean;
  isPrimary: boolean;
}

export interface EnrollmentRowInput {
  active: boolean;
  is_primary: boolean;
}

/** 报名行（可能为 null）→ 该课程对当前用户的状态。 */
export function buildEnrollmentState(row: EnrollmentRowInput | null): EnrollmentState {
  if (!row || !row.active) return { isEnrolled: false, isPrimary: false };
  return { isEnrolled: true, isPrimary: row.is_primary === true };
}
