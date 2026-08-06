// 学习者报名/主课程状态映射纯函数单测：buildEnrollmentState 的 null/active/inactive 边界，
// 以及目录摘要/详情把报名状态透传为 isEnrolled / isPrimary。
import { describe, expect, it } from "vitest";
import {
  PROGRESS_NOT_STARTED,
  PUBLISHED_RELEASE_SOURCE,
  buildCatalogDetail,
  buildCatalogSummary,
  buildEnrollmentState,
} from "@motro/domain";

const INPUT = {
  courseId: "course-1",
  title: "高中英语核心词汇",
  level: "b1",
  description: "课程描述",
  releaseId: "release-2",
  releaseNumber: 2,
};

describe("buildEnrollmentState", () => {
  it("无报名行 → 未报名、非主课程", () => {
    expect(buildEnrollmentState(null)).toEqual({ isEnrolled: false, isPrimary: false });
  });

  it("active 报名且非主课程 → 已报名、非主课程", () => {
    expect(buildEnrollmentState({ active: true, is_primary: false })).toEqual({
      isEnrolled: true,
      isPrimary: false,
    });
  });

  it("active 报名且主课程 → 已报名、主课程", () => {
    expect(buildEnrollmentState({ active: true, is_primary: true })).toEqual({
      isEnrolled: true,
      isPrimary: true,
    });
  });

  it("软停用（active=false）报名视为未报名，即使历史上是主课程", () => {
    expect(buildEnrollmentState({ active: false, is_primary: true })).toEqual({
      isEnrolled: false,
      isPrimary: false,
    });
  });
});

describe("buildCatalogSummary 的报名状态", () => {
  it("无报名信息时默认未报名、非主课程", () => {
    const summary = buildCatalogSummary({ ...INPUT, enrollment: undefined });
    expect(summary.isEnrolled).toBe(false);
    expect(summary.isPrimary).toBe(false);
  });

  it("透传已报名但非主课程", () => {
    const summary = buildCatalogSummary({
      ...INPUT,
      enrollment: { isEnrolled: true, isPrimary: false },
    });
    expect(summary.isEnrolled).toBe(true);
    expect(summary.isPrimary).toBe(false);
    expect(summary.contentSource).toBe(PUBLISHED_RELEASE_SOURCE);
    expect(summary.progressStatus).toBe(PROGRESS_NOT_STARTED);
  });

  it("透传已报名且为主课程", () => {
    const summary = buildCatalogSummary({
      ...INPUT,
      enrollment: { isEnrolled: true, isPrimary: true },
    });
    expect(summary.isEnrolled).toBe(true);
    expect(summary.isPrimary).toBe(true);
  });
});

describe("buildCatalogDetail 的报名状态", () => {
  it("详情透传报名状态并保持单元有序", () => {
    const detail = buildCatalogDetail(
      { ...INPUT, enrollment: { isEnrolled: true, isPrimary: true } },
      [
        { unitId: "u2", position: 2, title: "第二单元", description: "d2" },
        { unitId: "u1", position: 1, title: "第一单元", description: "d1" },
      ],
    );
    expect(detail.isEnrolled).toBe(true);
    expect(detail.isPrimary).toBe(true);
    expect(detail.units.map((u) => u.position)).toEqual([1, 2]);
  });
});
