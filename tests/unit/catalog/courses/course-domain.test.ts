// 课程领域规则单测：slug、标题、级别、position、排序完整性（纯规则，无数据库）。
import { describe, expect, it } from "vitest";
import {
  normalizeSlug,
  validateCourseDescription,
  validateCourseLevel,
  validateCourseTitle,
  validateItemHint,
  validateItemMeaning,
  validateSlug,
  validateUnitDescription,
  validateUnitOrder,
  validateUnitPosition,
  validateUnitTitle,
} from "@motro/domain";

describe("normalizeSlug", () => {
  it("trim、小写、内部空白折叠为连字符", () => {
    expect(normalizeSlug("  High School  Words ")).toBe("high-school-words");
    expect(normalizeSlug("  A1  ")).toBe("a1");
  });
});

describe("validateSlug", () => {
  it("空 slug 报错", () => {
    expect(validateSlug("   ").join("")).toContain("slug 不能为空");
  });

  it("过短报错", () => {
    expect(validateSlug("a").join("")).toContain("至少");
  });

  it("非法字符报错", () => {
    expect(validateSlug("hi school!").join("")).toContain("只允许小写字母");
    expect(validateSlug("Hi-School").join("")).toContain("只允许小写字母");
  });

  it("首尾连字符报错", () => {
    expect(validateSlug("-abc").join("")).toContain("只允许小写字母");
    expect(validateSlug("abc-").join("")).toContain("只允许小写字母");
  });

  it("合法 slug 通过", () => {
    expect(validateSlug("high-school-words")).toEqual([]);
    expect(validateSlug("a1-basic")).toEqual([]);
  });
});

describe("validateCourseTitle", () => {
  it("空标题报错", () => {
    expect(validateCourseTitle("   ").join("")).toContain("不能为空");
  });

  it("过长报错", () => {
    expect(validateCourseTitle("x".repeat(201)).join("")).toContain("200");
  });

  it("合法标题通过", () => {
    expect(validateCourseTitle(" 高中英语核心词汇 ")).toEqual([]);
  });
});

describe("validateCourseLevel", () => {
  it("合法级别通过", () => {
    expect(validateCourseLevel("b1")).toEqual([]);
  });

  it("非法级别报错", () => {
    expect(validateCourseLevel("z9")).toHaveLength(1);
  });

  it("未提供通过", () => {
    expect(validateCourseLevel(undefined)).toEqual([]);
  });
});

describe("validateCourseDescription", () => {
  it("未提供通过", () => {
    expect(validateCourseDescription(undefined)).toEqual([]);
  });

  it("过长报错", () => {
    expect(validateCourseDescription("x".repeat(2001))).toHaveLength(1);
  });
});

describe("validateUnitTitle / validateUnitDescription", () => {
  it("空单元标题报错", () => {
    expect(validateUnitTitle("  ").join("")).toContain("不能为空");
  });

  it("合法单元标题通过", () => {
    expect(validateUnitTitle("基础词汇")).toEqual([]);
  });

  it("未提供描述通过", () => {
    expect(validateUnitDescription(undefined)).toEqual([]);
  });
});

describe("validateUnitPosition", () => {
  it("非法 position 报错", () => {
    expect(validateUnitPosition(0).join("")).toContain("正整数");
    expect(validateUnitPosition(-1).join("")).toContain("正整数");
    expect(validateUnitPosition(1.5).join("")).toContain("整数");
  });

  it("合法 position 通过", () => {
    expect(validateUnitPosition(1)).toEqual([]);
    expect(validateUnitPosition(7)).toEqual([]);
  });
});

describe("validateUnitOrder", () => {
  const existing = ["u1", "u2", "u3"];

  it("完整排列通过", () => {
    expect(validateUnitOrder(existing, ["u2", "u3", "u1"])).toEqual([]);
    expect(validateUnitOrder(existing, ["u1", "u2", "u3"])).toEqual([]);
  });

  it("缺少单元报错", () => {
    expect(validateUnitOrder(existing, ["u1", "u2"]).join("")).toContain("必须包含全部");
  });

  it("多余单元报错", () => {
    expect(validateUnitOrder(existing, ["u1", "u2", "u3", "u4"]).join("")).toContain(
      "必须包含全部",
    );
  });

  it("重复单元报错", () => {
    expect(validateUnitOrder(existing, ["u1", "u1", "u2"]).join("")).toContain("重复");
  });

  it("不存在的单元报错", () => {
    expect(validateUnitOrder(existing, ["u1", "u2", "zzz"]).join("")).toContain("不存在");
  });

  it("空草稿空顺序通过", () => {
    expect(validateUnitOrder([], [])).toEqual([]);
  });
});

describe("validateItemMeaning / validateItemHint", () => {
  it("空中文释义报错", () => {
    expect(validateItemMeaning("   ").join("")).toContain("不能为空");
  });

  it("过长释义报错", () => {
    expect(validateItemMeaning("x".repeat(501)).join("")).toContain("500");
  });

  it("合法释义通过", () => {
    expect(validateItemMeaning("放弃")).toEqual([]);
  });

  it("未提供提示通过", () => {
    expect(validateItemHint(undefined)).toEqual([]);
  });

  it("过长提示报错", () => {
    expect(validateItemHint("x".repeat(501))).toHaveLength(1);
  });
});
