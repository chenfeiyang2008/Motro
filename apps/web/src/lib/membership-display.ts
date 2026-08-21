// 纯函数：会员状态判断与显示文案。
// 所有逻辑集中在此，不在首页/资料/排行榜各自复制 status === "member"。

/** 是否为有效会员（服务端计算，不可伪造） */
export function isEffectiveMember(status: string | undefined): boolean {
  return status === "member";
}

/** 会员状态标签文案 */
export function membershipStatusLabel(status: string | undefined): string {
  if (status === "member") return "会员";
  return "免费方案";
}

/**
 * 今日学习时长文案。
 * 会员 → "今日学习不限时"
 * 免费 → "今日剩余 {n} 分钟 · 明日重置"
 */
export function dailyUsageText(
  usage: { membershipStatus: string; remainingMinutes: number | null } | null,
): string {
  if (!usage) return "";
  if (usage.membershipStatus === "member") return "今日学习不限时";
  return `今日剩余 ${usage.remainingMinutes ?? 0} 分钟 · 明日重置`;
}

/** 重置日期短格式："8月20日重置" */
export function resetDayLabel(resetDay: string | null): string {
  if (!resetDay) return "";
  try {
    // resetDay 形如 "2026-08-20"（Asia/Shanghai 本地日），避免时区偏移。
    const [y, m, d] = resetDay.split("-").map((n) => Number(n));
    if (!y || !m || !d) return `${resetDay} 重置`;
    return `${m}月${d}日重置`;
  } catch {
    return `${resetDay} 重置`;
  }
}

/** UUID 紧凑格式："c4e3e2d4…49c85" */
export function compactUuid(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-5)}`;
}
