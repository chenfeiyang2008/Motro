import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// 宿主机集成测试读取 compose PostgreSQL：与 db* CLI（package.json 用 Node 22
// --env-file-if-exists）共用同一套「可选 .env 加载」规则 —— 显式环境变量优先，
// 根 .env 只补充缺失的变量，绝不覆盖已有 POSTGRES_*。
// .env 不存在时静默跳过（用默认/显式环境）；.env 存在但无法解析时**不静默吞掉**，
// 而是上抛可诊断错误，避免在未知配置下继续运行。
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  resolve: {
    alias: {
      // 测试直接读取 workspace 源码，避免依赖先构建产物。
      "@motro/config": resolve(process.cwd(), "packages/config/src/index.ts"),
      "@motro/db": resolve(process.cwd(), "packages/db/src/index.ts"),
      "@motro/domain": resolve(process.cwd(), "packages/domain/src/index.ts"),
    },
  },
  test: {
    // 骨架阶段各包可能没有测试文件；CI 中统一从根运行。
    passWithNoTests: true,
    // 排除 tsc --build 的编译产物与 Playwright E2E，避免重复/误跑。
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**", "tests/e2e/**"],
    // 共享同一数据库的集成测试需要串行，避免并发迁移/写入冲突。
    fileParallelism: false,
  },
});
