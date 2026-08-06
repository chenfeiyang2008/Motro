// 无业务依赖的 CI smoke test：验证 workspace 工具链确实被声明并可按脚本调用。
// 它不触碰任何业务模型，只检查根配置与包骨架。
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), "utf8")) as Record<string, unknown>;
}

describe("workspace toolchain smoke", () => {
  it("根 package.json 声明了全部质量门禁脚本", () => {
    const pkg = readJson("package.json");
    const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
    for (const name of ["format:check", "lint", "typecheck", "test", "build"]) {
      expect(scripts[name], `根脚本 ${name} 缺失`).toBeTypeOf("string");
    }
  });

  it("固定了 Node/pnpm 版本策略", () => {
    const pkg = readJson("package.json");
    expect(pkg.packageManager).toMatch(/^pnpm@/);
    const engines = (pkg as { engines?: Record<string, string> }).engines ?? {};
    expect(engines.node).toMatch(/^>=?22/);
  });

  it("pnpm-workspace.yaml 声明 apps/packages 通配，且各包目录存在", () => {
    const yaml = readFileSync(resolve(ROOT, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain("apps/*");
    expect(yaml).toContain("packages/*");
    const expected = [
      "apps/web",
      "apps/api",
      "packages/domain",
      "packages/db",
      "packages/config",
      "packages/api-client",
    ];
    for (const dir of expected) {
      expect(existsSync(resolve(ROOT, dir, "package.json")), `${dir}/package.json 缺失`).toBe(true);
    }
  });
});
