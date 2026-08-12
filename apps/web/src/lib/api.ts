// 版本化 API 客户端边界：只允许通过 /api/v1 访问服务，类型来自 @motro/api-client。
// 服务端健康检查走 API_INTERNAL_URL；客户端词条/课程操作走同源 /api/v1（Next 代理到 API）。
import type { components, paths } from "@motro/api-client";

const API_BASE = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3000";
const HEALTH_PATH: keyof paths = "/api/v1/health/live";

export interface HealthResult {
  ok: boolean;
  body?: { status?: string; service?: string };
  error?: string;
}

export async function fetchHealth(): Promise<HealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${API_BASE}${HEALTH_PATH}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { status?: string; service?: string };
    return { ok: true, body };
  } catch {
    return { ok: false, error: "API 不可用" };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 管理员：词条 / 课程（客户端调用，同源 /api/v1）----

export type LexicalEntrySummary = components["schemas"]["LexicalEntrySummaryDto"];
export type LexicalEntryDetail = components["schemas"]["LexicalEntryDetailDto"];
export type LexicalEntryListResponse = components["schemas"]["LexicalEntryListResponseDto"];
export type CreateLexicalEntryPayload = components["schemas"]["CreateLexicalEntryDto"];
export type DuplicateCandidate = components["schemas"]["DuplicateCandidateDto"];
export type FieldError = { path: string; code: string; message?: string };

export type CourseListItem = components["schemas"]["CourseListItemDto"];
export type CourseDraftDetail = components["schemas"]["CourseDraftDetailDto"];
export type CreateCoursePayload = components["schemas"]["CreateCourseDto"];
export type CreateCourseResult = components["schemas"]["CreateCourseResultDto"];
export type UpdateCourseDraftPayload = components["schemas"]["UpdateCourseDraftDto"];
export type CreateUnitPayload = components["schemas"]["CreateUnitDto"];
export type UpdateUnitPayload = components["schemas"]["UpdateUnitDto"];
export type ReorderUnitsPayload = components["schemas"]["ReorderUnitsDto"];
export type UnitDto = components["schemas"]["UnitDto"];
export type ItemDto = components["schemas"]["ItemDto"];
export type CreateItemPayload = components["schemas"]["CreateItemDto"];
export type UpdateItemPayload = components["schemas"]["UpdateItemDto"];
export type ReorderItemsPayload = components["schemas"]["ReorderItemsDto"];

// ---- 学习者：学习端 /study（只读 + 学习会话） ----

export type StudyToday = components["schemas"]["TodayDto"];
export type StudySession = components["schemas"]["StudySessionDto"];
export type StudySessionDetail = components["schemas"]["StudySessionDetailDto"];
export type StudySessionItem = components["schemas"]["StudySessionItemDto"];
export type RevealResult = components["schemas"]["RevealResultDto"];
export type SubmitReviewResult = components["schemas"]["SubmitReviewResultDto"];
export type StudyProgress = components["schemas"]["ProgressDto"];
export type SubmitReviewPayload = components["schemas"]["SubmitReviewDto"];

export interface ApiError {
  code?: string;
  message?: string;
  requestId?: string;
  duplicateCandidates?: DuplicateCandidate[];
  fieldErrors?: FieldError[];
  currentDraftVersion?: number;
  retryable?: boolean;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: ApiError;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  // P2-3：FormData 时不要手工设置 Content-Type——由浏览器生成 multipart boundary。
  if (init?.body !== undefined && !(init.body instanceof FormData)) {
    headers["content-type"] = "application/json";
  }
  if (init?.method && init.method !== "GET") {
    const csrf = readCsrfCookie();
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  // 网络异常（断网/代理断开/连接拒绝）统一归一为可重试的 NETWORK_ERROR，
  // 不向上抛 fetch rejection，避免调用方崩溃或 submitting 永久为 true。
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: "NETWORK_ERROR", message: "网络连接失败，请重试", retryable: true },
    };
  }
  let data: T | { error?: ApiError } | undefined;
  try {
    data = (await res.json()) as T | { error?: ApiError };
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    // 服务端错误信封：{ error: { code, message, ... } } → 解包成 ApiError。
    const err = (data as { error?: ApiError } | undefined)?.error;
    return err ? { ok: false, status: res.status, error: err } : { ok: false, status: res.status };
  }
  return { ok: true, status: res.status, data: data as T };
}

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)motro_csrf=([^;]+)/);
  return match?.[1] ?? null;
}

/** 搜索/分页词条；q 为空返回全部。 */
export function listLexicalEntries(opts: {
  q: string;
  cursor: string | null;
}): Promise<ApiResult<LexicalEntryListResponse>> {
  const search = new URLSearchParams();
  const trimmed = opts.q.trim();
  if (trimmed.length > 0) search.set("q", trimmed);
  if (opts.cursor) search.set("cursor", opts.cursor);
  const qs = search.toString();
  return apiFetch<LexicalEntryListResponse>(
    `/api/v1/admin/lexical-entries${qs.length > 0 ? `?${qs}` : ""}`,
    { method: "GET" },
  );
}

/** 创建手工词条；重复候选时返回 409 DUPLICATE_WARNING（不静默落库）。 */
export function createLexicalEntry(
  payload: CreateLexicalEntryPayload,
): Promise<ApiResult<LexicalEntryDetail>> {
  return apiFetch<LexicalEntryDetail>("/api/v1/admin/lexical-entries", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getLexicalEntry(id: string): Promise<ApiResult<LexicalEntryDetail>> {
  return apiFetch<LexicalEntryDetail>(`/api/v1/admin/lexical-entries/${encodeURIComponent(id)}`, {
    method: "GET",
  });
}

// ---- 管理员：课程草稿与单元 ----

export function listCourses(): Promise<ApiResult<{ items: CourseListItem[] }>> {
  return apiFetch<{ items: CourseListItem[] }>("/api/v1/admin/courses", { method: "GET" });
}

export function createCourse(payload: CreateCoursePayload): Promise<ApiResult<CreateCourseResult>> {
  return apiFetch<CreateCourseResult>("/api/v1/admin/courses", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getCourseDraft(courseId: string): Promise<ApiResult<CourseDraftDetail>> {
  return apiFetch<CourseDraftDetail>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/draft`,
    { method: "GET" },
  );
}

export function updateCourseDraft(
  courseId: string,
  payload: UpdateCourseDraftPayload,
): Promise<ApiResult<CourseDraftDetail>> {
  return apiFetch<CourseDraftDetail>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/draft`,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
}

export function createCourseUnit(
  courseId: string,
  unitId: string,
  payload: CreateUnitPayload,
): Promise<ApiResult<CourseDraftDetail>> {
  return apiFetch<CourseDraftDetail>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/draft/units/${encodeURIComponent(unitId)}`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export function updateCourseUnit(
  courseId: string,
  unitId: string,
  payload: UpdateUnitPayload,
): Promise<ApiResult<CourseDraftDetail>> {
  return apiFetch<CourseDraftDetail>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/draft/units/${encodeURIComponent(unitId)}`,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
}

export function deleteCourseUnit(
  courseId: string,
  unitId: string,
  payload: { draftVersion: number },
): Promise<ApiResult<CourseDraftDetail>> {
  return apiFetch<CourseDraftDetail>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/draft/units/${encodeURIComponent(unitId)}`,
    { method: "DELETE", body: JSON.stringify(payload) },
  );
}

export function reorderCourseUnits(
  courseId: string,
  payload: ReorderUnitsPayload,
): Promise<ApiResult<CourseDraftDetail>> {
  return apiFetch<CourseDraftDetail>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/draft/reorder`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}

// ---- 管理员：课程词项 ----

export function createCourseItem(
  courseId: string,
  itemId: string,
  payload: CreateItemPayload,
): Promise<ApiResult<CourseDraftDetail>> {
  return apiFetch<CourseDraftDetail>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/draft/items/${encodeURIComponent(itemId)}`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export function updateCourseItem(
  courseId: string,
  itemId: string,
  payload: UpdateItemPayload,
): Promise<ApiResult<CourseDraftDetail>> {
  return apiFetch<CourseDraftDetail>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/draft/items/${encodeURIComponent(itemId)}`,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
}

export function deleteCourseItem(
  courseId: string,
  itemId: string,
  payload: { draftVersion: number },
): Promise<ApiResult<CourseDraftDetail>> {
  return apiFetch<CourseDraftDetail>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/draft/items/${encodeURIComponent(itemId)}`,
    { method: "DELETE", body: JSON.stringify(payload) },
  );
}

export function reorderCourseItems(
  courseId: string,
  payload: ReorderItemsPayload,
): Promise<ApiResult<CourseDraftDetail>> {
  return apiFetch<CourseDraftDetail>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/draft/items/reorder`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}

// ---- 管理员：草稿校验（发布准备） ----

export type CourseValidationResult = components["schemas"]["CourseValidationResultDto"];

export function validateCourseDraft(courseId: string): Promise<ApiResult<CourseValidationResult>> {
  return apiFetch<CourseValidationResult>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/validate`,
    { method: "POST" },
  );
}

// ---- 管理员：发布版本与当前指针 ----

export type PublishReleasePayload = components["schemas"]["PublishReleaseDto"];
export type PublishReleaseResult = components["schemas"]["PublishReleaseResultDto"];
export type ReleaseListItem = components["schemas"]["ReleaseListItemDto"];
export function publishCourseRelease(
  courseId: string,
  payload: PublishReleasePayload,
  idempotencyKey: string,
): Promise<ApiResult<PublishReleaseResult>> {
  return apiFetch<PublishReleaseResult>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/releases`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "idempotency-key": idempotencyKey },
    },
  );
}

export function listCourseReleases(
  courseId: string,
): Promise<ApiResult<{ items: ReleaseListItem[] }>> {
  return apiFetch<{ items: ReleaseListItem[] }>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/releases`,
    { method: "GET" },
  );
}

export function setCourseCurrentRelease(
  courseId: string,
  releaseId: string,
): Promise<ApiResult<{ currentReleaseId: string }>> {
  return apiFetch<{ currentReleaseId: string }>(
    `/api/v1/admin/courses/${encodeURIComponent(courseId)}/current-release`,
    { method: "PUT", body: JSON.stringify({ releaseId }) },
  );
}

// ---- 管理员：导入（原始文件上传 + 批次） ----

export type ImportBatch = components["schemas"]["ImportBatchDetailDto"];
export type ImportBatchList = components["schemas"]["ImportBatchListDto"];
export type ImportRow = components["schemas"]["ImportRowDto"];
export type ImportRowList = components["schemas"]["ImportRowListDto"];
export type ImportDiscoveredOption = components["schemas"]["ImportDiscoveredOptionDto"];
export type ImportSheetFieldSet = {
  fieldIds: string[];
  labels: string[];
};
export type ImportValidationSummary = components["schemas"]["ImportValidationSummaryDto"];
export type ImportMapping = { spellingField?: string; sheet?: string };

/** 当前管理员的导入批次列表（元数据，不含磁盘路径/存储键）。 */
export function listImportBatches(): Promise<ApiResult<ImportBatchList>> {
  return apiFetch<ImportBatchList>("/api/v1/admin/imports", { method: "GET" });
}

/** 单个导入批次详情。 */
export function getImportBatch(id: string): Promise<ApiResult<ImportBatch>> {
  return apiFetch<ImportBatch>(`/api/v1/admin/imports/${encodeURIComponent(id)}`, {
    method: "GET",
  });
}

/** 上传原始文件并创建导入批次（multipart FormData；Idempotency-Key 由调用方提供并复用）。 */
export function uploadImportBatch(payload: {
  file: File;
  sourceDeclaration: string;
  idempotencyKey: string;
}): Promise<ApiResult<ImportBatch>> {
  const form = new FormData();
  form.append("file", payload.file);
  form.append("sourceDeclaration", payload.sourceDeclaration);
  return apiFetch<ImportBatch>("/api/v1/admin/imports", {
    method: "POST",
    body: form,
    headers: { "idempotency-key": payload.idempotencyKey },
  });
}

/** 更新批次映射/来源声明（乐观并发：version）。 */
export function updateImportMapping(
  id: string,
  mapping: ImportMapping,
  version: number,
  sourceDeclaration?: string,
): Promise<ApiResult<ImportBatch>> {
  const payload: Record<string, unknown> = { mapping, version };
  if (sourceDeclaration !== undefined) payload.sourceDeclaration = sourceDeclaration;
  return apiFetch<ImportBatch>(`/api/v1/admin/imports/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

/** 校验批次（Idempotency-Key 由调用方提供并复用）。 */
export function validateImportBatch(
  id: string,
  idempotencyKey: string,
): Promise<ApiResult<ImportBatch>> {
  return apiFetch<ImportBatch>(`/api/v1/admin/imports/${encodeURIComponent(id)}/validate`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  });
}

/** 分页读取批次行结果。 */
export function listImportRows(
  id: string,
  cursor: string | null,
  limit?: number,
  mappingVersion?: number,
): Promise<ApiResult<ImportRowList>> {
  const search = new URLSearchParams();
  if (cursor) search.set("cursor", cursor);
  if (limit !== undefined) search.set("limit", String(limit));
  if (mappingVersion !== undefined) search.set("mappingVersion", String(mappingVersion));
  const qs = search.toString();
  return apiFetch<ImportRowList>(
    `/api/v1/admin/imports/${encodeURIComponent(id)}/rows${qs.length > 0 ? `?${qs}` : ""}`,
    { method: "GET" },
  );
}

// ---- 阶段 6 工单 03：提交有效行 + 错误报告 ----

export type ImportCommitResult = components["schemas"]["ImportCommitResultDto"];
export type ImportCommitPayload = components["schemas"]["CommitImportBatchDto"];

/**
 * 仅提交有效候选行（Idempotency-Key 由调用方提供并复用；显式确认载荷必须）。
 * 绝不创建课程/发布；返回真实提交摘要。
 */
export function commitImportBatch(
  id: string,
  payload: ImportCommitPayload,
  idempotencyKey: string,
): Promise<ApiResult<ImportCommitResult>> {
  return apiFetch<ImportCommitResult>(`/api/v1/admin/imports/${encodeURIComponent(id)}/commit`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(payload),
  });
}

/**
 * 下载仅含不可提交行的错误报告 CSV（服务端生成；无错误行时返回仅表头）。
 * 返回 CSV 文本（浏览器直接触发下载）。
 */
export async function downloadImportErrorReport(id: string): Promise<{
  ok: boolean;
  csv?: string;
  filename?: string;
  error?: string;
}> {
  try {
    const res = await fetch(`/api/v1/admin/imports/${encodeURIComponent(id)}/error-report`, {
      method: "GET",
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const csv = await res.text();
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    return match?.[1] !== undefined ? { ok: true, csv, filename: match[1] } : { ok: true, csv };
  } catch {
    return { ok: false, error: "下载失败" };
  }
}

// ---- 学习者：已发布课程目录（只读 current release） ----

export type CatalogCourseSummary = components["schemas"]["CatalogCourseSummaryDto"];
export type CatalogCourseDetail = components["schemas"]["CatalogCourseDetailDto"];

export function listCatalogCourses(): Promise<ApiResult<{ items: CatalogCourseSummary[] }>> {
  return apiFetch<{ items: CatalogCourseSummary[] }>("/api/v1/catalog/courses", { method: "GET" });
}

export function getCatalogCourse(courseId: string): Promise<ApiResult<CatalogCourseDetail>> {
  return apiFetch<CatalogCourseDetail>(`/api/v1/catalog/courses/${encodeURIComponent(courseId)}`, {
    method: "GET",
  });
}

// ---- 学习者：报名与主课程选择 ----

export function enrollCourse(
  courseId: string,
  makePrimary: boolean,
): Promise<ApiResult<CatalogCourseDetail>> {
  return apiFetch<CatalogCourseDetail>(
    `/api/v1/catalog/courses/${encodeURIComponent(courseId)}/enroll`,
    { method: "POST", body: JSON.stringify({ makePrimary }) },
  );
}

export function setPrimaryCourse(courseId: string): Promise<ApiResult<CatalogCourseDetail>> {
  return apiFetch<CatalogCourseDetail>("/api/v1/catalog/primary-course", {
    method: "PUT",
    body: JSON.stringify({ courseId }),
  });
}

// ---- 学习者：学习端 /study ----
// 只读今日概览/进度；开始/恢复唯一 active 会话；以服务端为评分/时间/cursor/FSRS/解锁权威。

/** GET /study/today：今日概览（主课程、预算、候选计数、active 会话、是否无任务）。无主课程 → 404。 */
export function getStudyToday(): Promise<ApiResult<StudyToday>> {
  return apiFetch<StudyToday>("/api/v1/study/today", { method: "GET" });
}

/** POST /study/sessions：创建或恢复唯一 active 会话（幂等）；无候选返回 { noWork }。 */
export function createOrResumeStudySession(): Promise<
  ApiResult<StudySession | { noWork: boolean }>
> {
  return apiFetch<StudySession | { noWork: boolean }>("/api/v1/study/sessions", { method: "POST" });
}

/** GET /study/sessions/active：当前 active 会话详情（含有序计划项）。无 active 会话 → 404。 */
export function getActiveStudySession(): Promise<ApiResult<StudySessionDetail>> {
  return apiFetch<StudySessionDetail>("/api/v1/study/sessions/active", { method: "GET" });
}

/** POST /study/sessions/:sessionId/items/:itemId/reveal：确认已展示当前项（幂等）。 */
export function revealStudyItem(
  sessionId: string,
  itemId: string,
): Promise<ApiResult<RevealResult>> {
  return apiFetch<RevealResult>(
    `/api/v1/study/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/reveal`,
    { method: "POST" },
  );
}

/** POST /study/sessions/:sessionId/reviews：提交四级评分（幂等；重试复用同一 clientEventId）。 */
export function submitStudyReview(
  sessionId: string,
  payload: SubmitReviewPayload,
): Promise<ApiResult<SubmitReviewResult>> {
  return apiFetch<SubmitReviewResult>(
    `/api/v1/study/sessions/${encodeURIComponent(sessionId)}/reviews`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

/** GET /study/progress：主课程各单元解锁 + 首测 + 稳定派生状态（只读）。 */
export function getStudyProgress(): Promise<ApiResult<StudyProgress>> {
  return apiFetch<StudyProgress>("/api/v1/study/progress", { method: "GET" });
}
