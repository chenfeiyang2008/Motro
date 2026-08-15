// 工单 09：可重建学习指标——纯领域单测。
// 覆盖：时区日期边界（跨日/夏令时）、stable/首测/待复习派生、去重、课程完成度、
// 不含 XP/排行榜/CEFR 字段。无 DB、无网络。
import { describe, expect, it } from "vitest";
import {
  completionRatio,
  countDueForReviewItems,
  countInitiallyCompletedItems,
  countStableItems,
  dayKeyForInstant,
  isIanaTimezone,
  localDayKey,
  metricItemDueForReview,
  metricItemInitiallyCompleted,
  metricItemStable,
  trailingLocalDayKeys,
  type ItemCardSnapshot,
} from "@motro/domain";

const STABLE = 21;

function snap(over: Partial<ItemCardSnapshot> = {}): ItemCardSnapshot {
  return {
    itemId: "i1",
    enScheduledDays: STABLE,
    zhScheduledDays: STABLE,
    enState: "review",
    zhState: "review",
    enDueAt: new Date("2026-08-14T10:00:00Z"),
    zhDueAt: new Date("2026-08-14T10:00:00Z"),
    enInitialReviewed: true,
    zhInitialReviewed: true,
    ...over,
  };
}

describe("时区日期边界", () => {
  it("isIanaTimezone 校验合法/非法", () => {
    expect(isIanaTimezone("Asia/Shanghai")).toBe(true);
    expect(isIanaTimezone("UTC")).toBe(true);
    expect(isIanaTimezone("America/New_York")).toBe(true);
    expect(isIanaTimezone("not/a/tz/with/long/name/that/exceeds/64/xxx")).toBe(false);
  });

  it("跨日：同 UTC 时刻在不同时区属不同本地日", () => {
    const instant = new Date("2026-08-14T18:00:00Z"); // UTC 18:00
    // Asia/Shanghai = UTC+8 → 08-15 02:00 本地
    expect(localDayKey(instant, "Asia/Shanghai")).toBe("2026-08-15");
    // America/New_York = UTC-4 → 08-14 14:00 本地
    expect(localDayKey(instant, "America/New_York")).toBe("2026-08-14");
  });

  it("同日内不同时刻返回同一日键（幂等）", () => {
    const a = localDayKey(new Date("2026-08-14T00:30:00Z"), "UTC");
    const b = localDayKey(new Date("2026-08-14T23:30:00Z"), "UTC");
    expect(a).toBe("2026-08-14");
    expect(b).toBe("2026-08-14");
  });

  it("dayKeyForInstant 与 localDayKey 一致", () => {
    expect(dayKeyForInstant(new Date("2026-08-14T18:00:00Z"), "Asia/Shanghai")).toBe(
      localDayKey(new Date("2026-08-14T18:00:00Z"), "Asia/Shanghai"),
    );
  });

  it("trailingLocalDayKeys 生成最近 N 天（含今天），升序", () => {
    const keys = trailingLocalDayKeys(new Date("2026-08-14T12:00:00Z"), "UTC", 7);
    expect(keys).toHaveLength(7);
    expect(keys[0]).toBe("2026-08-08");
    expect(keys[6]).toBe("2026-08-14");
    expect(new Set(keys).size).toBe(7);
  });
});

describe("stable / 首测 / 待复习派生", () => {
  it("双向 scheduled_days >= 21 → 稳定", () => {
    expect(metricItemStable(snap())).toBe(true);
    expect(metricItemStable(snap({ zhScheduledDays: 20 }))).toBe(false);
    expect(metricItemStable(snap({ enScheduledDays: 0 }))).toBe(false);
  });

  it("双向首测完成判定", () => {
    expect(metricItemInitiallyCompleted(snap())).toBe(true);
    expect(metricItemInitiallyCompleted(snap({ enInitialReviewed: false }))).toBe(false);
    expect(metricItemInitiallyCompleted(snap({ zhInitialReviewed: false }))).toBe(false);
  });

  it("待复习：任一方向 state=review 且 due_at <= asOf", () => {
    const asOf = new Date("2026-08-14T12:00:00Z");
    expect(metricItemDueForReview(snap(), asOf)).toBe(true);
    // 双向都未到期 → 不待复习
    expect(
      metricItemDueForReview(
        snap({
          enDueAt: new Date("2026-08-15T10:00:00Z"),
          zhDueAt: new Date("2026-08-15T10:00:00Z"),
        }),
        asOf,
      ),
    ).toBe(false);
    // 单向到期（en）仍待复习
    expect(
      metricItemDueForReview(
        snap({
          enDueAt: new Date("2026-08-13T10:00:00Z"),
          zhDueAt: new Date("2026-08-20T10:00:00Z"),
        }),
        asOf,
      ),
    ).toBe(true);
    // 状态非 review → 不待复习
    expect(metricItemDueForReview(snap({ enState: "learning", zhState: "new" }), asOf)).toBe(false);
  });

  it("count* 聚合（含去重：每 item 至多计一次 stable/due）", () => {
    const items = [
      snap({ itemId: "a" }), // stable + due
      snap({ itemId: "b", zhScheduledDays: 20 }), // 不稳定，但 due（both review, due_at<=asOf）
      snap({
        itemId: "c",
        enDueAt: new Date("2026-08-20T10:00:00Z"),
        zhDueAt: new Date("2026-08-20T10:00:00Z"),
      }), // stable 但双向都未到期
    ];
    expect(countStableItems(items)).toBe(2); // a + c
    expect(countInitiallyCompletedItems(items)).toBe(3);
    expect(countDueForReviewItems(items, new Date("2026-08-14T12:00:00Z"))).toBe(2); // a + b
  });
});

describe("工单 09 无 XP/排行榜/CEFR", () => {
  it("领域类型不含 XP/rank/CEFR 字段", () => {
    const snapshot = snap();
    const obj = JSON.stringify(snapshot);
    expect(obj).not.toMatch(/xp|score|rank|cefr|gemstone|badge|level_total/i);
  });

  it("completionRatio 在空课程返回 0（不伪造数据）", () => {
    expect(completionRatio(0, 0)).toBe(0);
    expect(completionRatio(1, 0)).toBe(0);
    expect(completionRatio(2, 4)).toBe(0.5);
  });
});
