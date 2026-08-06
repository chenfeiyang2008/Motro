import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

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
