// 每日计划构建（阶段 5 工单 03）：纯函数、服务端权威、可确定性测试。
//
// 计划规则固定为 daily-plan-v1：
//   - 1 个会话计划项预计占用 1 分钟（本票明确采用该估算，预算即计划项数量上限）。
//   - 先安排 due_review（state=review 且 due_at <= 服务器 now；最早到期者优先，平手按 cardId 稳定排序）。
//   - 再安排 initial_review（state=learning 的卡）。
//   - 最后安排 new_learning（state=new 的卡；只允许来自 current release 的第一个单元，
//     不得提前安排后续单元；同一单元内按词项展示位置稳定排序）。
//   - 预算不足按上述顺序截断。
//
// 本模块不触碰数据库、不读取草稿、不创建会话；只把「候选卡 + 服务器时间 + 预算」规整为有序计划。
// 无候选项时返回空计划（上层据此返回 no-work，不创建空 active 会话）。

export const PLAN_RULE_VERSION = "daily-plan-v1";

export const PLAN_ITEM_KINDS = ["due_review", "initial_review", "new_learning"] as const;
export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number];

/** 候选卡：计划输入（来自 learning_cards 与 current release 的稳定快照）。 */
export interface PlanCardCandidate {
  cardId: string;
  courseItemId: string;
  direction: "en_to_zh" | "zh_to_en";
  state: "new" | "learning" | "review";
  /** new 卡立即到期；review 卡为 FSRS 到期时间。 */
  dueAt: string;
  /**
   * 仅 new 卡需要：该词项在 current release 中的稳定单元位置与单元内词项位置。
   * 用于「只取第一个单元」过滤与单元内稳定排序。learning/review 卡忽略。
   */
  releasedUnitPosition?: number;
  releasedItemPosition?: number;
}

export interface PlanItem {
  cardId: string;
  courseItemId: string;
  direction: "en_to_zh" | "zh_to_en";
  itemKind: PlanItemKind;
}

export interface BuildDailyPlanInput {
  /** 候选卡：已按用户 + 主课程 current release 过滤。 */
  cards: PlanCardCandidate[];
  /** 服务器权威时间（UTC）。 */
  now: Date;
  /** 计划项预算（分钟）：来自 users.daily_budget_minutes。 */
  budgetMinutes: number;
  /**
   * 允许进入计划的第一个单元位置。本工单固定为 1（current release 第一个单元）；
   * 之后单元解锁逻辑推进该值时不改本规则版本。
   */
  firstUnitPosition: number;
}

/**
 * 计划规则分类：把一张候选卡归入 itemKind；null 表示该卡本规则下不进计划
 * （未到期 review 卡、不在 current release 或非首单元的 new 卡）。
 */
export function classifyPlanItem(
  card: PlanCardCandidate,
  now: Date,
  firstUnitPosition: number,
): PlanItemKind | null {
  if (card.state === "review") {
    if (new Date(card.dueAt).getTime() <= now.getTime()) return "due_review";
    return null; // 未到期 review 卡不进入计划
  }
  if (card.state === "learning") return "initial_review";
  if (card.state === "new") {
    // 只允许第一个单元的新卡进入计划；后续单元新卡不得提前安排。
    if (card.releasedUnitPosition === undefined || card.releasedUnitPosition === null) return null;
    if (card.releasedUnitPosition !== firstUnitPosition) return null;
    return "new_learning";
  }
  return null;
}

/** 稳定比较：due 最早优先；平手按 cardId 稳定。 */
function compareDue(a: PlanCardCandidate, b: PlanCardCandidate): number {
  const diff = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  if (diff !== 0) return diff;
  return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
}

/** 稳定比较：initial（learning）卡按 cardId 稳定；review 卡优先于 learning 卡。 */
function compareInitial(a: PlanCardCandidate, b: PlanCardCandidate): number {
  // review 恒在 learning 之前（调用方已按规则归组，这里只做组内稳定）。
  if (a.state === "review" && b.state !== "review") return -1;
  if (a.state !== "review" && b.state === "review") return 1;
  return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
}

/** 稳定比较：new 卡按（单元位置, 词项位置, cardId）稳定。 */
function compareNew(a: PlanCardCandidate, b: PlanCardCandidate): number {
  const ua = a.releasedUnitPosition ?? Number.MAX_SAFE_INTEGER;
  const ub = b.releasedUnitPosition ?? Number.MAX_SAFE_INTEGER;
  if (ua !== ub) return ua - ub;
  const pa = a.releasedItemPosition ?? Number.MAX_SAFE_INTEGER;
  const pb = b.releasedItemPosition ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
}

/**
 * 构建每日计划（纯函数）：
 * 输入候选卡 + 服务器时间 + 预算 + 首单元位置 → 有序计划项（due > initial > new，截断到预算）。
 * 返回空数组表示 no-work。
 */
export function buildDailyPlan(input: BuildDailyPlanInput): PlanItem[] {
  const budget = Math.max(0, Math.floor(input.budgetMinutes));
  if (budget < 1) return [];

  const { now, firstUnitPosition } = input;

  // 组内排序：due（最早到期）、initial（稳定）、new（单元内位置）。
  const due = input.cards
    .filter((c) => classifyPlanItem(c, now, firstUnitPosition) === "due_review")
    .sort(compareDue);
  const initial = input.cards
    .filter((c) => classifyPlanItem(c, now, firstUnitPosition) === "initial_review")
    .sort(compareInitial);
  const fresh = input.cards
    .filter((c) => classifyPlanItem(c, now, firstUnitPosition) === "new_learning")
    .sort(compareNew);

  const ordered = [...due, ...initial, ...fresh];
  const taken = ordered.slice(0, budget);

  return taken.map((c) => ({
    cardId: c.cardId,
    courseItemId: c.courseItemId,
    direction: c.direction,
    itemKind: classifyPlanItem(c, now, firstUnitPosition) as PlanItemKind,
  }));
}
