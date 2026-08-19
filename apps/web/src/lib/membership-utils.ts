// Ticket 20 UI: 纯衍生逻辑。与 React 无关，便于单测。
// 由服务端会员投影（AdminMembershipReadDto）派生管理端三元徽标态。
import type { AdminMembershipRead } from "@/lib/api";

export type { AdminMembershipRead };

export type MembershipBadge = "free" | "member" | "expired";

/** 为管理端 UI 的三元徽标态生成中文标签。 */
export const MEMBERSHIP_BADGE_LABEL: Record<MembershipBadge, string> = {
  free: "免费",
  member: "会员",
  expired: "已过期",
};

/**
 * 纯函数：从服务端会员投影派生显示态。
 * - 无行 / plan=free → 免费
 * - plan=member 且有效（status=member）→ 会员
 * - plan=member 但失效 → 已过期（fail-closed）
 */
export function deriveMembershipBadge(m: AdminMembershipRead | null | undefined): MembershipBadge {
  if (!m) return "free";
  if (m.plan !== "member") return "free";
  // member plan 且服务端判定生效 → 会员；否则（过期/失效）fail-closed → 已过期。
  return m.status === "member" ? "member" : "expired";
}

/** 为用户生成一个提示文本。 */
export function membershipTooltip(
  m: AdminMembershipRead | null | undefined,
  formatTime: (iso: string) => string,
): string {
  const badge = deriveMembershipBadge(m);
  const expires = m?.expiresAt ?? null;
  if (badge === "member") {
    return expires ? `会员，过期于 ${formatTime(expires)}` : "会员，永久有效";
  }
  if (badge === "expired") return "会员已过期，按免费限制处理";
  return "免费账号";
}
