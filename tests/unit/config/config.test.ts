// 配置边界单测：合法/缺失/非法/生产安全/脱敏。
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, redactConfig } from "@motro/config";

const DEV_ENV: NodeJS.ProcessEnv = { NODE_ENV: "development" };

describe("loadConfig", () => {
  it("development 下使用安全默认值加载成功", () => {
    const config = loadConfig({ ...DEV_ENV });
    expect(config.env).toBe("development");
    expect(config.db.port).toBe(5432);
    expect(config.cookie.secure).toBe(false);
    expect(config.openapi.enabled).toBe(true);
  });

  it("production 缺少必填密钥时在启动前失败并给出字段级错误", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);
    try {
      loadConfig({ NODE_ENV: "production" });
      throw new Error("应当已失败");
    } catch (err) {
      const e = err as ConfigError;
      expect(e.fieldErrors.length).toBeGreaterThan(0);
      const paths = e.fieldErrors.map((f) => f.path);
      expect(paths).toContain("cookie.key");
      expect(paths).toContain("csrf.key");
      expect(paths).toContain("db.password");
      // 错误信息不含任何 secret 原文。
      const text = JSON.stringify(e.fieldErrors);
      expect(text).not.toMatch(/0123456789abcdef|dev_only_change_me/);
    }
  });

  it("非法端口被拒绝", () => {
    expect(() => loadConfig({ ...DEV_ENV, POSTGRES_PORT: "not-a-port" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...DEV_ENV, API_PORT: "99999" })).toThrow(ConfigError);
  });

  it("worker lease 低于心跳安全下界被拒绝", () => {
    expect(() => loadConfig({ ...DEV_ENV, WORKER_LEASE_MS: "599" })).toThrow(ConfigError);
    expect(loadConfig({ ...DEV_ENV, WORKER_LEASE_MS: "600" }).worker.leaseMs).toBe(600);
  });

  it("非法 URL 被拒绝", () => {
    expect(() => loadConfig({ ...DEV_ENV, API_PUBLIC_URL: "not-a-url" })).toThrow(ConfigError);
  });

  it("production 强制 Secure cookie", () => {
    const valid = {
      NODE_ENV: "production",
      SESSION_KEY: "production-session-key-0123456789abcdef",
      CSRF_KEY: "production-csrf-key-0123456789abcdef",
      POSTGRES_PASSWORD: "production-password",
    };
    expect(() => loadConfig({ ...valid, COOKIE_SECURE: "false" })).toThrow(
      /production 必须使用 Secure cookie/,
    );
    // 未显式设置时 production 默认 Secure。
    const config = loadConfig(valid);
    expect(config.cookie.secure).toBe(true);
  });

  it("SameSite=None 必须配合 Secure（冲突规则）", () => {
    expect(() =>
      loadConfig({ ...DEV_ENV, COOKIE_SAMESITE: "none", COOKIE_SECURE: "false" }),
    ).toThrow(ConfigError);
    const ok = loadConfig({ ...DEV_ENV, COOKIE_SAMESITE: "none", COOKIE_SECURE: "true" });
    expect(ok.cookie.sameSite).toBe("none");
    expect(ok.cookie.secure).toBe(true);
  });

  it("production 显式开启不安全配置被拒绝", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        SESSION_KEY: "production-session-key-0123456789abcdef",
        CSRF_KEY: "production-csrf-key-0123456789abcdef",
        POSTGRES_PASSWORD: "production-password",
        OPENAPI_ENABLED: "true",
      }),
    ).not.toThrow(ConfigError);
  });

  it("redactConfig 不输出密钥原文", () => {
    const config = loadConfig({
      ...DEV_ENV,
      SESSION_KEY: "very-secret-session-key-0123456789abcdef",
      CSRF_KEY: "very-secret-csrf-key-0123456789abcdef",
      POSTGRES_PASSWORD: "super-secret-password",
    });
    const text = JSON.stringify(redactConfig(config));
    expect(text).not.toMatch(/very-secret|super-secret-password/);
    expect(text).toContain("***");
  });
});
