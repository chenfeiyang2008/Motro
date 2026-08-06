// CLI：检查 migration 状态。对照本地文件与数据库记录，报告 pending/drift/extra。
import { loadDbConfigFromEnv } from "./client.js";
import {
  assessMigrationState,
  listAppliedMigrations,
  loadMigrationFiles,
  resolveMigrationsDir,
} from "./migrate.js";

async function main(): Promise<void> {
  const migrationsDir = resolveMigrationsDir();
  const files = loadMigrationFiles(migrationsDir);
  const applied = await listAppliedMigrations(loadDbConfigFromEnv());
  const issues = assessMigrationState(files, applied);

  if (issues.length === 0) {
    console.log(`db:migrate:check — OK：共 ${files.length} 个 migration，状态一致`);
    return;
  }

  console.error(`db:migrate:check — 发现 ${issues.length} 个问题：`);
  for (const issue of issues) {
    console.error(
      `  [${issue.kind}] ${String(issue.version).padStart(4, "0")}_${issue.name}：${issue.detail}`,
    );
  }
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`db:migrate:check 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
