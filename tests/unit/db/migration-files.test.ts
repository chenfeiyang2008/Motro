// 纯函数单测：migration 文件发现、排序与内容哈希。无需数据库。
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrationFiles } from "@motro/db";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "motro-migrations-"));
}

describe("loadMigrationFiles", () => {
  it("按版本号升序返回命名 SQL 文件并计算内容哈希", () => {
    const dir = tempDir();
    const sql = "CREATE TABLE t (id uuid);";
    writeFileSync(join(dir, "0002_second.sql"), sql);
    writeFileSync(join(dir, "0001_platform_identity.sql"), sql);
    writeFileSync(join(dir, "README.md"), "not a migration");

    const files = loadMigrationFiles(dir);
    expect(files.map((f) => f.fileName)).toEqual(["0001_platform_identity.sql", "0002_second.sql"]);
    expect(files[0]?.version).toBe(1);
    expect(files[0]?.name).toBe("platform_identity");
    expect(files[0]?.contentHash).toBe(createHash("sha256").update(sql).digest("hex"));
  });

  it("忽略不匹配命名规则的文件与目录条目", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "notes.txt"), "x");
    writeFileSync(join(dir, "meta.md"), "x");
    const files = loadMigrationFiles(dir);
    expect(files).toEqual([]);
  });
});
