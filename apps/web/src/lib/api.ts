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

// ---- 阶段 6 工单 04：任务状态（operations） ----

export type OperationSummary = components["schemas"]["OperationSummaryDto"];
export type OperationAttemptSummary = components["schemas"]["OperationAttemptSummaryDto"];
export type OperationListResponse = components["schemas"]["OperationListResponseDto"];
export type OperationDetail = components["schemas"]["OperationDetailDto"];
export type OperationRetryResult = components["schemas"]["OperationRetryResultDto"];

/** 分页读取后台操作（游标分页；可安全按 status/type 过滤）。 */
export function listOperations(opts: {
  status?: string;
  operationType?: string;
  cursor: string | null;
  limit?: number;
}): Promise<ApiResult<OperationListResponse>> {
  const search = new URLSearchParams();
  if (opts.status) search.set("status", opts.status);
  if (opts.operationType) search.set("operationType", opts.operationType);
  if (opts.cursor) search.set("cursor", opts.cursor);
  if (opts.limit !== undefined) search.set("limit", String(opts.limit));
  const qs = search.toString();
  return apiFetch<OperationListResponse>(
    `/api/v1/admin/operations${qs.length > 0 ? `?${qs}` : ""}`,
    { method: "GET" },
  );
}

/** 单个 operation 详情（含 attempt 时间线与脱敏错误）。 */
export function getOperation(id: string): Promise<ApiResult<OperationDetail>> {
  return apiFetch<OperationDetail>(`/api/v1/admin/operations/${encodeURIComponent(id)}`, {
    method: "GET",
  });
}

/** 管理员重试失败/人工任务（Idempotency-Key 由调用方提供并复用）。 */
export function retryOperation(
  id: string,
  idempotencyKey: string,
): Promise<ApiResult<OperationRetryResult>> {
  return apiFetch<OperationRetryResult>(
    `/api/v1/admin/operations/${encodeURIComponent(id)}/retry`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ confirm: true }),
    },
  );
}

// ---- 管理员：用户管理（账号）----
// 后端 /admin/users 响应体的 OpenAPI 契约（AdminUserDto / AdminUserListDto /
// AdminCreateUserResultDto）已由 openapi:types 同步到 @motro/api-client。
// 这里以 generated client 的类型为唯一来源，避免手写类型漂移。
// 安全边界：password_hash / session token / 审计原始 payload 永不进入此层。

export type AdminUser = components["schemas"]["AdminUserDto"];
export type AdminUserRole = AdminUser["role"];
export type AdminUserStatus = AdminUser["status"];
export type AdminUserList = components["schemas"]["AdminUserListDto"];
export type AdminUserCreateResult = components["schemas"]["AdminCreateUserResultDto"];

export interface CreateAdminUserPayload {
  username: string;
  displayName: string;
  timezone: string;
  dailyBudgetMinutes: number;
  role?: AdminUserRole;
}

/** 管理员：列出账号（含状态/创建时间，供用户管理表格与停用状态展示）。 */
export function listAdminUsers(): Promise<ApiResult<AdminUserList>> {
  return apiFetch<AdminUserList>("/api/v1/admin/users", { method: "GET" });
}

/**
 * 管理员：创建账号，返回一次性密码（仅此一次）。
 * Idempotency-Key 由调用方按“意图”生成并复用。
 */
export function createAdminUser(
  payload: CreateAdminUserPayload,
  idempotencyKey: string,
): Promise<ApiResult<AdminUserCreateResult>> {
  return apiFetch<AdminUserCreateResult>("/api/v1/admin/users", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "idempotency-key": idempotencyKey },
  });
}

/** 管理员：停用账号并撤销其全部会话（非幂等，无 Idempotency-Key）。 */
export function disableAdminUser(id: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch<{ ok: boolean }>(`/api/v1/admin/users/${encodeURIComponent(id)}/disable`, {
    method: "POST",
  });
}

/**
 * 管理员：重置一次性密码并撤销全部会话，返回新一次性密码。
 * Idempotency-Key 由调用方按“意图”生成并复用。
 */
export function resetAdminUserPassword(
  id: string,
  idempotencyKey: string,
): Promise<ApiResult<AdminUserCreateResult>> {
  return apiFetch<AdminUserCreateResult>(
    `/api/v1/admin/users/${encodeURIComponent(id)}/reset-password`,
    { method: "POST", headers: { "idempotency-key": idempotencyKey } },
  );
}

// ---- 管理员：词库审核（Ticket 07/18） ----
// 契约来自 @motro/api-client 的 ReviewDraftListDto / ReviewDraftDetailDto /
// ReviewDecisionDto / ReviewDecisionResponseDto。
// 安全边界：审核草稿的 provider payload/prompt/哈希/内部路径绝不进入此层；
// 只读 detail/list/history 的投影（spelling、来源授权事实、decision 快照）。

export type ReviewDraftListItem = components["schemas"]["ReviewDraftListItemDto"];
export type ReviewDraftList = components["schemas"]["ReviewDraftListDto"];
export type ReviewDraftDetail = components["schemas"]["ReviewDraftDetailDto"];
export type ReviewDecision = components["schemas"]["ReviewDecisionDto"];
export type ReviewDecisionResponse = components["schemas"]["ReviewDecisionResponseDto"];
export type ReviewDecisionType = components["schemas"]["ReviewDecisionRequestDto"]["decision"];

/** 待审草稿队列（来源完整、等待审核；含可补全 manual_action 的有效投影）。 */
export function listReviewDrafts(): Promise<ApiResult<ReviewDraftList>> {
  return apiFetch<ReviewDraftList>("/api/v1/admin/reviews", { method: "GET" });
}

/** 单个草稿详情（含来源投影 + 当前决定）。 */
export function getReviewDraftDetail(id: string): Promise<ApiResult<ReviewDraftDetail>> {
  return apiFetch<ReviewDraftDetail>(`/api/v1/admin/reviews/${encodeURIComponent(id)}`, {
    method: "GET",
  });
}

/** 该草稿的历史审核决定（不可变只读）。 */
export function getReviewHistory(id: string): Promise<ApiResult<ReviewDraftList>> {
  return apiFetch<ReviewDraftList>(`/api/v1/admin/reviews/${encodeURIComponent(id)}/history`, {
    method: "GET",
  });
}

/**
 * 提交不可变人工审核决定（accept / accept_with_edits / reject）。
 * Idempotency-Key 由调用方按“意图”生成并复用；重放返回冻结首响应（isIdempotentReplay）。
 */
export function submitReviewDecision(
  id: string,
  body: components["schemas"]["ReviewDecisionRequestDto"],
  idempotencyKey: string,
): Promise<ApiResult<ReviewDecisionResponse>> {
  return apiFetch<ReviewDecisionResponse>(
    `/api/v1/admin/reviews/${encodeURIComponent(id)}/decision`,
    { method: "POST", body: JSON.stringify(body), headers: { "idempotency-key": idempotencyKey } },
  );
}

/** 人工处理可补全的 manual_action（append-only handling fact）。返回 { handled, draftId }。 */
export function resolveReviewManualAction(
  id: string,
  body: { reason: string; supplementSummary?: string },
  idempotencyKey: string,
): Promise<ApiResult<{ handled: boolean; draftId: string }>> {
  return apiFetch<{ handled: boolean; draftId: string }>(
    `/api/v1/admin/reviews/${encodeURIComponent(id)}/resolve`,
    { method: "POST", body: JSON.stringify(body), headers: { "idempotency-key": idempotencyKey } },
  );
}

// ---- 学习者：已发布课程目录（只读 current release + keyset 游标分页） ----

export type CatalogCourseSummary = components["schemas"]["CatalogCourseSummaryDto"];
export type CatalogCourseDetail = components["schemas"]["CatalogCourseDetailDto"];

export interface CatalogCourseList {
  items: CatalogCourseSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListCatalogCoursesOptions {
  /** 每页条目数，默认 24，最大 50。 */
  limit?: number;
  /** 不透明分页游标（由上一页返回），首页不传。 */
  cursor?: string;
}

export function listCatalogCourses(
  opts: ListCatalogCoursesOptions = {},
): Promise<ApiResult<CatalogCourseList>> {
  const search = new URLSearchParams();
  if (opts.limit !== undefined) search.set("limit", String(opts.limit));
  if (opts.cursor !== undefined) search.set("cursor", opts.cursor);
  const qs = search.toString();
  const path = qs ? `/api/v1/catalog/courses?${qs}` : "/api/v1/catalog/courses";
  return apiFetch<CatalogCourseList>(path, { method: "GET" });
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

// ---- 学习者：个人 XP 与排行榜（Ticket 09）----
// 契约来自 @motro/api-client 的 MeXpDto / WeeklyLeaderboardDto / LeaderboardVisibilityDto。
// 隐私：排行榜公开行只包含后端提供的 displayName + challengePoints + rank；
// 绝不读取/显示 password、session、provider payload、audit internal 或他人隐私字段。

export type MeXp = components["schemas"]["MeXpDto"];
export type WeeklyLeaderboard = components["schemas"]["WeeklyLeaderboardDto"];
export type LeaderboardRow = components["schemas"]["LeaderboardRowDto"];
export type LeaderboardVisibilityPayload = components["schemas"]["LeaderboardVisibilityDto"];
// generated 把 viewerRank 生成成 Record<string, never>（源为 number | null），此处修正。
export type WeeklyLeaderboardFixed = Omit<WeeklyLeaderboard, "viewerRank"> & {
  viewerRank: number | null;
};

/** GET /me/xp：当前登录用户个人学习 XP（只属个人，永不参与排行榜）。 */
export function getMeXp(): Promise<ApiResult<MeXp>> {
  return apiFetch<MeXp>("/api/v1/me/xp", { method: "GET" });
}

/** GET /me/learning-summary：当前用户可重建学习概览（不含 XP/排行榜/CEFR）。 */
export function getLearningSummary(): Promise<
  ApiResult<components["schemas"]["LearningSummaryDto"]>
> {
  return apiFetch<components["schemas"]["LearningSummaryDto"]>("/api/v1/me/learning-summary", {
    method: "GET",
  });
}

export interface WeeklyLeaderboardOptions {
  challengeWeek?: string;
  cursor?: string;
  limit?: number;
}

/** GET /leaderboard/weekly：本周挑战积分排行榜（仅 Challenge Points；daily XP 不参与）。 */
export function getWeeklyLeaderboard(
  opts: WeeklyLeaderboardOptions = {},
): Promise<ApiResult<WeeklyLeaderboardFixed>> {
  const search = new URLSearchParams();
  if (opts.challengeWeek) search.set("challengeWeek", opts.challengeWeek);
  if (opts.cursor) search.set("cursor", opts.cursor);
  // 服务端默认 limit=20；不传 limit 以避免类校验器对字符串 query 的 422（@IsInt 不接受字符串）。
  if (opts.limit !== undefined) search.set("limit", String(opts.limit));
  const qs = search.toString();
  const path = qs ? `/api/v1/leaderboard/weekly?${qs}` : "/api/v1/leaderboard/weekly";
  return apiFetch<WeeklyLeaderboardFixed>(path, { method: "GET" });
}

// generated 把 visibility 响应类型标成 { public: boolean }，但 controller+service 实际返回 { isPublic: boolean }。
export type LeaderboardVisibilityResult = { isPublic: boolean };

/**
 * POST /leaderboard/visibility：设置公开参与状态。
 * 幂等：同一 Idempotency-Key + 同 payload → 冻结重放；同 key + 不同 payload → 409。
 * CSRF 由 apiFetch 自动附加 x-csrf-token。
 */
export function setLeaderboardVisibility(
  isPublic: boolean,
  idempotencyKey: string,
): Promise<ApiResult<LeaderboardVisibilityResult>> {
  return apiFetch<LeaderboardVisibilityResult>("/api/v1/leaderboard/visibility", {
    method: "POST",
    body: JSON.stringify({ public: isPublic }),
    headers: { "idempotency-key": idempotencyKey },
  });
}
