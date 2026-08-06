// migration 状态检查的纯逻辑单测：pending / drift / extra。
import { describe, expect, it } from "vitest";
import { assessMigrationState, type AppliedMigration, type MigrationFile } from "@motro/db";

function file(version: number, name: string, contentHash: string): MigrationFile {
  return {
    version,
    name,
    fileName: `${String(version).padStart(4, "0")}_${name}.sql`,
    sql: "",
    contentHash,
  };
}

function applied(version: number, name: string, contentHash: string): AppliedMigration {
  return { version, name, contentHash, appliedAt: new Date() };
}

describe("assessMigrationState", () => {
  it("本地文件与数据库记录一致时无问题", () => {
    const files = [file(1, "a", "h1"), file(2, "b", "h2")];
    const appliedList = [applied(1, "a", "h1"), applied(2, "b", "h2")];
    expect(assessMigrationState(files, appliedList)).toEqual([]);
  });

  it("检测待应用（pending）", () => {
    const files = [file(1, "a", "h1"), file(2, "b", "h2")];
    const appliedList = [applied(1, "a", "h1")];
    const issues = assessMigrationState(files, appliedList);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("pending");
    expect(issues[0]?.version).toBe(2);
  });

  it("检测内容哈希漂移（drift）", () => {
    const files = [file(1, "a", "NEW-HASH")];
    const appliedList = [applied(1, "a", "OLD-HASH")];
    const issues = assessMigrationState(files, appliedList);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("drift");
  });

  it("检测数据库中多余但本地不存在的 migration（extra）", () => {
    const files = [file(1, "a", "h1")];
    const appliedList = [applied(1, "a", "h1"), applied(99, "ghost", "h9")];
    const issues = assessMigrationState(files, appliedList);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("extra");
    expect(issues[0]?.version).toBe(99);
  });

  it("混合场景全部报告", () => {
    const files = [file(1, "a", "NEW"), file(3, "c", "h3")];
    const appliedList = [applied(1, "a", "OLD"), applied(2, "b", "h2")];
    const kinds = assessMigrationState(files, appliedList)
      .map((i) => i.kind)
      .sort();
    expect(kinds).toEqual(["drift", "extra", "pending"]);
  });
});
