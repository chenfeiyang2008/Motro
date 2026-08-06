// 显式 SQL migration 执行器。
// 每个 migration 在自己的事务内执行；失败即回滚该文件并停止，返回非零退出码。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DbConfig } from "@motro/config";
import { createPool } from "./client.js";

const MIGRATION_FILE_RE = /^(\d+)_([a-z0-9_]+)\.sql$/;

const CREATE_STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    content_hash text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

export interface MigrationFile {
  version: number;
  name: string;
  fileName: string;
  sql: string;
  contentHash: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  contentHash: string;
  appliedAt: Date;
}

/** 读取并排序 migration 目录中的 SQL 文件（纯函数，可单测）。 */
export function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const fileName of readdirSync(migrationsDir)) {
    const match = MIGRATION_FILE_RE.exec(fileName);
    if (!match) continue;
    const version = Number(match[1]);
    const name = match[2] ?? "";
    if (!Number.isInteger(version) || name.length === 0) continue;
    const sql = readFileSync(join(migrationsDir, fileName), "utf8");
    const contentHash = createHash("sha256").update(sql).digest("hex");
    files.push({ version, name, fileName, sql, contentHash });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

export function resolveMigrationsDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const fromEnv = process.env.MOTRO_MIGRATIONS_DIR;
  if (fromEnv) return resolve(fromEnv);
  // 默认相对于进程工作目录（仓库根）。
  return resolve(process.cwd(), "db/migrations");
}

interface MigrationRow {
  version: number;
  name: string;
  content_hash: string;
}

/**
 * 从空库向前执行全部未应用的 migration。
 * 已应用文件的 content_hash 变化会被视为危险并拒绝执行。
 */
export async function migrate(
  config: DbConfig,
  migrationsDir: string,
): Promise<AppliedMigration[]> {
  const pool = createPool({ ...config, max: 1 });
  const client = await pool.connect();
  try {
    await createStateTable(client);

    const files = loadMigrationFiles(migrationsDir);
    const applied = new Map<number, MigrationRow>();
    const result = await client.query<MigrationRow>(
      "SELECT version, name, content_hash FROM schema_migrations ORDER BY version",
    );
    for (const row of result.rows) applied.set(row.version, row);

    const appliedNow: AppliedMigration[] = [];
    for (const file of files) {
      const existing = applied.get(file.version);
      if (existing) {
        if (existing.content_hash !== file.contentHash) {
          throw new Error(
            `migration ${file.version}_${file.name} 已被应用但内容发生变化，拒绝继续`,
          );
        }
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(file.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, content_hash) VALUES ($1, $2, $3)",
          [file.version, file.name, file.contentHash],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(
          `migration ${file.version}_${file.name} 执行失败并已回滚：${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      appliedNow.push({
        version: file.version,
        name: file.name,
        contentHash: file.contentHash,
        appliedAt: new Date(),
      });
    }
    return appliedNow;
  } finally {
    client.release();
    await pool.end();
  }
}

export type MigrationIssueKind = "pending" | "drift" | "extra";

export interface MigrationIssue {
  kind: MigrationIssueKind;
  version: number;
  name: string;
  detail: string;
}

/**
 * 对照本地 migration 文件与数据库已应用记录，报告三类问题：
 * - pending：本地存在但未应用；
 * - drift：已应用但内容哈希与本地文件不一致（文件被修改）；
 * - extra：数据库中已应用但本地不存在对应文件。
 */
export function assessMigrationState(
  files: MigrationFile[],
  applied: AppliedMigration[],
): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const appliedByVersion = new Map<number, AppliedMigration>();
  for (const a of applied) appliedByVersion.set(a.version, a);
  const localVersions = new Set(files.map((f) => f.version));

  for (const file of files) {
    const record = appliedByVersion.get(file.version);
    if (!record) {
      issues.push({
        kind: "pending",
        version: file.version,
        name: file.name,
        detail: "本地存在但尚未应用",
      });
    } else if (record.contentHash !== file.contentHash) {
      issues.push({
        kind: "drift",
        version: file.version,
        name: file.name,
        detail: "已应用但内容哈希与本地文件不一致",
      });
    }
  }

  for (const a of applied) {
    if (!localVersions.has(a.version)) {
      issues.push({
        kind: "extra",
        version: a.version,
        name: a.name,
        detail: "数据库中存在但本地无此 migration",
      });
    }
  }
  return issues;
}

/** 读取已应用的 migration 记录（供 db:migrate:check 使用）。 */
export async function listAppliedMigrations(config: DbConfig): Promise<AppliedMigration[]> {
  const pool = createPool({ ...config, max: 1 });
  const client = await pool.connect();
  try {
    await createStateTable(client);
    const result = await client.query<{
      version: number;
      name: string;
      content_hash: string;
      applied_at: Date;
    }>("SELECT version, name, content_hash, applied_at FROM schema_migrations ORDER BY version");
    return result.rows.map((r) => ({
      version: r.version,
      name: r.name,
      contentHash: r.content_hash,
      appliedAt: r.applied_at,
    }));
  } finally {
    client.release();
    await pool.end();
  }
}

async function createStateTable(client: import("pg").PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(CREATE_STATE_TABLE_SQL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
