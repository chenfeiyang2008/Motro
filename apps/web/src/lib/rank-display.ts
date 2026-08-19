export const DEFAULT_RANK_DISPLAY = {
  level: 1,
  title: "初学黑铁",
} as const;

export type RankDisplayInput = {
  level?: number | null;
  title?: string | null;
};

/** Runtime-safe projection for older /me/xp responses during API rollouts. */
export function projectRankDisplay(input: RankDisplayInput | null | undefined) {
  const level = input?.level;
  const title = input?.title?.trim();
  const hasValidLevel = typeof level === "number" && Number.isInteger(level) && level > 0;
  const hasValidTitle = typeof title === "string" && title !== "";
  return {
    level: hasValidLevel ? level : DEFAULT_RANK_DISPLAY.level,
    title: hasValidTitle ? title : DEFAULT_RANK_DISPLAY.title,
    isFallback: !(hasValidLevel && hasValidTitle),
  };
}

export function formatRankLabel(input: RankDisplayInput | null | undefined) {
  const display = projectRankDisplay(input);
  return `Lv.${display.level} ${display.title}`;
}
