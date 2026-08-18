import { describe, expect, it } from "vitest";
import { RANK_DEFINITIONS, rankForXp, rankProgressForXp, reachedRanksForXp } from "./ranks.js";

describe("motivation ranks", () => {
  it.each([
    [0, 1, "初学黑铁"],
    [49, 1, "初学黑铁"],
    [50, 2, "开口青铜"],
    [150, 3, "熟手白银"],
    [350, 4, "进阶黄金"],
    [700, 5, "资深铂金"],
    [1200, 6, "英语钻石"],
    [2000, 7, "跨洋王者"],
    [3000, 8, "至尊词王"],
  ])("maps %s XP to level %s (%s)", (xp, level, title) => {
    expect(rankForXp(xp).level).toBe(level);
    expect(rankForXp(xp).title).toBe(title);
  });

  it("returns a bounded next-level progress projection", () => {
    expect(rankProgressForXp(75)).toMatchObject({
      level: 2,
      threshold: 50,
      nextLevel: 3,
      nextThreshold: 150,
      progressXp: 25,
      progressPercent: 25,
    });
    expect(rankProgressForXp(99999)).toMatchObject({
      level: 8,
      nextLevel: null,
      nextThreshold: null,
      progressPercent: 100,
    });
  });

  it("keeps a permanently achieved level after XP is corrected or voided", () => {
    expect(rankProgressForXp(10, 4)).toMatchObject({
      level: 4,
      title: "进阶黄金",
      nextLevel: 5,
      progressXp: 0,
    });
  });

  it("backfills every rank through the highest reached rank exactly once", () => {
    expect(reachedRanksForXp(350).map((rank) => rank.level)).toEqual([1, 2, 3, 4]);
    expect(reachedRanksForXp(350).length).toBe(
      RANK_DEFINITIONS.filter((rank) => rank.threshold <= 350).length,
    );
  });
});
