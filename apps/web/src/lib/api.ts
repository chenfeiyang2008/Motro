// 版本化 API 客户端边界：只允许通过 /api/v1 访问服务，类型来自 @motro/api-client。
// 服务端健康检查走 API_INTERNAL_URL；客户端词条操作走同源 /api/v1（Next 代理到 API）。
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

// ---- 管理员：词条（客户端调用，同源 /api/v1）----

export type LexicalEntrySummary = components["schemas"]["LexicalEntrySummaryDto"];
export type LexicalEntryDetail = components["schemas"]["LexicalEntryDetailDto"];
export type LexicalEntryListResponse = components["schemas"]["LexicalEntryListResponseDto"];
export type CreateLexicalEntryPayload = components["schemas"]["CreateLexicalEntryDto"];
export type DuplicateCandidate = components["schemas"]["DuplicateCandidateDto"];
export type FieldError = { path: string; code: string; message?: string };

export interface LexiconApiError {
  code?: string;
  message?: string;
  requestId?: string;
  duplicateCandidates?: DuplicateCandidate[];
  fieldErrors?: FieldError[];
  retryable?: boolean;
}

interface LexiconApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: LexiconApiError;
}

async function lexiconFetch<T>(path: string, init?: RequestInit): Promise<LexiconApiResult<T>> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  if (init?.method && init.method !== "GET") {
    const csrf = readCsrfCookie();
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  let data: T | { error?: LexiconApiError } | undefined;
  try {
    data = (await res.json()) as T | { error?: LexiconApiError };
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    // 服务端错误信封：{ error: { code, message, ... } } → 解包成 LexiconApiError。
    const err = (data as { error?: LexiconApiError } | undefined)?.error;
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
}): Promise<LexiconApiResult<LexicalEntryListResponse>> {
  const search = new URLSearchParams();
  const trimmed = opts.q.trim();
  if (trimmed.length > 0) search.set("q", trimmed);
  if (opts.cursor) search.set("cursor", opts.cursor);
  const qs = search.toString();
  return lexiconFetch<LexicalEntryListResponse>(
    `/api/v1/admin/lexical-entries${qs.length > 0 ? `?${qs}` : ""}`,
    { method: "GET" },
  );
}

/** 创建手工词条；重复候选时返回 409 DUPLICATE_WARNING（不静默落库）。 */
export function createLexicalEntry(
  payload: CreateLexicalEntryPayload,
): Promise<LexiconApiResult<LexicalEntryDetail>> {
  return lexiconFetch<LexicalEntryDetail>("/api/v1/admin/lexical-entries", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getLexicalEntry(id: string): Promise<LexiconApiResult<LexicalEntryDetail>> {
  return lexiconFetch<LexicalEntryDetail>(
    `/api/v1/admin/lexical-entries/${encodeURIComponent(id)}`,
    { method: "GET" },
  );
}
