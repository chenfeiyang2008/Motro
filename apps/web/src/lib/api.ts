// 版本化 API 客户端边界：只允许通过 /api/v1 访问服务，类型来自 @motro/api-client。
import type { paths } from "@motro/api-client";

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
