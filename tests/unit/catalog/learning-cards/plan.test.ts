// 每日计划纯函数单测（阶段 5 工单 03）。
// 确定性验证 daily-plan-v1 规则：due > initial > new 的顺序、最早到期优先 + 稳定二级排序、
// 预算截断、无任务返回空数组、未到期 review 不进计划、后续单元 new 卡不提前、learning 归入 initial。
import { describe, expect, it } from "vitest";
import {
  buildDailyPlan,
  classifyPlanItem,
  PLAN_RULE_VERSION,
  type PlanCardCandidate,
} from "@motro/domain";

const NOW = new Date("2026-08-07T12:00:00.000Z");

/** 构造候选卡；跳过 unit/item 位置可模拟非 new 卡（review/learning）。 */
function card(over: Partial<PlanCardCandidate> & { cardId: string }): PlanCardCandidate {
  const base: PlanCardCandidate = {
    courseItemId: `item-${over.cardId}`,
    direction: "en_to_zh",
    state: "new",
    dueAt: "2026-08-07T00:00:00.000Z",
    ...over,
  };
  return base;
}

describe("classifyPlanItem", () => {
  it("PLAN_RULE_VERSION 固定为 daily-plan-v1", () => {
    expect(PLAN_RULE_VERSION).toBe("daily-plan-v1");
  });

  it("review 卡到期或不逾期分别归为 due_review / 不进计划", () => {
    const due = card({ cardId: "a", state: "review", dueAt: "2026-08-07T11:00:00.000Z" });
    expect(classifyPlanItem(due, NOW, 1)).toBe("due_review");

    const notDue = card({ cardId: "b", state: "review", dueAt: "2026-08-08T00:00:00.000Z" });
    expect(classifyPlanItem(notDue, NOW, 1)).toBeNull();
  });

  it("review 恰在 now 到期也算 due_review（<= 边界）", () => {
    const edge = card({ cardId: "a", state: "review", dueAt: "2026-08-07T12:00:00.000Z" });
    expect(classifyPlanItem(edge, NOW, 1)).toBe("due_review");
  });

  it("learning 卡归入 initial_review", () => {
    const c = card({ cardId: "l", state: "learning" });
    expect(classifyPlanItem(c, NOW, 1)).toBe("initial_review");
  });

  it("new 卡只允许第一个单元；后续单元不进计划", () => {
    const first = card({
      cardId: "n1",
      state: "new",
      releasedUnitPosition: 1,
      releasedItemPosition: 1,
    });
    expect(classifyPlanItem(first, NOW, 1)).toBe("new_learning");

    const later = card({
      cardId: "n2",
      state: "new",
      releasedUnitPosition: 2,
      releasedItemPosition: 1,
    });
    expect(classifyPlanItem(later, NOW, 1)).toBeNull();
  });

  it("new 卡缺少单元/词项位置时不进计划", () => {
    const missing = card({ cardId: "n", state: "new" });
    expect(classifyPlanItem(missing, NOW, 1)).toBeNull();
  });

  it("unlock 推进到单元 2 后，单元 2 的 new 卡可排", () => {
    const second = card({
      cardId: "s",
      state: "new",
      releasedUnitPosition: 2,
      releasedItemPosition: 1,
    });
    expect(classifyPlanItem(second, NOW, 2)).toBe("new_learning");
    const first = card({
      cardId: "f",
      state: "new",
      releasedUnitPosition: 1,
      releasedItemPosition: 1,
    });
    expect(classifyPlanItem(first, NOW, 2)).toBeNull();
  });
});

describe("buildDailyPlan", () => {
  it("无候选返回空数组（no-work），不产生任何项", () => {
    expect(
      buildDailyPlan({ cards: [], now: NOW, budgetMinutes: 10, firstUnitPosition: 1 }),
    ).toEqual([]);
  });

  it("排序：due_review -> initial_review -> new_learning", () => {
    const plan = buildDailyPlan({
      cards: [
        card({ cardId: "new", state: "new", releasedUnitPosition: 1, releasedItemPosition: 1 }),
        card({ cardId: "learn", state: "learning" }),
        card({ cardId: "due", state: "review", dueAt: "2026-08-07T01:00:00.000Z" }),
      ],
      now: NOW,
      budgetMinutes: 10,
      firstUnitPosition: 1,
    });
    expect(plan.map((p) => p.itemKind)).toEqual(["due_review", "initial_review", "new_learning"]);
    expect(plan.map((p) => p.cardId)).toEqual(["due", "learn", "new"]);
  });

  it("due 内最早到期优先；平手按 cardId 稳定排序", () => {
    const plan = buildDailyPlan({
      cards: [
        card({ cardId: "z", state: "review", dueAt: "2026-08-07T05:00:00.000Z" }),
        card({ cardId: "m", state: "review", dueAt: "2026-08-07T05:00:00.000Z" }),
        card({ cardId: "a", state: "review", dueAt: "2026-08-07T01:00:00.000Z" }),
      ],
      now: NOW,
      budgetMinutes: 10,
      firstUnitPosition: 1,
    });
    expect(plan.map((p) => p.cardId)).toEqual(["a", "m", "z"]);
  });

  it("预算不足按 due > initial > new 截断", () => {
    const plan = buildDailyPlan({
      cards: [
        card({ cardId: "n", state: "new", releasedUnitPosition: 1, releasedItemPosition: 1 }),
        card({ cardId: "l", state: "learning" }),
        card({ cardId: "d", state: "review", dueAt: "2026-08-07T00:00:00.000Z" }),
      ],
      now: NOW,
      budgetMinutes: 1,
      firstUnitPosition: 1,
    });
    expect(plan.map((p) => p.cardId)).toEqual(["d"]);
  });

  it("预算为 0 或负数不产生任何项", () => {
    expect(
      buildDailyPlan({
        cards: [card({ cardId: "d", state: "review", dueAt: "2026-08-07T00:00:00.000Z" })],
        now: NOW,
        budgetMinutes: 0,
        firstUnitPosition: 1,
      }),
    ).toEqual([]);
    expect(
      buildDailyPlan({
        cards: [card({ cardId: "d", state: "review", dueAt: "2026-08-07T00:00:00.000Z" })],
        now: NOW,
        budgetMinutes: -5,
        firstUnitPosition: 1,
      }),
    ).toEqual([]);
  });

  it("预算小数向下取整", () => {
    const plan = buildDailyPlan({
      cards: [
        card({ cardId: "a", state: "review", dueAt: "2026-08-07T00:00:00.000Z" }),
        card({ cardId: "b", state: "review", dueAt: "2026-08-07T01:00:00.000Z" }),
      ],
      now: NOW,
      budgetMinutes: 1.9,
      firstUnitPosition: 1,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]?.cardId).toBe("a");
  });

  it("new 卡按（单元位置, 词项位置, cardId）稳定排序", () => {
    const plan = buildDailyPlan({
      cards: [
        card({ cardId: "a", state: "new", releasedUnitPosition: 1, releasedItemPosition: 2 }),
        card({ cardId: "b", state: "new", releasedUnitPosition: 1, releasedItemPosition: 2 }),
        card({ cardId: "c", state: "new", releasedUnitPosition: 1, releasedItemPosition: 1 }),
      ],
      now: NOW,
      budgetMinutes: 10,
      firstUnitPosition: 1,
    });
    expect(plan.map((p) => p.cardId)).toEqual(["c", "a", "b"]);
  });

  it("未到期 review 与后续单元 new 绝不进入计划", () => {
    const plan = buildDailyPlan({
      cards: [
        card({ cardId: "nd", state: "review", dueAt: "2026-08-08T00:00:00.000Z" }),
        card({ cardId: "u2", state: "new", releasedUnitPosition: 2, releasedItemPosition: 1 }),
      ],
      now: NOW,
      budgetMinutes: 10,
      firstUnitPosition: 1,
    });
    expect(plan).toEqual([]);
  });

  it("计划项绑定稳定 course_item_id 与 itemKind", () => {
    const plan = buildDailyPlan({
      cards: [
        card({
          cardId: "d",
          courseItemId: "item-d",
          state: "review",
          dueAt: "2026-08-07T00:00:00.000Z",
        }),
      ],
      now: NOW,
      budgetMinutes: 10,
      firstUnitPosition: 1,
    });
    expect(plan[0]).toMatchObject({ cardId: "d", courseItemId: "item-d", itemKind: "due_review" });
  });

  it("候选计数（classifyPlanItem）不受预算截断：预算 1 只产生 1 项但全部候选可分类", () => {
    const candidates = [
      card({ cardId: "d1", state: "review", dueAt: "2026-08-07T00:00:00.000Z" }),
      card({ cardId: "d2", state: "review", dueAt: "2026-08-07T01:00:00.000Z" }),
      card({ cardId: "l", state: "learning" }),
      card({ cardId: "n", state: "new", releasedUnitPosition: 1, releasedItemPosition: 1 }),
    ];
    // 预算 1 → 只取最早 due 卡 1 项。
    const plan = buildDailyPlan({
      cards: candidates,
      now: NOW,
      budgetMinutes: 1,
      firstUnitPosition: 1,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]?.cardId).toBe("d1");

    // 但所有候选各自可分类（计数不受截断影响）。
    const kinds = candidates.map((c) => classifyPlanItem(c, NOW, 1)).filter(Boolean);
    expect(kinds).toEqual(["due_review", "due_review", "initial_review", "new_learning"]);
  });

  it("候选计数含全部类：due/initial/new 数量完整且与预算无关", () => {
    const candidates = [
      card({ cardId: "d1", state: "review", dueAt: "2026-08-07T00:00:00.000Z" }),
      card({ cardId: "d2", state: "review", dueAt: "2026-08-07T01:00:00.000Z" }),
      card({ cardId: "l1", state: "learning" }),
      card({ cardId: "l2", state: "learning" }),
      card({ cardId: "n1", state: "new", releasedUnitPosition: 1, releasedItemPosition: 1 }),
      card({ cardId: "n2", state: "new", releasedUnitPosition: 1, releasedItemPosition: 2 }),
    ];
    const countKinds = (budget: number): { due: number; initial: number; fresh: number } => {
      const plan = buildDailyPlan({
        cards: candidates,
        now: NOW,
        budgetMinutes: budget,
        firstUnitPosition: 1,
      });
      return {
        due: plan.filter((p) => p.itemKind === "due_review").length,
        initial: plan.filter((p) => p.itemKind === "initial_review").length,
        fresh: plan.filter((p) => p.itemKind === "new_learning").length,
      };
    };
    // 预算 10：全部候选进计划。
    expect(countKinds(10)).toEqual({ due: 2, initial: 2, fresh: 2 });
    // 预算 3：due 全进（2）+ initial 1，但候选仍为 2/2/2。
    expect(countKinds(3)).toEqual({ due: 2, initial: 1, fresh: 0 });
  });

  it("noWork 只表示没有任何合格候选：预算 1 时仍有候选则 non-empty 计划", () => {
    // 预算 0 → 空计划（noWork），即便有候选。
    expect(
      buildDailyPlan({
        cards: [card({ cardId: "d", state: "review", dueAt: "2026-08-07T00:00:00.000Z" })],
        now: NOW,
        budgetMinutes: 0,
        firstUnitPosition: 1,
      }),
    ).toEqual([]);
    // 预算 1 + 有候选 → 非空计划（不是 noWork），只是被截断。
    expect(
      buildDailyPlan({
        cards: [card({ cardId: "d", state: "review", dueAt: "2026-08-07T00:00:00.000Z" })],
        now: NOW,
        budgetMinutes: 1,
        firstUnitPosition: 1,
      }),
    ).toHaveLength(1);
  });
});
