// @motro/db — 数据库边界。
// 连接、Drizzle schema、显式 SQL migration 执行器与 CLI 入口。

export * from "./schema/platform-identity.js";
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
