// 导入文件纯规则单元测试（阶段 6 工单 01）：格式、文件名、大小、存储键、SHA-256。
import { describe, expect, it } from "vitest";
import {
  ALLOWED_MEDIA_TYPES,
  contentClassAllowedForExtension,
  declaredMimeConsistent,
  extensionOf,
  formatFromSniffedMime,
  generateStorageKey,
  isAllowedMediaType,
  normalizeMediaType,
  sniffFileContent,
  UPLOADABLE_FORMATS,
  validateImportFilename,
  validateImportSize,
  validateSha256Hex,
  validateStorageKey,
} from "@motro/domain";

describe("import file rules", () => {
  describe("validateImportFilename（格式 + 路径穿越）", () => {
    it("接受合法扩展名（不区分大小写）", () => {
      expect(validateImportFilename("words.txt").ok).toBe(true);
      expect(validateImportFilename("words.csv").ok).toBe(true);
      expect(validateImportFilename("words.JSON").ok).toBe(true);
      expect(validateImportFilename("words.txt").format).toBe("txt");
    });

    it("拒绝路径穿越：斜杠、反斜杠、绝对路径", () => {
      expect(validateImportFilename("../words.txt").ok).toBe(false);
      expect(validateImportFilename("..\\words.txt").ok).toBe(false);
      expect(validateImportFilename("/etc/passwd.txt").ok).toBe(false);
      expect(validateImportFilename("C:\\evil.txt").ok).toBe(false);
    });

    it("拒绝隐藏文件（前导点）与控制字符", () => {
      expect(validateImportFilename(".secret.txt").ok).toBe(false);
      expect(validateImportFilename("bad\u0000name.txt").ok).toBe(false);
      expect(validateImportFilename("line\rbreak.txt").ok).toBe(false);
    });

    it("拒绝空名、无扩展名、不支持格式", () => {
      expect(validateImportFilename("   ").ok).toBe(false);
      expect(validateImportFilename("nowords").ok).toBe(false);
      expect(validateImportFilename("words.exe").ok).toBe(false);
      expect(validateImportFilename("words.xlsx").ok).toBe(true); // xlsx 现已支持
    });
  });

  describe("validateImportSize", () => {
    it("拒绝空文件与非正数", () => {
      expect(validateImportSize(0, 1000).join(" ")).toContain("不能为空");
      expect(validateImportSize(-1, 1000).join(" ")).toContain("不能为空");
      expect(validateImportSize(2.5, 1000).join(" ")).toContain("不能为空");
    });

    it("拒绝超限", () => {
      expect(validateImportSize(1001, 1000).join(" ")).toContain("不能超过 1000 字节");
    });

    it("边界：恰好等于上限是允许的，等于 1 字节是允许的", () => {
      expect(validateImportSize(1000, 1000)).toEqual([]);
      expect(validateImportSize(1, 1000)).toEqual([]);
    });
  });

  describe("generateStorageKey / validateStorageKey", () => {
    it("生成不透明、带 purpose 前缀、无路径分隔符的键", () => {
      const k = generateStorageKey("import");
      expect(k).toMatch(/^import-[A-Za-z0-9_-]+$/);
      expect(k.length).toBeGreaterThan("import-".length);
      expect(validateStorageKey(k)).toEqual([]);
    });

    it("两次生成不同（随机性）", () => {
      expect(generateStorageKey("import")).not.toBe(generateStorageKey("import"));
    });

    it("拒绝含路径分隔符或非法字符的存储键", () => {
      expect(validateStorageKey("a/b").join(" ")).toContain("路径分隔符");
      expect(validateStorageKey("a\\b")).not.toEqual([]);
    });
  });

  describe("validateSha256Hex", () => {
    it("接受 64 位小写十六进制", () => {
      expect(validateSha256Hex("a".repeat(64))).toEqual([]);
    });

    it("拒绝长度错误或大写", () => {
      expect(validateSha256Hex("abc")).not.toEqual([]);
      expect(validateSha256Hex("a".repeat(63))).not.toEqual([]);
      expect(validateSha256Hex("A".repeat(64))).not.toEqual([]);
    });
  });

  describe("extensionOf", () => {
    it("提取小写扩展名", () => {
      expect(extensionOf("WORDS.TXT")).toBe("txt");
      expect(extensionOf("words.csv")).toBe("csv");
    });

    it("无扩展名 / 以点结尾 / 空串返回 undefined", () => {
      expect(extensionOf("words")).toBeUndefined();
      expect(extensionOf("words.")).toBeUndefined();
      expect(extensionOf("")).toBeUndefined();
    });
  });

  describe("formatFromSniffedMime", () => {
    it("由嗅探 MIME 推断格式", () => {
      expect(formatFromSniffedMime("text/plain")).toBe("txt");
      expect(formatFromSniffedMime("text/csv")).toBe("csv");
      expect(formatFromSniffedMime("application/json")).toBe("json");
      expect(formatFromSniffedMime("text/html")).toBe("txt"); // text/* 回退
    });

    it("未知 MIME 返回 undefined", () => {
      expect(formatFromSniffedMime("application/octet-stream")).toBeUndefined();
    });
  });

  it("UPLOADABLE_FORMATS 包含 txt/csv/json/xlsx", () => {
    expect(UPLOADABLE_FORMATS).toEqual(["txt", "csv", "json", "xlsx"]);
  });

  describe("sniffFileContent（内容类别）", () => {
    it("合法 UTF-8 文本 → utf8（TXT/CSV 均可）", () => {
      const r = sniffFileContent(Buffer.from("apple\nbanana\ncherry\n"));
      expect(r.ok).toBe(true);
      expect(r.ok && r.result.content).toBe("utf8");
      expect(r.ok && r.result.sniffedMime).toBe("text/plain");
    });

    it("合法 JSON → json", () => {
      const r = sniffFileContent(Buffer.from('{"words":["apple","banana"]}\n'));
      expect(r.ok).toBe(true);
      expect(r.ok && r.result.content).toBe("json");
      expect(r.ok && r.result.sniffedMime).toBe("application/json");
    });

    it("ZIP 归档（PK\x03\x04）→ xlsx", () => {
      const r = sniffFileContent(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x89, 0x50, 0x4e]));
      expect(r.ok).toBe(true);
      expect(r.ok && r.result.content).toBe("xlsx");
      expect(r.ok && r.result.sniffedMime).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    });

    it("其它二进制/非 UTF-8 非 ZIP → 拒绝", () => {
      const r = sniffFileContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
      expect(r.ok).toBe(false);
    });

    it("空文件 → 拒绝", () => {
      const r = sniffFileContent(Buffer.from(""));
      expect(r.ok).toBe(false);
    });
  });

  describe("contentClassAllowedForExtension（TXT/CSV/JSON/XLSX 不误判）", () => {
    it("utf8 内容允许 txt 与 csv；不允许 json/xlsx", () => {
      expect(contentClassAllowedForExtension("utf8", "txt")).toBe(true);
      expect(contentClassAllowedForExtension("utf8", "csv")).toBe(true);
      expect(contentClassAllowedForExtension("utf8", "json")).toBe(false);
      expect(contentClassAllowedForExtension("utf8", "xlsx")).toBe(false);
    });
    it("json 内容仅允许 json", () => {
      expect(contentClassAllowedForExtension("json", "json")).toBe(true);
      expect(contentClassAllowedForExtension("json", "txt")).toBe(false);
      expect(contentClassAllowedForExtension("json", "csv")).toBe(false);
      expect(contentClassAllowedForExtension("json", "xlsx")).toBe(false);
    });
    it("xlsx 内容允许 xlsx；不允许 txt/csv/json", () => {
      expect(contentClassAllowedForExtension("xlsx", "xlsx")).toBe(true);
      expect(contentClassAllowedForExtension("xlsx", "txt")).toBe(false);
      expect(contentClassAllowedForExtension("xlsx", "csv")).toBe(false);
      expect(contentClassAllowedForExtension("xlsx", "json")).toBe(false);
    });
  });

  describe("declaredMimeConsistent", () => {
    it("text/plain 与 text/csv 接受文本内容", () => {
      expect(declaredMimeConsistent("text/plain", "text/plain")).toBe(true);
      expect(declaredMimeConsistent("text/csv", "text/plain")).toBe(true);
    });
    it("application/json 只接受 json", () => {
      expect(declaredMimeConsistent("application/json", "application/json")).toBe(true);
      expect(declaredMimeConsistent("application/json", "text/plain")).toBe(false);
    });
    it("二进制/图片/octet-stream 声明拒绝文本内容", () => {
      expect(declaredMimeConsistent("image/png", "text/plain")).toBe(false);
      expect(declaredMimeConsistent("application/octet-stream", "text/plain")).toBe(false);
      expect(declaredMimeConsistent("application/pdf", "text/plain")).toBe(false);
    });
    it("空/空白/无法解析 MIME 一律拒绝（P2-2）", () => {
      expect(declaredMimeConsistent("", "text/plain")).toBe(false);
      expect(declaredMimeConsistent("   ", "text/plain")).toBe(false);
      expect(declaredMimeConsistent("; charset=utf-8", "text/plain")).toBe(false);
    });
  });

  describe("MIME 严格白名单（P1-6）", () => {
    it("ALLOWED_MEDIA_TYPES 只含 text/plain / text/csv / application/json / xlsx MIME", () => {
      expect([...ALLOWED_MEDIA_TYPES].sort()).toEqual(
        [
          "text/plain",
          "text/csv",
          "application/json",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ].sort(),
      );
    });

    it("normalizeMediaType 剥离参数并小写/trim", () => {
      expect(normalizeMediaType("  text/plain; charset=utf-8  ")).toBe("text/plain");
      expect(normalizeMediaType("text/csv; charset=utf-8")).toBe("text/csv");
      expect(normalizeMediaType("Application/JSON; charset=UTF-8")).toBe("application/json");
      expect(
        normalizeMediaType(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=binary",
        ),
      ).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      expect(normalizeMediaType(" text/plain ")).toBe("text/plain");
    });

    it("isAllowedMediaType 接受白名单（含参数），拒绝其它", () => {
      expect(isAllowedMediaType("text/plain")).toBe(true);
      expect(isAllowedMediaType("text/plain; charset=utf-8")).toBe(true);
      expect(isAllowedMediaType("text/csv; charset=utf-8")).toBe(true);
      expect(isAllowedMediaType("application/json; charset=utf-8")).toBe(true);
      expect(
        isAllowedMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      ).toBe(true);
      expect(isAllowedMediaType("text/html")).toBe(false);
      expect(isAllowedMediaType("text/javascript")).toBe(false);
      expect(isAllowedMediaType("image/png")).toBe(false);
      expect(isAllowedMediaType("application/pdf")).toBe(false);
      expect(isAllowedMediaType("application/octet-stream")).toBe(false);
      expect(isAllowedMediaType("application/vnd.ms-excel")).toBe(false);
      expect(isAllowedMediaType("application/vnd.ms-excel.sheet.macroEnabled.12")).toBe(false);
      // P2-2：空/空白/无法解析一律拒绝。
      expect(isAllowedMediaType("")).toBe(false);
      expect(isAllowedMediaType("   ")).toBe(false);
      expect(isAllowedMediaType("; charset=utf-8")).toBe(false);
    });

    it("declaredMimeConsistent：text/html、text/javascript 拒绝文本内容", () => {
      expect(declaredMimeConsistent("text/html", "text/plain")).toBe(false);
      expect(declaredMimeConsistent("text/javascript", "text/plain")).toBe(false);
    });

    it("MIME 与内容类别必须匹配", () => {
      expect(declaredMimeConsistent("application/json", "text/plain")).toBe(false);
      expect(declaredMimeConsistent("text/plain", "application/json")).toBe(false);
      expect(declaredMimeConsistent("text/csv", "text/plain")).toBe(true);
      // XLSX MIME 仅与 xlsx 内容一致；不得伪装成文本/JSON。
      expect(
        declaredMimeConsistent(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
      ).toBe(true);
      expect(
        declaredMimeConsistent(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "text/plain",
        ),
      ).toBe(false);
      expect(
        declaredMimeConsistent(
          "text/plain",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
      ).toBe(false);
    });
  });
});
