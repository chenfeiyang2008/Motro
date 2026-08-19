// Ticket 20 UI: 会员徽标派生纯函数单测。
import { describe, expect, it } from "vitest";
import {
  deriveMembershipBadge,
  MEMBERSHIP_BADGE_LABEL,
  membershipTooltip,
  type AdminMembershipRead,
} from "../membership-utils.js";

function m(
  plan: "member" | "free",
  status: "member" | "free",
  expiresAt: string | null = null,
): AdminMembershipRead {
  return { plan, status, expiresAt, dailyLimitMinutes: 15 };
}

describe("deriveMembershipBadge", () => {
  it("null/undefined → 免费", () => {
    expect(deriveMembershipBadge(null)).toBe("free");
    expect(deriveMembershipBadge(undefined)).toBe("free");
  });

  it("plan=free → 免费", () => {
    expect(deriveMembershipBadge(m("free", "free", null))).toBe("free");
    expect(deriveMembershipBadge(m("free", "free", "2099-01-01T00:00:00Z"))).toBe("free");
  });

  it("plan=member 且生效 → 会员", () => {
    expect(deriveMembershipBadge(m("member", "member", null))).toBe("member");
    expect(deriveMembershipBadge(m("member", "member", "2099-01-01T00:00:00Z"))).toBe("member");
  });

  it("plan=member 但失效（过期）→ 已过期", () => {
    // 服务端 fail-closed：过期会员报告 plan=member, status=free
    expect(deriveMembershipBadge(m("member", "free", "2020-01-01T00:00:00Z"))).toBe("expired");
    expect(deriveMembershipBadge(m("member", "free", null))).toBe("expired");
  });
});

describe("MEMBERSHIP_BADGE_LABEL", () => {
  it("覆盖全部三态", () => {
    expect(MEMBERSHIP_BADGE_LABEL.free).toBe("免费");
    expect(MEMBERSHIP_BADGE_LABEL.member).toBe("会员");
    expect(MEMBERSHIP_BADGE_LABEL.expired).toBe("已过期");
  });
});

describe("membershipTooltip", () => {
  const fmt = (iso: string) => new Date(iso).toISOString();
  it("会员且有过期时间 → 显示过期", () => {
    expect(membershipTooltip(m("member", "member", "2099-01-01T00:00:00Z"), fmt)).toBe(
      "会员，过期于 2099-01-01T00:00:00.000Z",
    );
  });
  it("会员且永久 → 永久有效", () => {
    expect(membershipTooltip(m("member", "member", null), fmt)).toBe("会员，永久有效");
  });
  it("已过期 → 按免费限制", () => {
    expect(membershipTooltip(m("member", "free", "2020-01-01T00:00:00Z"), fmt)).toBe(
      "会员已过期，按免费限制处理",
    );
  });
  it("免费 → 免费账号", () => {
    expect(membershipTooltip(m("free", "free", null), fmt)).toBe("免费账号");
    expect(membershipTooltip(null, fmt)).toBe("免费账号");
  });
});
