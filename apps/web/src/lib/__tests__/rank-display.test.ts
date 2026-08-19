import { describe, expect, it } from "vitest";
import { formatRankLabel, projectRankDisplay } from "../rank-display.js";

describe("projectRankDisplay", () => {
  it("does not render undefined when an older API response lacks rank fields", () => {
    expect(projectRankDisplay({})).toEqual({
      level: 1,
      title: "初学黑铁",
      isFallback: true,
    });
  });

  it("keeps a complete server rank projection", () => {
    expect(projectRankDisplay({ level: 4, title: "进阶黄金" })).toEqual({
      level: 4,
      title: "进阶黄金",
      isFallback: false,
    });
  });

  it("formats a safe label when the API omits rank fields", () => {
    expect(formatRankLabel({})).toBe("Lv.1 初学黑铁");
    expect(formatRankLabel({ level: 4, title: "进阶黄金" })).toBe("Lv.4 进阶黄金");
  });
});
