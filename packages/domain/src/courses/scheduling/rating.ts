// 学习卡评分（阶段 5 工单 02）：FSRS 只允许四级评分。
// 服务器是调度权威；落入此边界之前，任何 FourScoreRating 之外的评分都必须被拒绝，
// 不得进入数据库或触碰调度计算。

export const FORBIDDEN_RATINGS = ["manual", "skip", "unknown"] as const;

export const FOUR_SCORE_RATINGS = ["again", "hard", "good", "easy"] as const;
export type FourScoreRating = (typeof FOUR_SCORE_RATINGS)[number];

/** 评分是否合法（只允许四级评分）。 */
export function isFourScoreRating(rating: string): rating is FourScoreRating {
  return (FOUR_SCORE_RATINGS as readonly string[]).includes(rating);
}

/** 校验评分：非法评分返回可读错误；合法返回空数组。 */
export function validateRating(rating: string): string[] {
  if (!isFourScoreRating(rating)) {
    return [`评分不合法：${rating}；FSRS 只允许 ${FOUR_SCORE_RATINGS.join(" / ")}，拒绝写入数据库`];
  }
  return [];
}
