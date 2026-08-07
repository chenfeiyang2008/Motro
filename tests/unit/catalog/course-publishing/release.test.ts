// 发布版本号分配（纯规则）：每门课程从 1 单调递增。
import { describe, expect, it } from "vitest";
import { nextReleaseNumber, resolveReleasedUnitId } from "@motro/domain";

describe("nextReleaseNumber", () => {
  it("无已发布版本时从 1 开始", () => {
    expect(nextReleaseNumber([])).toBe(1);
  });

  it("在已有版本基础上递增", () => {
    expect(nextReleaseNumber([1, 2])).toBe(3);
    expect(nextReleaseNumber([5])).toBe(6);
  });

  it("输入无序时仍取最大值 + 1", () => {
    expect(nextReleaseNumber([3, 1, 2])).toBe(4);
  });
});

describe("resolveReleasedUnitId", () => {
  it("首遇到某单元：从 INSERT 返回行取 released_unit id 并缓存", () => {
    const cache = new Map<string, string>();
    const id = resolveReleasedUnitId("unit-1", { rows: [{ id: "released-1" }] }, cache);
    expect(id).toBe("released-1");
    expect(cache.get("unit-1")).toBe("released-1");
  });

  it("单元已缓存：复用缓存的 id，忽略 INSERT 返回", () => {
    const cache = new Map<string, string>([["unit-1", "released-cached"]]);
    // INSERT 返回另一 id，但缓存命中 → 返回缓存的。
    const id = resolveReleasedUnitId("unit-1", { rows: [{ id: "released-2" }] }, cache);
    expect(id).toBe("released-cached");
  });

  it("INSERT 未返回 id（防御路径）→ 抛异常（让外层发布事务回滚，绝不提交不完整 release）", () => {
    const cache = new Map<string, string>();
    expect(() => resolveReleasedUnitId("unit-9", { rows: [] }, cache)).toThrow(
      /released_units 复制失败/,
    );
    // 失败后不写入缓存。
    expect(cache.has("unit-9")).toBe(false);
  });
});
