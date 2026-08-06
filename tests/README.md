# tests

仓库级测试目录，后续承载需要跨包协作的集成测试（PostgreSQL、API、E2E 起点等）。

骨架阶段仅存在此说明与 tsconfig。单元测试采用各包内就近放置的约定（`src/**/*.test.ts`），由根 `vitest` 统一收集运行。
