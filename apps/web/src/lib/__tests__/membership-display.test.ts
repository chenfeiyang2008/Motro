// 会员显示纯函数单测（membership-display）。
import { describe, expect, it } from "vitest";
import {
  compactUuid,
  dailyUsageText,
  isEffectiveMember,
  membershipStatusLabel,
  resetDayLabel,
} from "../membership-display.js";

describe("isEffectiveMember", () => {
  it("member → true", () => {
    expect(isEffectiveMember("member")).toBe(true);
  });

  it("free / expired / undefined / unknown → false", () => {
    expect(isEffectiveMember("free")).toBe(false);
    expect(isEffectiveMember("expired")).toBe(false);
    expect(isEffectiveMember(undefined)).toBe(false);
    expect(isEffectiveMember("")).toBe(false);
  });
});

describe("membershipStatusLabel", () => {
  it("member → 会员", () => {
    expect(membershipStatusLabel("member")).toBe("会员");
  });

  it("其他 → 免费方案", () => {
    expect(membershipStatusLabel("free")).toBe("免费方案");
    expect(membershipStatusLabel(undefined)).toBe("免费方案");
  });
});

describe("dailyUsageText", () => {
  it("member → 不限时", () => {
    expect(dailyUsageText({ membershipStatus: "member", remainingMinutes: 30 })).toBe(
      "今日学习不限时",
    );
  });

  it("免费 → 剩余 X 分钟 · 明日重置", () => {
    expect(dailyUsageText({ membershipStatus: "free", remainingMinutes: 12 })).toBe(
      "今日剩余 12 分钟 · 明日重置",
    );
    expect(dailyUsageText({ membershipStatus: "free", remainingMinutes: null })).toBe(
      "今日剩余 0 分钟 · 明日重置",
    );
  });

  it("null → 空串", () => {
    expect(dailyUsageText(null)).toBe("");
  });
});

describe("resetDayLabel", () => {
  it("标准日 → M月d日重置", () => {
    expect(resetDayLabel("2026-08-20")).toBe("8月20日重置");
    expect(resetDayLabel("2026-11-05")).toBe("11月5日重置");
  });

  it("空/非法 → 原样或降级", () => {
    expect(resetDayLabel(null)).toBe("");
    expect(resetDayLabel("")).toBe("");
  });
});

describe("compactUuid", () => {
  it("短 ID 原样", () => {
    expect(compactUuid("abc")).toBe("abc");
  });

  it("长 UUID → 前8+…+后5", () => {
    const id = "c4e3e2d4-1111-2222-3333-444444449c85";
    expect(compactUuid(id)).toBe("c4e3e2d4…49c85");
  });
});
