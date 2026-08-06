// 发布版本号分配（纯规则）：每门课程从 1 单调递增。
import { describe, expect, it } from "vitest";
import { nextReleaseNumber } from "@motro/domain";

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
