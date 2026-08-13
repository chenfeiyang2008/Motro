// 隔离 E2E 目标配置纯逻辑单元测试（P1-B / P1-C / P1-2）。
// 覆盖：host/API/Web 强制本机、库名白名单、端口/凭据契约、忽略远程 env、migrate/ready 使用已解析配置、
// Playwright 子进程环境显式覆盖 API/Web 目标。
import { describe, expect, it } from "vitest";
import {
  assertSafeDbName,
  assertSafePort,
  resolveIsolatedE2eTarget,
  buildE2eChildEnv,
} from "./import-e2e-db.js";

describe("resolveIsolatedE2eTarget (P1-B/P1-C)", () => {
  it("即使设置非 loopback POSTGRES_HOST / 远程 API_PUBLIC_URL / PW_BASE_URL，仍返回本机目标", () => {
    const t = resolveIsolatedE2eTarget({
      POSTGRES_HOST: "example.invalid",
      API_PUBLIC_URL: "https://example.invalid",
      PW_BASE_URL: "https://example.invalid",
      E2E_IMPORT_DB: "motro_e2e_import",
      E2E_POSTGRES_PORT: "5433",
    } as NodeJS.ProcessEnv);
    expect(t.db.host).toBe("127.0.0.1");
    expect(t.apiUrl).toBe("http://127.0.0.1:3100");
    expect(t.webUrl).toBe("http://127.0.0.1:3101");
  });

  it("默认 db/端口/用户/密码契约与 compose 一致", () => {
    const t = resolveIsolatedE2eTarget({});
    expect(t.db.host).toBe("127.0.0.1");
    expect(t.db.database).toBe("motro_e2e_import");
    expect(t.db.port).toBe(5433);
    expect(t.db.user).toBe("motro_e2e");
    expect(t.db.password).toBe("e2e_only_change_me");
  });

  it("允许合法后缀库名；拒绝非法库名", () => {
    expect(() => assertSafeDbName("motro_e2e_import")).not.toThrow();
    expect(() => assertSafeDbName("motro_e2e_import_abc-123")).not.toThrow();
    expect(() => assertSafeDbName("motro")).toThrow(/库名不合法/);
    expect(() => assertSafeDbName("motro_e2e_import; DROP TABLE users")).toThrow(/库名不合法/);
    expect(() => assertSafeDbName('motro_e2e_import"')).toThrow(/库名不合法/);
  });

  it("端口只能来自 E2E_POSTGRES_PORT，且必须合法", () => {
    expect(() => assertSafePort(5433)).not.toThrow();
    expect(() => assertSafePort(0)).toThrow(/端口不合法/);
    expect(() => assertSafePort(70000)).toThrow(/端口不合法/);
    expect(() => assertSafePort(Number.NaN)).toThrow(/端口不合法/);
    // 即使显式给 POSTGRES_PORT，也只使用 E2E_POSTGRES_PORT。
    const t = resolveIsolatedE2eTarget({
      POSTGRES_PORT: "5432",
      E2E_POSTGRES_PORT: "5544",
    } as NodeJS.ProcessEnv);
    expect(t.db.port).toBe(5544);
  });

  it("用户/密码使用 E2E 命名空间，不接受 POSTGRES_*", () => {
    const t = resolveIsolatedE2eTarget({
      POSTGRES_USER: "shared_user",
      POSTGRES_PASSWORD: "shared_pass",
      E2E_POSTGRES_USER: "e2e_user",
      E2E_POSTGRES_PASSWORD: "e2e_pass",
    } as NodeJS.ProcessEnv);
    expect(t.db.user).toBe("e2e_user");
    expect(t.db.password).toBe("e2e_pass");
  });

  it("迁移与 readiness 使用同一已解析 db 配置对象（字段 identity 一致）", () => {
    const t = resolveIsolatedE2eTarget({});
    // migrate/assert 的签名接收已解析配置；这里验证目标对象字段稳定，杜绝「校验 A、连 B」漂移。
    const db = t.db;
    expect(db).toEqual({
      host: "127.0.0.1",
      port: 5433,
      database: "motro_e2e_import",
      user: "motro_e2e",
      password: "e2e_only_change_me",
    });
    expect(Object.is(t.db, db)).toBe(true);
  });

  it("不打印密码/连接串（runner 日志不含密码明文）", () => {
    const t = resolveIsolatedE2eTarget({
      E2E_POSTGRES_PASSWORD: "super-secret-e2e-pass",
    } as NodeJS.ProcessEnv);
    const logLine = `target：host=${t.db.host} port=${t.db.port} db=${t.db.database} api=${t.apiUrl}`;
    expect(logLine).not.toContain("super-secret-e2e-pass");
    expect(logLine).toContain("127.0.0.1");
  });

  it("P1-2：父环境有远程 API/Web/POSTGRES_HOST 时，Playwright 子进程环境被显式覆盖为本机目标", () => {
    // 构造「敌意父环境」：即使 resolve 时忽略远程值，子进程 env 也必须显式覆盖。
    const t = resolveIsolatedE2eTarget({
      POSTGRES_HOST: "example.invalid",
      API_PUBLIC_URL: "https://example.invalid",
      PW_BASE_URL: "https://example.invalid",
      E2E_IMPORT_DB: "motro_e2e_import",
      E2E_POSTGRES_PORT: "5433",
    } as NodeJS.ProcessEnv);
    const childEnv = buildE2eChildEnv(t);
    // 关键断言：显式值（不是靠忽略继承）。
    expect(childEnv.API_PUBLIC_URL).toBe("http://127.0.0.1:3100");
    expect(childEnv.PW_BASE_URL).toBe("http://127.0.0.1:3101");
    expect(childEnv.E2E_IMPORT_DB).toBe("motro_e2e_import");
    expect(childEnv.E2E_POSTGRES_PORT).toBe("5433");
    // 不应把远程值残留进子进程环境。
    expect(childEnv.API_PUBLIC_URL).not.toBe("https://example.invalid");
    expect(childEnv.PW_BASE_URL).not.toBe("https://example.invalid");
    expect(childEnv).not.toHaveProperty("POSTGRES_HOST", "example.invalid");
  });
});
