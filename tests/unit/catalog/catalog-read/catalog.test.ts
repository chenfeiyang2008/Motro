// 学习者目录映射纯函数单测：current release 摘要/详情、单元顺序、未开始状态与内容来源。
import { describe, expect, it } from "vitest";
import {
  PROGRESS_NOT_STARTED,
  PUBLISHED_RELEASE_SOURCE,
  buildCatalogDetail,
  buildCatalogSummary,
} from "@motro/domain";

const INPUT = {
  courseId: "course-1",
  title: "高中英语核心词汇",
  level: "b1",
  description: "课程描述",
  releaseId: "release-2",
  releaseNumber: 2,
};

describe("buildCatalogSummary", () => {
  it("返回 current release 摘要，内容来源为 published_release，进度为 not_started", () => {
    const summary = buildCatalogSummary(INPUT);
    expect(summary.courseId).toBe("course-1");
    expect(summary.releaseId).toBe("release-2");
    expect(summary.releaseNumber).toBe(2);
    expect(summary.contentSource).toBe(PUBLISHED_RELEASE_SOURCE);
    expect(summary.progressStatus).toBe(PROGRESS_NOT_STARTED);
  });
});

describe("buildCatalogDetail", () => {
  it("单元按 position 升序返回，保持未开始状态", () => {
    const detail = buildCatalogDetail(INPUT, [
      { unitId: "u3", position: 3, title: "第三单元", description: "d3" },
      { unitId: "u1", position: 1, title: "第一单元", description: "d1" },
      { unitId: "u2", position: 2, title: "第二单元", description: "d2" },
    ]);
    expect(detail.units.map((u) => u.position)).toEqual([1, 2, 3]);
    expect(detail.units.map((u) => u.title)).toEqual(["第一单元", "第二单元", "第三单元"]);
    expect(detail.contentSource).toBe(PUBLISHED_RELEASE_SOURCE);
    expect(detail.progressStatus).toBe(PROGRESS_NOT_STARTED);
  });

  it("空单元列表返回空数组", () => {
    const detail = buildCatalogDetail(INPUT, []);
    expect(detail.units).toEqual([]);
  });
});
