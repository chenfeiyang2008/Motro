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
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  if (init?.method && init.method !== "GET") {
    const csrf = readCsrfCookie();
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
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
