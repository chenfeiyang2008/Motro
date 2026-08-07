// 可重建进度派生（阶段 5 工单 04）。
//
// 本模块只提供「纯函数 + 类型」来描述从 ReviewEvent 与当前发布版本派生首测完成、item 稳定与单元解锁
// 的规则。它不触碰数据库；真正的派生查询（读 review_events + released_course_items + released_units）
// 由 API 服务的唯一派生入口实现。测试可在任意固定输入上确定性断言规则本身。
//
// 派生规则（阶段规则 4 + 工单 04）：
//   - 某课程词项的「首测完成」= 英→中 与 中→英 两张卡都至少存在一条 is_initial_review=true 的
//     有效 ReviewEvent。
//   - 单元解锁：按 current release 的 released_units 位置连续解锁；第一个单元默认解锁，
//     当前单元内每个课程词项都完成双向首测后，下一单元解锁。
//   - item.stable = 两个方向的 scheduled_days（最近一次有效评分后的卡）都 >= 21；只是派生状态，
//     不是人工标签。
//
// STABLE_SCHEDULED_DAYS >= 21 判定统一在此处，避免各调用方各自写死阈值导致漂移。

export const STABLE_SCHEDULED_DAYS = 21;

/** 单元在 current release 中的派生进度输入：以 released_units.position 为键。 */
export interface UnitProgressItem {
  /** current release 中的单元顺序位置（released_units.position）。 */
  position: number;
  /** 本单元内应参与解锁判定的课程词项数（来自 current release 快照）。 */
  requiredItemCount: number;
  /** 本单元内已完成双向首测的课程词项数。 */
  initialCompletedItemCount: number;
}

/** 派生后的单元进度：在输入基础上附加解锁状态。 */
export interface UnitProgressDerived extends UnitProgressItem {
  unlocked: boolean;
}

/**
 * 给定按 current release position 升序的单元进度输入，派生每个单元的解锁状态。
 * 规则：第一个单元默认解锁；第 n（n>1）单元解锁 ⟺ 第 n-1 个单元已解锁且其所有词项都完成双向首测。
 * 该规则不依赖「当前已完成单元」的手工标签，完全由事件与当前版本可重建。
 * 连续不变量：解锁判定必须同时看「前一单元是否已解锁」与「前一单元是否全部首测完成」，
 * 任一不满足则本单元（及其后一切单元）保持锁定。
 */
export function deriveUnitUnlocked(units: UnitProgressItem[]): UnitProgressDerived[] {
  const sorted = [...units].sort((a, b) => a.position - b.position);
  const derived: UnitProgressDerived[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const unit = sorted[i]!;
    if (i === 0) {
      derived.push({ ...unit, unlocked: true });
      continue;
    }
    const prev = derived[i - 1]!;
    // 连续解锁不变量：前一单元必须「已解锁且所有权项都完成双向首测」，本单元才解锁。
    const prevDone =
      prev.unlocked &&
      prev.requiredItemCount > 0 &&
      prev.initialCompletedItemCount === prev.requiredItemCount;
    derived.push({ ...unit, unlocked: prevDone });
  }
  return derived;
}

/**
 * 派生「当前可学习/最高已解锁单元 position」。
 * 返回所有派生为已解锁的单元中 position 最大的一个；没有任何解锁单元时回退到第一个单元的 position。
 */
export function deriveHighestUnlockedUnitPosition(units: UnitProgressItem[]): number {
  const derived = deriveUnitUnlocked(units);
  if (derived.length === 0) return 1;
  let max = 0;
  for (const u of derived) {
    if (u.unlocked && u.position > max) max = u.position;
  }
  // 第一个单元默认解锁；即便输入异常也保证至少 1。
  return max === 0 ? derived[0]!.position : max;
}

/** 单卡「稳定」派生判定：该方向 scheduledDays 至少达到稳定阈值。 */
export function directionStable(scheduledDays: number): boolean {
  return scheduledDays >= STABLE_SCHEDULED_DAYS;
}

/** 词项「已稳定」派生判定：两个方向的最近 scheduledDays 都 >= 21 才为 stable。 */
export function itemStable(enToZhScheduledDays: number, zhToEnScheduledDays: number): boolean {
  return directionStable(enToZhScheduledDays) && directionStable(zhToEnScheduledDays);
}

/** 单方向「首测完成」派生判定：该方向至少一条 is_initial_review=true 的有效事件。 */
export function directionInitiallyReviewed(hasInitialEvent: boolean): boolean {
  return hasInitialEvent;
}

/** 词项「首测完成」派生判定：两个方向各自都完成首测。 */
export function itemInitialCompleted(firstDirection: boolean, secondDirection: boolean): boolean {
  return firstDirection && secondDirection;
}
