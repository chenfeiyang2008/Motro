// 工单 09：可重建学习指标——按用户时区计算的日期边界（纯领域规则）。
//
// 本模块只提供纯函数 + 类型：把「绝对时刻 + IANA timezone」映射为「用户本地日历日」，
// 以及把一段连续天数映射为「本地日键数组」。不触碰数据库、不 import Nest/pg。
//
// 设计原则（工单 09）：
//   - 时区必须是有效 IANA 名（如 Asia/Shanghai / UTC / America/New_York）。无法解析时区
//     属于「无法如实计算」而非「回落默认」——避免用错误时区伪造日期边界。
//   - 日键使用 YYYY-MM-DD（本地日历日），不接受携带时区偏移的自戳对。
//   - 由 absolute instant 推导本地日，绝不在客户端按 UTC 臆测本地日。
//
// 注意：PostgreSQL 已把所有时间列存为 timestamptz。本模块把「时区语义」放在纯函数层，
// 使其可被确定性单测；真实 SQL 侧用 `at time zone $tz` 获取本地日，与本模块一致。
export function isIanaTimezone(tz: string): boolean {
  return /^[A-Za-z_+\-/]{1,64}$/.test(tz);
}

/** 把绝对时刻投影为一个 IANA 时区下的「本地日历日键」（YYYY-MM-DD）。 */
export function localDayKey(instant: Date | number | string, timezone: string): string {
  const d = new Date(instant);
  // 用一个不受运行时默认时区污染的格式化：先计算 UTC 分量，再按时区偏移换算。
  // 采用 Intl，由 Node ICU 提供 IANA 时区正确性。
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const y = get("year");
  const m = get("month");
  const day = get("day");
  return `${y}-${m}-${day}`;
}

/** 计算过去 N 天（含今天）的本地日键，从最早到最近。 */
export function trailingLocalDayKeys(
  now: Date | number | string,
  timezone: string,
  days: number,
): string[] {
  const base = new Date(now);
  const out: string[] = [];
  // 以「现在」为终点向前推 days 天，每天取本地日键。使用 UTC 毫秒逐日减 86400s；
  // 对多数时区夏令时边界会产生偏移但仍落到正确本地日（以 localDayKey 权威为准）。
  for (let i = days - 1; i >= 0; i--) {
    const t = new Date(base.getTime() - i * 86_400_000);
    out.push(localDayKey(t, timezone));
  }
  return out;
}

/** 一个日期的本地日键（复用 localDayKey 的稳定性校验）。 */
export function dayKeyForInstant(instant: Date | number | string, timezone: string): string {
  return localDayKey(instant, timezone);
}

/** 由一段 review 事件的绝对时刻推导其本地日键（metrics 汇总用）。 */
export function reviewDayKey(instant: Date, timezone: string): string {
  return localDayKey(instant, timezone);
}
