/**
 * Motro learning ranks. Rank progression is based on personal XP only;
 * Challenge Points remain a separate leaderboard fact.
 */
export const MOTIVATION_RULE_VERSION = 2;

export const RANK_DEFINITIONS = [
  { level: 1, threshold: 0, titleKey: "初学黑铁", title: "初学黑铁" },
  { level: 2, threshold: 50, titleKey: "开口青铜", title: "开口青铜" },
  { level: 3, threshold: 150, titleKey: "熟手白银", title: "熟手白银" },
  { level: 4, threshold: 350, titleKey: "进阶黄金", title: "进阶黄金" },
  { level: 5, threshold: 700, titleKey: "资深铂金", title: "资深铂金" },
  { level: 6, threshold: 1200, titleKey: "英语钻石", title: "英语钻石" },
  { level: 7, threshold: 2000, titleKey: "跨洋王者", title: "跨洋王者" },
  { level: 8, threshold: 3000, titleKey: "至尊词王", title: "至尊词王" },
] as const;

export type RankDefinition = (typeof RANK_DEFINITIONS)[number];

export interface RankProgress {
  level: number;
  titleKey: string;
  title: string;
  threshold: number;
  nextLevel: number | null;
  nextThreshold: number | null;
  progressXp: number;
  progressPercent: number;
}

/** Highest rank currently reachable from net personal XP. */
export function rankForXp(totalXp: number): RankDefinition {
  const xp = Math.max(0, Math.floor(Number.isFinite(totalXp) ? totalXp : 0));
  return (
    [...RANK_DEFINITIONS].reverse().find((rank) => xp >= rank.threshold) ?? RANK_DEFINITIONS[0]
  );
}

/** Return display-ready progress without allowing correction/void to downgrade. */
export function rankProgressForXp(totalXp: number, permanentLevel?: number): RankProgress {
  const current = rankForXp(totalXp);
  const level = Math.max(current.level, permanentLevel ?? 1);
  const definition = RANK_DEFINITIONS.find((rank) => rank.level === level) ?? current;
  const next = RANK_DEFINITIONS.find((rank) => rank.level === definition.level + 1) ?? null;
  const span = next ? next.threshold - definition.threshold : 1;
  const progressXp = Math.max(
    0,
    Math.floor(Number.isFinite(totalXp) ? totalXp : 0) - definition.threshold,
  );
  const progressPercent = next
    ? Math.min(100, Math.max(0, Math.round((progressXp / span) * 100)))
    : 100;
  return {
    level: definition.level,
    titleKey: definition.titleKey,
    title: definition.title,
    threshold: definition.threshold,
    nextLevel: next?.level ?? null,
    nextThreshold: next?.threshold ?? null,
    progressXp,
    progressPercent,
  };
}

/** Every rank that must be permanently recorded for the supplied XP total. */
export function reachedRanksForXp(totalXp: number): RankDefinition[] {
  const level = rankForXp(totalXp).level;
  return RANK_DEFINITIONS.filter((rank) => rank.level <= level);
}
