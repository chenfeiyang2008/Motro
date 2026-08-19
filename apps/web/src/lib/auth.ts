// 客户端认证 API 边界：同源 /api/v1（Web 代理到 API），只通过版本化契约访问。

export interface MembershipInfo {
  plan: "member" | "free";
  status: "member" | "free";
  expiresAt: string | null;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  timezone: string;
  dailyBudgetMinutes: number;
  mustChangePassword: boolean;
  membership?: MembershipInfo;
}

export interface ApiErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    fieldErrors?: { path: string; code: string; message?: string }[];
  };
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data?: T; error?: ApiErrorEnvelope }> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  // 仅在存在请求体时声明 JSON，避免无 body 的 POST（如 logout）被 Fastify 解析为空 JSON 返回 400。
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  if (init?.method && init.method !== "GET") {
    const csrf = readCsrfCookie();
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  let data: T | ApiErrorEnvelope | undefined;
  try {
    data = (await res.json()) as T | ApiErrorEnvelope;
  } catch {
    data = undefined;
  }
  if (!res.ok) return { ok: false, status: res.status, error: data as ApiErrorEnvelope };
  return { ok: true, status: res.status, data: data as T };
}

/** 先做一次安全 GET 以获得 CSRF cookie（双提交）。 */
export async function warmCsrf(): Promise<void> {
  await fetch("/api/v1/health/live", { credentials: "same-origin" }).catch(() => undefined);
}

function readCsrfCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)motro_csrf=([^;]+)/);
  return match?.[1] ?? null;
}

export async function login(
  username: string,
  password: string,
): Promise<{
  ok: boolean;
  user: PublicUser | undefined;
  status: number;
  message: string | undefined;
}> {
  const res = await apiFetch<PublicUser>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  return {
    ok: res.ok,
    user: res.data as PublicUser | undefined,
    status: res.status,
    message: res.error?.error?.message,
  };
}

export async function fetchMe(): Promise<{
  ok: boolean;
  user: PublicUser | undefined;
  status: number;
}> {
  const res = await apiFetch<PublicUser>("/api/v1/auth/me", { method: "GET" });
  return { ok: res.ok, user: res.data as PublicUser | undefined, status: res.status };
}

export async function fetchMeMembership(): Promise<{
  ok: boolean;
  membership: MembershipInfo | undefined;
  status: number;
}> {
  const res = await apiFetch<MembershipInfo>("/api/v1/me/membership", { method: "GET" });
  return { ok: res.ok, membership: res.data as MembershipInfo | undefined, status: res.status };
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; status: number; message: string | undefined }> {
  const res = await apiFetch<{ ok: boolean }>("/api/v1/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return { ok: res.ok, status: res.status, message: res.error?.error?.message };
}

export async function logout(): Promise<{
  ok: boolean;
  status: number;
  message: string | undefined;
}> {
  const res = await apiFetch<{ ok: boolean }>("/api/v1/auth/logout", { method: "POST" });
  return { ok: res.ok, status: res.status, message: res.error?.error?.message };
}
