// CSRF 双提交校验（无需数据库）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createApp } from "../bootstrap-app.js";

function extractCookies(setCookie: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
      ? [setCookie]
      : [];
  for (const line of lines) {
    const pair = line.split(";")[0];
    if (!pair) continue;
    const idx = pair.indexOf("=");
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1);
  }
  return out;
}

describe("csrf protection", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("不安全方法缺少 x-csrf-token 头时返回 403", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("带正确 csrf cookie + 头时不再因 CSRF 被拒（走到路由层）", async () => {
    const warm = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    const cookies = extractCookies(warm.headers["set-cookie"]);
    const csrf = cookies["motro_csrf"];
    expect(csrf).toBeTruthy();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/does-not-exist",
      headers: { cookie: `motro_csrf=${csrf}`, "x-csrf-token": csrf },
      payload: {},
    });
    // CSRF 通过后到达路由层（404），而非 CSRF 拒绝（403）。
    expect(res.statusCode).toBe(404);
  });

  it("CSRF cookie 非 HttpOnly（客户端需读取以发送头）", async () => {
    const warm = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    const sc = warm.headers["set-cookie"];
    const joined = Array.isArray(sc) ? sc.join("; ") : String(sc ?? "");
    expect(joined).toContain("motro_csrf=");
    expect(joined.toLowerCase()).not.toContain("httponly");
  });
});
