// 课程草稿校验纯函数单测：阻断规则、警告、initial/changed diff、内容哈希。
import { describe, expect, it } from "vitest";
import {
  computeContentHash,
  validateCourseDraft,
  type ItemSnapshot,
  type UnitSnapshot,
} from "@motro/domain";

function validItem(overrides: Partial<ItemSnapshot> = {}): ItemSnapshot {
  return {
    id: "item-1",
    position: 1,
    meaning: "放弃",
    hint: null,
    lexicalEntryId: "entry-1",
    lexicalEntryExists: true,
    contentReviewReference: "audit-1",
    contentReviewValid: true,
    ...overrides,
  };
}

function validUnit(overrides: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return {
    id: "unit-1",
    position: 1,
    title: "基础词汇",
    description: "基础词汇单元",
    items: [validItem()],
    ...overrides,
  };
}

function validInput() {
  return { draftVersion: 3, title: "高中英语核心词汇", units: [validUnit()] };
}

function blockingCodes(input: ReturnType<typeof validInput>): string[] {
  return validateCourseDraft(input).blockingErrors.map((e) => e.code);
}

describe("validateCourseDraft 阻断规则", () => {
  it("空课程标题 → COURSE_TITLE_EMPTY", () => {
    expect(blockingCodes({ ...validInput(), title: "  " })).toContain("COURSE_TITLE_EMPTY");
  });

  it("无单元 → COURSE_NO_UNITS", () => {
    expect(blockingCodes({ ...validInput(), units: [] })).toContain("COURSE_NO_UNITS");
  });

  it("空单元（无词项）→ UNIT_NO_ITEMS", () => {
    const input = validInput();
    input.units[0]!.items = [];
    expect(blockingCodes(input)).toContain("UNIT_NO_ITEMS");
  });

  it("空中文释义 → ITEM_MEANING_EMPTY，path 定位到 item id", () => {
    const input = validInput();
    input.units[0]!.items = [validItem({ meaning: "  " })];
    const result = validateCourseDraft(input);
    const issue = result.blockingErrors.find((e) => e.code === "ITEM_MEANING_EMPTY");
    expect(issue?.path).toBe("item.item-1.meaning");
  });

  it("悬空词条引用 → ITEM_LEXICAL_ENTRY_MISSING", () => {
    const input = validInput();
    input.units[0]!.items = [validItem({ lexicalEntryExists: false })];
    expect(blockingCodes(input)).toContain("ITEM_LEXICAL_ENTRY_MISSING");
  });

  it("无效手工内容依据 → ITEM_CONTENT_REVIEW_INVALID", () => {
    const input = validInput();
    input.units[0]!.items = [validItem({ contentReviewValid: false })];
    expect(blockingCodes(input)).toContain("ITEM_CONTENT_REVIEW_INVALID");
  });

  it("单元顺序不连续 → UNIT_ORDER_INVALID", () => {
    const input = validInput();
    input.units = [validUnit({ id: "u1", position: 1 }), validUnit({ id: "u2", position: 3 })];
    expect(blockingCodes(input)).toContain("UNIT_ORDER_INVALID");
  });

  it("词项顺序不连续 → ITEM_ORDER_INVALID，path 定位到单元", () => {
    const input = validInput();
    input.units[0]!.items = [
      validItem({ id: "i1", position: 1 }),
      validItem({ id: "i2", position: 3 }),
    ];
    const result = validateCourseDraft(input);
    const issue = result.blockingErrors.find((e) => e.code === "ITEM_ORDER_INVALID");
    expect(issue?.path).toBe("unit.unit-1.items");
  });

  it("合法草稿可发布且无阻断错误", () => {
    const result = validateCourseDraft(validInput());
    expect(result.isPublishable).toBe(true);
    expect(result.blockingErrors).toEqual([]);
  });
});

describe("警告与 blocking 区分", () => {
  it("单元缺少描述 → 警告 UNIT_DESCRIPTION_EMPTY，不影响可发布", () => {
    const input = validInput();
    input.units[0]!.description = "  ";
    const result = validateCourseDraft(input);
    expect(result.warnings.map((w) => w.code)).toContain("UNIT_DESCRIPTION_EMPTY");
    expect(result.warnings.every((w) => w.severity === "warning")).toBe(true);
    expect(result.isPublishable).toBe(true);
  });

  it("同时有 blocking 和 warning 时，warning 不绕过 blocking", () => {
    const input = validInput();
    input.units[0]!.description = "  "; // warning
    input.units[0]!.items = []; // blocking UNIT_NO_ITEMS
    const result = validateCourseDraft(input);
    expect(result.blockingErrors.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.isPublishable).toBe(false);
  });
});

describe("差异摘要与内容哈希", () => {
  it("无 current release → initial 差异，added 为全部数量", () => {
    const result = validateCourseDraft(validInput());
    expect(result.diffSummary.kind).toBe("initial");
    expect(result.diffSummary.totalUnits).toBe(1);
    expect(result.diffSummary.totalItems).toBe(1);
    expect(result.diffSummary.addedUnits).toBe(1);
    expect(result.diffSummary.addedItems).toBe(1);
  });

  it("有 current release 且内容变化 → changed 差异 + 内容数量警告", () => {
    const result = validateCourseDraft({
      ...validInput(),
      currentRelease: { unitCount: 1, itemCount: 3 },
    });
    expect(result.diffSummary.kind).toBe("changed");
    expect(result.diffSummary.removedItems).toBe(2);
    expect(result.warnings.map((w) => w.code)).toContain("CONTENT_COUNT_CHANGED");
  });

  it("内容哈希随 draftVersion/内容变化，不包含解析标志", () => {
    const a = computeContentHash(validInput());
    const b = computeContentHash({ ...validInput(), draftVersion: 4 });
    const c = computeContentHash({
      ...validInput(),
      units: [validUnit({ items: [validItem({ lexicalEntryExists: false })] })],
    });
    expect(a).not.toBe(b);
    // 词条存在性（解析标志）不影响内容哈希；含义/拼写等事实影响。
    expect(a).toBe(c);
    const d = computeContentHash({
      ...validInput(),
      units: [validUnit({ items: [validItem({ meaning: "别的释义" })] })],
    });
    expect(a).not.toBe(d);
  });
});
