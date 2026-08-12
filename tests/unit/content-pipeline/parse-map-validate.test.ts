// 四格式解析与映射纯规则单元测试（阶段 6 工单 02）。
// 覆盖：格式选择/映射规则、JSON 两种允许形状与关键拒绝形状、映射校验、
// 行诊断（非法拼写/重复/已有词条）、stale 判定、安全摘要、字段稳定标识。
import { describe, expect, it } from "vitest";
import {
  formatRequiresMapping,
  formatRequiresSheet,
  MAPPABLE_FORMATS,
  safeValueSummary,
  stableFieldIdentifiers,
  stripBom,
  jsonDepthWithinLimit,
  validateJsonDocument,
  classifySpellingIssues,
  resolveRowDisposition,
  validateFormatMapping,
  mappingEquals,
  classifyStale,
} from "@motro/domain";

describe("格式映射规则", () => {
  it("TXT 无需映射；CSV/XLSX/JSON 需要映射", () => {
    expect(formatRequiresMapping("txt")).toBe(false);
    expect(formatRequiresMapping("csv")).toBe(true);
    expect(formatRequiresMapping("xlsx")).toBe(true);
    expect(formatRequiresMapping("json")).toBe(true);
  });

  it("仅 XLSX 需要工作表选择", () => {
    expect(formatRequiresSheet("xlsx")).toBe(true);
    expect(formatRequiresSheet("csv")).toBe(false);
    expect(formatRequiresSheet("json")).toBe(false);
    expect(formatRequiresSheet("txt")).toBe(false);
  });

  it("MAPPABLE_FORMATS 仅含 csv/xlsx/json", () => {
    expect([...MAPPABLE_FORMATS].sort()).toEqual(["csv", "json", "xlsx"]);
  });
});

describe("安全摘要", () => {
  it("短值原样返回，压缩空白", () => {
    expect(safeValueSummary("abandon", 120)).toBe("abandon");
    expect(safeValueSummary("  apple   banana  ", 120)).toBe("apple banana");
  });

  it("超长值截断并保留省略号", () => {
    const s = safeValueSummary("x".repeat(500), 120);
    expect(s.length).toBe(120);
    expect(s.endsWith("…")).toBe(true);
  });

  it("空值返回空串", () => {
    expect(safeValueSummary("   ", 120)).toBe("");
  });
});

describe("JSON 允许形状", () => {
  it("字符串数组是合法形状", () => {
    const r = validateJsonDocument(["abandon", "ability"], 50000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("string-array");
  });

  it("对象数组（word/note）是合法形状", () => {
    const r = validateJsonDocument(
      [
        { word: "abandon", note: "a" },
        { word: "ability", note: "b" },
      ],
      50000,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("object-array");
  });

  it("顶层对象拒绝", () => {
    expect(validateJsonDocument({ words: [] }, 50000).ok).toBe(false);
  });

  it("混合字符串与对象拒绝", () => {
    expect(validateJsonDocument(["abandon", { word: "a" }], 50000).ok).toBe(false);
  });

  it("null 行拒绝", () => {
    expect(validateJsonDocument(["abandon", null], 50000).ok).toBe(false);
  });

  it("数字元素拒绝", () => {
    expect(validateJsonDocument(["abandon", 42], 50000).ok).toBe(false);
  });

  it("对象数组未知字段拒绝", () => {
    expect(validateJsonDocument([{ word: "a", foo: 1 }], 50000).ok).toBe(false);
  });

  it("对象数组非字符串值拒绝", () => {
    expect(validateJsonDocument([{ word: "a", note: 5 }], 50000).ok).toBe(false);
  });

  it("嵌套对象/深层数组拒绝", () => {
    expect(validateJsonDocument([{ word: "a", nested: [1] }], 50000).ok).toBe(false);
  });

  it("超过行数上限拒绝", () => {
    expect(validateJsonDocument(["a", "b"], 1).ok).toBe(false);
  });
});

describe("JSON 嵌套深度", () => {
  it("常量深度在限内", () => {
    expect(jsonDepthWithinLimit([["a"], ["b"]], 3)).toBe(true);
    expect(jsonDepthWithinLimit([{ word: "a" }], 3)).toBe(true);
  });

  it("过深数组/对象在限外", () => {
    const deep = [[[[["x"]]]]];
    expect(jsonDepthWithinLimit(deep, 3)).toBe(false);
  });

  it("maxDepth 为 0 或负数立即拒绝", () => {
    expect(jsonDepthWithinLimit(["a"], 0)).toBe(false);
    expect(jsonDepthWithinLimit(["a"], -1)).toBe(false);
  });
});

describe("行诊断 / 校验", () => {
  it("空值 → empty", () => {
    expect(classifySpellingIssues("   ", 100)).toEqual(["empty"]);
  });

  it("超长 → over_field_limit", () => {
    expect(classifySpellingIssues("x".repeat(200), 100)).toEqual(["over_field_limit"]);
  });

  it("无英文字母 → invalid_spelling", () => {
    expect(classifySpellingIssues("12345", 100)).toEqual(["invalid_spelling"]);
  });

  it("合法英文词 → 无错误", () => {
    expect(classifySpellingIssues("abandon", 100)).toEqual([]);
  });

  it("含控制字符 → invalid_spelling", () => {
    expect(classifySpellingIssues("ab\u0000andon", 100)).toEqual(["invalid_spelling"]);
  });

  it("resolveRowDisposition 优先级：invalid 压过重复/已有词条", () => {
    expect(resolveRowDisposition({ issues: ["invalid_spelling"], duplicateOfOrdinal: 1 })).toBe(
      "invalid",
    );
  });

  it("duplicate → duplicate_in_file", () => {
    expect(resolveRowDisposition({ issues: [], duplicateOfOrdinal: 3 })).toBe("duplicate_in_file");
  });

  it("existing → existing_entry", () => {
    expect(resolveRowDisposition({ issues: [], matchingEntryId: "id-1" })).toBe("existing_entry");
  });

  it("无问题 → candidate", () => {
    expect(resolveRowDisposition({ issues: [] })).toBe("candidate");
  });
});

describe("映射校验", () => {
  it("TXT 禁止提供字段映射与工作表", () => {
    expect(validateFormatMapping("txt", { spellingField: "x" }).length).toBeGreaterThan(0);
    expect(validateFormatMapping("txt", { sheet: "s" }).length).toBeGreaterThan(0);
    expect(validateFormatMapping("txt", {})).toEqual([]);
  });

  it("XLSX 必须有 sheet 与 spellingField", () => {
    expect(validateFormatMapping("xlsx", { sheet: "S" })).toEqual([
      { code: "spelling_field_required", message: "必须选择英文拼写字段" },
    ]);
    expect(validateFormatMapping("xlsx", { spellingField: "w" })).toEqual([
      { code: "sheet_required", message: "XLSX 必须选择工作表" },
    ]);
    expect(validateFormatMapping("xlsx", { sheet: "S", spellingField: "w" })).toEqual([]);
  });

  it("CSV/JSON 必须 spellingField，禁止 sheet", () => {
    expect(validateFormatMapping("csv", { sheet: "S" }).length).toBeGreaterThan(0);
    expect(validateFormatMapping("csv", { spellingField: "w" })).toEqual([]);
    expect(validateFormatMapping("json", { spellingField: "word" })).toEqual([]);
    expect(validateFormatMapping("json", {}).length).toBeGreaterThan(0);
  });
});

describe("stale / 映射等价", () => {
  it("classifyStale 仅相同版本视为 current", () => {
    expect(classifyStale(2, 2)).toBe("current");
    expect(classifyStale(1, 2)).toBe("stale");
  });

  it("mappingEquals：相同结构相等，不同不等", () => {
    expect(mappingEquals({ spellingField: "w" }, { spellingField: "w" })).toBe(true);
    expect(
      mappingEquals({ spellingField: "w", sheet: "S" }, { spellingField: "w", sheet: "S" }),
    ).toBe(true);
    expect(mappingEquals({ spellingField: "w" }, { spellingField: "w", sheet: "S" })).toBe(false);
    expect(mappingEquals(undefined, undefined)).toBe(true);
    expect(mappingEquals(undefined, { spellingField: "w" })).toBe(false);
  });
});

describe("字段稳定标识", () => {
  it("重名列获得不歧义后缀", () => {
    const ids = stableFieldIdentifiers(["name", "name", "word"]);
    expect(ids).toEqual(["name", "name (2)", "word"]);
  });

  it("空列获得占位", () => {
    const ids = stableFieldIdentifiers(["", "word"]);
    expect(ids[0]).toBe("(第 1 列)");
    expect(ids[1]).toBe("word");
  });
});

describe("stripBom", () => {
  it("去掉 BOM", () => {
    expect(stripBom("﻿apple\n")).toBe("apple\n");
  });

  it("无 BOM 原样返回", () => {
    expect(stripBom("apple\n")).toBe("apple\n");
  });
});
