// 进度派生纯函数单测（阶段 5 工单 04）。
// 确定性验证：首测完成判定、item 稳定判定、单元连续解锁、最高已解锁单元派生、
// 以及这些规则由事件/快照完全重建（不依赖手工标签、不依赖数据库）。
import { describe, expect, it } from "vitest";
import {
  deriveHighestUnlockedUnitPosition,
  deriveUnitUnlocked,
  directionInitiallyReviewed,
  directionStable,
  itemInitialCompleted,
  itemStable,
  STABLE_SCHEDULED_DAYS,
  type UnitProgressItem,
} from "@motro/domain";

describe("STABLE_SCHEDULED_DAYS", () => {
  it("稳定阈值固定为 21 天", () => {
    expect(STABLE_SCHEDULED_DAYS).toBe(21);
  });
});

describe("首测完成派生", () => {
  it("单方向：有首测事件才认为该方向首测完成", () => {
    expect(directionInitiallyReviewed(true)).toBe(true);
    expect(directionInitiallyReviewed(false)).toBe(false);
  });

  it("词项首测完成 = 两个方向都各自有首测事件", () => {
    expect(itemInitialCompleted(true, true)).toBe(true);
    expect(itemInitialCompleted(true, false)).toBe(false);
    expect(itemInitialCompleted(false, true)).toBe(false);
    expect(itemInitialCompleted(false, false)).toBe(false);
  });
});

describe("item 稳定派生", () => {
  it("两个方向的 scheduledDays 都 >= 21 才稳定", () => {
    expect(itemStable(21, 21)).toBe(true);
    expect(itemStable(30, 25)).toBe(true);
    expect(itemStable(20, 25)).toBe(false);
    expect(itemStable(25, 20)).toBe(false);
    expect(itemStable(0, 0)).toBe(false);
  });

  it("单方向达到阈值即方向稳定", () => {
    expect(directionStable(21)).toBe(true);
    expect(directionStable(30)).toBe(true);
    expect(directionStable(20)).toBe(false);
  });
});

describe("deriveUnitUnlocked", () => {
  function unit(position: number, total: number, done: number): UnitProgressItem {
    return { position, requiredItemCount: total, initialCompletedItemCount: done };
  }

  it("第一个单元默认解锁（即使 0 词项也解锁）", () => {
    const units = deriveUnitUnlocked([unit(1, 0, 0)]);
    expect(units[0]!.unlocked).toBe(true);
  });

  it("单单元场景：首单元恒解锁", () => {
    const units = deriveUnitUnlocked([unit(1, 5, 2)]);
    expect(units).toHaveLength(1);
    expect(units[0]!.unlocked).toBe(true);
  });

  it("单元连续解锁：前一单元全部双向首测才解锁下一单元", () => {
    const units = deriveUnitUnlocked([
      unit(1, 3, 3), // 全部完成 → 解锁 2
      unit(2, 2, 1), // 未全部完成 → 3 不解锁
      unit(3, 2, 2),
    ]);
    const byPos = Object.fromEntries(units.map((u) => [u.position, u.unlocked]));
    expect(byPos["1"]).toBe(true);
    expect(byPos["2"]).toBe(true);
    expect(byPos["3"]).toBe(false);
  });

  it("前一单元未全部完成 → 本单元与其后都锁定", () => {
    const units = deriveUnitUnlocked([
      unit(1, 3, 2), // 未全部完成
      unit(2, 1, 1),
      unit(3, 1, 1),
    ]);
    const byPos = Object.fromEntries(units.map((u) => [u.position, u.unlocked]));
    expect(byPos["1"]).toBe(true);
    expect(byPos["2"]).toBe(false);
    expect(byPos["3"]).toBe(false);
  });

  it("requiredItemCount=0（空单元）不解锁后续单元：不变量要求上一单元有词项且全完成", () => {
    const units = deriveUnitUnlocked([unit(1, 0, 0), unit(2, 1, 0)]);
    expect(units[0]!.unlocked).toBe(true);
    expect(units[1]!.unlocked).toBe(false);
  });

  it("输入乱序时按 position 排序后派生，并保持原 key", () => {
    const units = deriveUnitUnlocked([unit(3, 1, 1), unit(1, 2, 2), unit(2, 1, 1)]);
    // 派生排序后：1→true, 2→true, 3 依赖 2（已完全）→true。
    const byPos = Object.fromEntries(units.map((u) => [u.position, u.unlocked]));
    expect(byPos["1"]).toBe(true);
    expect(byPos["2"]).toBe(true);
    expect(byPos["3"]).toBe(true);
  });
});

describe("deriveHighestUnlockedUnitPosition", () => {
  function unit(position: number, total: number, done: number): UnitProgressItem {
    return { position, requiredItemCount: total, initialCompletedItemCount: done };
  }

  it("空数组回退到 1", () => {
    expect(deriveHighestUnlockedUnitPosition([])).toBe(1);
  });

  it("只解锁到第 2 单元（第 3 锁定）→ 返回 2", () => {
    const units = [
      unit(1, 3, 3),
      unit(2, 2, 1), // 3 锁定
      unit(3, 1, 1),
    ];
    expect(deriveHighestUnlockedUnitPosition(units)).toBe(2);
  });

  it("全部解锁 → 返回最大 position", () => {
    const units = [unit(1, 1, 1), unit(2, 1, 1), unit(3, 1, 1)];
    expect(deriveHighestUnlockedUnitPosition(units)).toBe(3);
  });

  it("无词项单元（required=0）不推进解锁", () => {
    const units = [unit(1, 0, 0), unit(2, 1, 1)];
    expect(deriveHighestUnlockedUnitPosition(units)).toBe(1);
  });
});
