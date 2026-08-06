// 学习者课程目录（只读）：把 current release 数据映射为目录/详情响应。
// 阶段 4 无学习记录：进度固定 not_started；内容来源固定 published_release。

export const PUBLISHED_RELEASE_SOURCE = "published_release";
export const PROGRESS_NOT_STARTED = "not_started";

export interface CatalogUnitSummary {
  unitId: string;
  position: number;
  title: string;
  description: string;
}

export interface CatalogCourseSummary {
  courseId: string;
  title: string;
  level: string;
  description: string;
  releaseId: string;
  releaseNumber: number;
  contentSource: typeof PUBLISHED_RELEASE_SOURCE;
  progressStatus: typeof PROGRESS_NOT_STARTED;
}

export interface CatalogCourseDetail extends CatalogCourseSummary {
  units: CatalogUnitSummary[];
}

export interface CatalogCourseInput {
  courseId: string;
  title: string;
  level: string;
  description: string;
  releaseId: string;
  releaseNumber: number;
}

/** 列表摘要（不含单元）。 */
export function buildCatalogSummary(input: CatalogCourseInput): CatalogCourseSummary {
  return {
    courseId: input.courseId,
    title: input.title,
    level: input.level,
    description: input.description,
    releaseId: input.releaseId,
    releaseNumber: input.releaseNumber,
    contentSource: PUBLISHED_RELEASE_SOURCE,
    progressStatus: PROGRESS_NOT_STARTED,
  };
}

/** 详情：带按 position 排序的单元概要。 */
export function buildCatalogDetail(
  input: CatalogCourseInput,
  units: CatalogUnitSummary[],
): CatalogCourseDetail {
  return {
    ...buildCatalogSummary(input),
    units: [...units].sort((a, b) => a.position - b.position),
  };
}
