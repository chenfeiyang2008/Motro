// @motro/db — 数据库边界。
// 连接、Drizzle schema、显式 SQL migration 执行器与 CLI 入口。

export * from "./schema/platform-identity.js";
export * from "./schema/lexicon.js";
export * from "./schema/courses.js";
export * from "./schema/imports.js";
export * from "./schema/operations.js";
export * from "./schema/wiktionary.js";
export { createPool, type DbConfig, loadDbConfigFromEnv } from "./client.js";
export {
  assessMigrationState,
  listAppliedMigrations,
  migrate,
  loadMigrationFiles,
  type AppliedMigration,
  type MigrationFile,
  type MigrationIssue,
  type MigrationIssueKind,
} from "./migrate.js";
