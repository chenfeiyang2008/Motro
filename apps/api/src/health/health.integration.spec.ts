// API 外壳集成测试：health、错误信封、404、requestId。无需真实数据库。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createApp } from "../bootstrap-app.js";

describe("api shell", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/v1/health/live 返回结构化健康信息", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("motro-api");
  });

  it("GET /api/v1/health/ready 返回结构化结果且不泄露细节（状态取决于数据库可达性）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    // 数据库可达 → 200 ok；不可达 → 503 degraded。结构保持一致。
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json();
    expect(["ok", "degraded"]).toContain(body.status);
    expect(body.checks?.db).toMatch(/^(ok|down)$/);
    expect(typeof body.time).toBe("string");
  });

  it("未知路由返回统一错误信封并携带 requestId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error.requestId.length).toBeGreaterThan(0);
    expect(res.headers["x-request-id"]).toBeTruthy();
  });
});
