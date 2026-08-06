// 拼写规范化与输入校验（纯领域规则，无数据库）。
import { describe, expect, it } from "vitest";
import {
  normalizeSpelling,
  validateCanonicalSpelling,
  validatePartOfSpeech,
  validatePronunciation,
  validateSenses,
  validateSourceNote,
} from "@motro/domain";

describe("normalizeSpelling", () => {
  it("外层 trim", () => {
    expect(normalizeSpelling("  abandon  ")).toBe("abandon");
  });

  it("压缩内部空白", () => {
    expect(normalizeSpelling("ice   cream")).toBe("ice cream");
  });

  it("Unicode NFKC（全角字母）与大小写", () => {
    expect(normalizeSpelling("ＡＢＣ")).toBe("abc");
    expect(normalizeSpelling("Abandon")).toBe("abandon");
  });
});

describe("validateCanonicalSpelling", () => {
  it("空拼写报错", () => {
    expect(validateCanonicalSpelling("   ")).toContain("拼写不能为空");
  });

  it("不含英文字母报错", () => {
    expect(validateCanonicalSpelling("123").join("")).toContain("英文字母");
  });

  it("超过长度上限报错", () => {
    expect(validateCanonicalSpelling("a".repeat(129)).join("")).toContain("128");
  });

  it("控制字符报错", () => {
    expect(validateCanonicalSpelling("ab\u0000cd").join("")).toContain("控制字符");
  });

  it("合法拼写通过", () => {
    expect(validateCanonicalSpelling(" abandon ")).toEqual([]);
  });
});

describe("validatePartOfSpeech", () => {
  it("合法词性通过", () => {
    expect(validatePartOfSpeech("verb")).toEqual([]);
  });

  it("未知词性报错", () => {
    expect(validatePartOfSpeech("unknown")).toHaveLength(1);
  });

  it("空/未提供通过", () => {
    expect(validatePartOfSpeech(undefined)).toEqual([]);
    expect(validatePartOfSpeech("  ")).toEqual([]);
  });
});

describe("validatePronunciation", () => {
  it("空/未提供通过", () => {
    expect(validatePronunciation(undefined)).toEqual([]);
  });

  it("过长报错", () => {
    expect(validatePronunciation("x".repeat(101))).toHaveLength(1);
  });
});

describe("validateSenses", () => {
  it("未提供通过", () => {
    expect(validateSenses(undefined)).toEqual([]);
  });

  it("空释义报错并定位条目", () => {
    expect(validateSenses([{ meaning: "  " }])).toContain("第 1 条释义不能为空");
  });

  it("超过 20 条报错", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ meaning: `释义 ${i}` }));
    expect(validateSenses(many)).toContain("释义最多 20 条");
  });

  it("释义过长报错", () => {
    expect(validateSenses([{ meaning: "m".repeat(501) }])).toContain("第 1 条释义过长");
  });
});

describe("validateSourceNote", () => {
  it("空/未提供通过", () => {
    expect(validateSourceNote(undefined)).toEqual([]);
  });

  it("过长报错", () => {
    expect(validateSourceNote("x".repeat(501))).toHaveLength(1);
  });
});
