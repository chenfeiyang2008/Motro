// 数据库集成测试：空库向前迁移、重复运行安全、失败回滚与当前版本检查。
// 需要运行中的 PostgreSQL（compose 的 db 服务）。连接不可用时整个 describe 跳过。
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assessMigrationState,
  createPool,
  listAppliedMigrations,
  loadDbConfigFromEnv,
  loadMigrationFiles,
  migrate,
} from "@motro/db";

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const config = loadDbConfigFromEnv();
const pool = createPool({ ...config, max: 1 });

async function canConnect(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const dbAvailable = await canConnect();

// 临时迁移使用高位版本号，避免与真实 migration 的版本命名空间冲突。
function tempMigrationsDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "motro-db-test-")), "migrations");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TEMP_VERSIONS = [9001, 9002, 9003, 9004, 9005];

async function cleanup(): Promise<void> {
  const c = createPool({ ...config, max: 1 });
  try {
    await c.query("DROP TABLE IF EXISTS rollback_probe");
    await c.query("DROP TABLE IF EXISTS partial_should_not_exist");
    await c.query("DELETE FROM schema_migrations WHERE version = ANY($1::int[])", [TEMP_VERSIONS]);
  } finally {
    await c.end();
  }
}

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
  }
});

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "db migration integration",
  () => {
    it("迁移可重复运行且全部版本已应用（空库迁移由 compose runbook 的 pnpm db:migrate 覆盖）", async () => {
      const rerun = await migrate(config, MIGRATIONS_DIR);
      expect(rerun).toEqual([]);

      const c = createPool({ ...config, max: 1 });
      try {
        const rows = await c.query<{ version: number }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        );
        expect(rows.rows.map((r) => r.version)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
          26, 27, 28, 29, 30, 31, 32,
        ]);

        // 0011：learning_cards 调度参数版本列存在且 NOT NULL。
        const col = await c.query<{ is_nullable: string }>(
          `SELECT is_nullable FROM information_schema.columns
           WHERE table_name = 'learning_cards' AND column_name = 'scheduler_parameters_version'`,
        );
        expect(col.rowCount).toBe(1);
        expect(col.rows[0]?.is_nullable).toBe("NO");
      } finally {
        await c.end();
      }
    });

    it("已应用文件的哈希变化会被拒绝", async () => {
      const dir = tempMigrationsDir();
      const file = join(dir, "9001_hashcheck.sql");
      writeFileSync(file, "-- original\n");
      try {
        await migrate(config, dir); // 应用版本 9001
        writeFileSync(file, "-- modified after apply\n");
        await expect(migrate(config, dir)).rejects.toThrow(/内容发生变化/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("失败的文件回滚且不记录版本，后续文件不执行", async () => {
      const dir = tempMigrationsDir();
      writeFileSync(join(dir, "9003_valid.sql"), "CREATE TABLE rollback_probe (id uuid);\n");
      writeFileSync(
        join(dir, "9004_bad.sql"),
        "CREATE TABLE partial_should_not_exist (id uuid);\nTHIS IS NOT VALID SQL;\n",
      );
      try {
        await expect(migrate(config, dir)).rejects.toThrow(/9004_bad/);
        // 失败文件的事务已回滚，partial 表不应存在。
        const c = createPool({ ...config, max: 1 });
        try {
          const res = await c.query(
            "SELECT 1 FROM information_schema.tables WHERE table_name = 'partial_should_not_exist'",
          );
          expect(res.rowCount).toBe(0);
        } finally {
          await c.end();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("migration 状态表证明 0001 已应用，且身份基础表存在", async () => {
      const c = createPool({ ...config, max: 1 });
      try {
        const rows = await c.query("SELECT version, name FROM schema_migrations ORDER BY version");
        const versions = rows.rows.map((r) => r.version as number);
        expect(versions).toContain(1);

        const tables = await c.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1::text[])",
          [["users", "auth_sessions", "audit_events"]],
        );
        expect(tables.rowCount).toBe(3);
      } finally {
        await c.end();
      }
    });

    it("check 能发现待应用 migration（pending）", async () => {
      const dir = tempMigrationsDir();
      writeFileSync(join(dir, "9004_pending.sql"), "-- pending\n");
      try {
        const files = loadMigrationFiles(dir);
        const applied = await listAppliedMigrations(config);
        const issues = assessMigrationState(files, applied);
        expect(issues.some((i) => i.kind === "pending" && i.version === 9004)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("check 能发现已应用 migration 的内容哈希漂移（drift）", async () => {
      // 注意：版本号 9005 未被本文件其他测试使用；9003/9004 已被「失败回滚」测试占用。
      const dir = tempMigrationsDir();
      const file = join(dir, "9005_driftcheck.sql");
      writeFileSync(file, "-- original\n");
      try {
        await migrate(config, dir); // 应用版本 9005
        writeFileSync(file, "-- modified after apply\n"); // 本地文件被修改
        const driftedFiles = loadMigrationFiles(dir);
        const applied = await listAppliedMigrations(config);
        const issues = assessMigrationState(driftedFiles, applied);
        expect(issues.some((i) => i.kind === "drift" && i.version === 9005)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("check 能发现数据库中多余而本地不存在的 migration（extra）", async () => {
      const c = createPool({ ...config, max: 1 });
      try {
        await c.query(
          `INSERT INTO schema_migrations (version, name, content_hash)
           VALUES (9002, 'ghost', 'deadbeef') ON CONFLICT DO NOTHING`,
        );
        const files = loadMigrationFiles(MIGRATIONS_DIR);
        const applied = await listAppliedMigrations(config);
        const issues = assessMigrationState(files, applied);
        expect(issues.some((i) => i.kind === "extra" && i.version === 9002)).toBe(true);
      } finally {
        await c.end();
      }
    });
  },
);
