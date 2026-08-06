// 课程 schema/migration 一致性守卫：
// 「一门课程至多一个 active draft」是部分唯一索引，只能在显式 SQL migration 表达；
// Drizzle schema 不得声明对 course_id 的普通唯一索引（会错误阻止 archived 草稿）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const migration = readFileSync(
  resolve(ROOT, "db/migrations/0005_course_drafts_and_units.sql"),
  "utf8",
);
const schema = readFileSync(resolve(ROOT, "packages/db/src/schema/courses.ts"), "utf8");

describe("course draft unique-constraint 一致性", () => {
  it("migration 用部分唯一索引约束 active draft（不阻止 archived）", () => {
    expect(migration).toContain("course_drafts_one_active_per_course_unique");
    // `.` 不跨行，用 [\s\S] 跨行匹配 CREATE UNIQUE INDEX 与其后的部分谓词。
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX course_drafts_one_active_per_course_unique[\s\S]*?ON course_drafts \(course_id\) WHERE status = 'active'/,
    );
    // 不允许退回成对 course_id 的普通唯一约束（无 WHERE 谓词）。
    expect(migration).not.toMatch(/ON course_drafts \(course_id\);/);
  });

  it("Drizzle schema 不声明 course_id 的普通唯一索引，并注释说明部分索引在 SQL", () => {
    expect(schema).not.toContain('uniqueIndex("course_drafts_one_active_per_course_unique")');
    expect(schema).toContain("course_id) WHERE status = 'active'");
    expect(schema).toContain("不");
    expect(schema).toContain("archived");
  });
});
