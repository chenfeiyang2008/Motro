// 学习者课程目录 keyset 游标编解码单测（纯函数，不依赖 DB）。
import { describe, expect, it } from "vitest";
import {
  CATALOG_DEFAULT_LIMIT,
  CATALOG_MAX_LIMIT,
  decodeCatalogCursor,
  encodeCatalogCursor,
} from "../../../../apps/api/src/modules/catalog/courses/course.service.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("cursor 常量", () => {
  it("默认 limit=24，最大 limit=50", () => {
    expect(CATALOG_DEFAULT_LIMIT).toBe(24);
    expect(CATALOG_MAX_LIMIT).toBe(50);
  });
});

describe("encodeCatalogCursor / decodeCatalogCursor", () => {
  it("encode → decode 往返还原排序边界", () => {
    const cur = { releaseNumber: 7, courseId: UUID };
    expect(decodeCatalogCursor(encodeCatalogCursor(cur))).toEqual(cur);
  });

  it("游标按 (release_number DESC, course_id ASC) 翻转语义编码边界", () => {
    const enc = encodeCatalogCursor({ releaseNumber: 7, courseId: UUID });
    // base64url 不含 '=' 或 '/' 或 '+'，可安全作为 query param。
    expect(enc).not.toMatch(/[=+/]/);
    expect(encodeURIComponent(enc)).toBe(enc);
  });

  it("非法 cursor 解码返回 null（不抛、不回退）", () => {
    for (const bad of [
      "",
      "   ",
      "not-base64url!",
      encodeCatalogCursor({ releaseNumber: 7, courseId: UUID }) + "extra",
      "Bogus.prefix." + Buffer.from(JSON.stringify({ r: 1, c: UUID })).toString("base64url"),
      // 结构完整但字段非法
      Buffer.from(`motro.catalog.course.v1.${JSON.stringify({ r: "7", c: UUID })}`).toString(
        "base64url",
      ),
      Buffer.from(`motro.catalog.course.v1.${JSON.stringify({ r: 0, c: UUID })}`).toString(
        "base64url",
      ),
      Buffer.from(`motro.catalog.course.v1.${JSON.stringify({ r: 7, c: "not-a-uuid" })}`).toString(
        "base64url",
      ),
      Buffer.from(`motro.catalog.course.v1.${JSON.stringify({ r: 7 })}`).toString("base64url"),
      Buffer.from(`motro.catalog.course.v1.${JSON.stringify({})}`).toString("base64url"),
    ]) {
      expect(decodeCatalogCursor(bad), `cursor=${bad.slice(0, 24)}…`).toBeNull();
    }
  });

  it("空 cursor 视为无游标（解码 null）", () => {
    expect(decodeCatalogCursor("")).toBeNull();
    expect(decodeCatalogCursor(undefined as unknown as string)).toBeNull();
  });

  it("非法 courseId（UUID 格式错误）解码 null", () => {
    const cur = { releaseNumber: 7, courseId: "not-a-uuid" };
    expect(decodeCatalogCursor(encodeCatalogCursor(cur))).toBeNull();
  });

  it("末页后游标可继续解码（不会因尾部状态破坏）", () => {
    const last = encodeCatalogCursor({ releaseNumber: 1, courseId: UUID });
    expect(decodeCatalogCursor(last)).toEqual({ releaseNumber: 1, courseId: UUID });
  });
});
