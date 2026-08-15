// 工单 09：可重建学习指标——纯领域派生规则。
//
// 所有指标都是「只读、可由既有事实重建的 projection」：
//   - 稳定词项：某 course_item 的两个方向 learning_cards.scheduled_days 都 >= STABLE_SCHEDULED_DAYS。
//   - 首测完成：course_item 两个方向都存在 is_initial_review=true 的有效 review_event。
//   - 待复习：learning_cards.state='review' 且 due_at <= asOf。
//
// 不引入 XP、排行榜、会员或 CEFR。不做任何持久化——指标每次由当前事实重算。
import { STABLE_SCHEDULED_DAYS } from "../courses/progress.js";

/** 一个 course_item 的方向快照（来自 learning_cards 的两个方向行）。 */
export interface ItemCardSnapshot {
  itemId: string;
  enScheduledDays: number;
  zhScheduledDays: number;
  enState: string;
  zhState: string;
  enDueAt: Date | null;
  zhDueAt: Date | null;
  /** 该方向是否有 is_initial_review=true 的有效事件（由调用方从 review_events 汇总）。 */
  enInitialReviewed: boolean;
  zhInitialReviewed: boolean;
}

/** 词项是否稳定（双向 scheduled_days 均达阈值）。 */
export function metricItemStable(snap: ItemCardSnapshot): boolean {
  return (
    snap.enScheduledDays >= STABLE_SCHEDULED_DAYS && snap.zhScheduledDays >= STABLE_SCHEDULED_DAYS
  );
}

/** 词项是否完成双向首测。 */
export function metricItemInitiallyCompleted(snap: ItemCardSnapshot): boolean {
  return snap.enInitialReviewed && snap.zhInitialReviewed;
}

/** 词项是否待复习：至少一个方向 state='review' 且 due_at <= asOf。 */
export function metricItemDueForReview(snap: ItemCardSnapshot, asOf: Date): boolean {
  const enDue =
    snap.enState === "review" && snap.enDueAt !== null && snap.enDueAt.getTime() <= asOf.getTime();
  const zhDue =
    snap.zhState === "review" && snap.zhDueAt !== null && snap.zhDueAt.getTime() <= asOf.getTime();
  return enDue || zhDue;
}

/** 从词项快照聚合「当前范围内已稳定词项数」。 */
export function countStableItems(snapshots: ItemCardSnapshot[]): number {
  return snapshots.filter(metricItemStable).length;
}

/** 从词项快照聚合「当前范围内已双向首测词项数」。 */
export function countInitiallyCompletedItems(snapshots: ItemCardSnapshot[]): number {
  return snapshots.filter(metricItemInitiallyCompleted).length;
}

/** 从词项快照聚合「当前范围内待复习词项数」（去重：每 item 至多计 1）。 */
export function countDueForReviewItems(snapshots: ItemCardSnapshot[], asOf: Date): number {
  return snapshots.filter((s) => metricItemDueForReview(s, asOf)).length;
}

/** 课程完成度：已完成双向首测的词项 / 当前 release 中的词项总数（0..1）。 */
export function completionRatio(initiallyCompletedCount: number, scopedItemCount: number): number {
  if (scopedItemCount <= 0) return 0;
  return Math.min(1, initiallyCompletedCount / scopedItemCount);
}
