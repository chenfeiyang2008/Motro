// CLI：应用全部未执行的 migration。
import { loadDbConfigFromEnv } from "./client.js";
import { migrate, resolveMigrationsDir } from "./migrate.js";

async function main(): Promise<void> {
  const migrationsDir = resolveMigrationsDir();
  const applied = await migrate(loadDbConfigFromEnv(), migrationsDir);
  if (applied.length === 0) {
    console.log("db:migrate — 无待应用的 migration");
    return;
  }
  for (const row of applied) {
    console.log(`db:migrate — 已应用 ${String(row.version).padStart(4, "0")}_${row.name}`);
  }
}

main().catch((err: unknown) => {
  console.error(`db:migrate 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
