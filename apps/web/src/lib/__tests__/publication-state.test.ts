// Ticket 08 发布资格展示纯逻辑单测（无 DB、无 React、无网络）。
// 与生产源码 apps/web/src/lib/publication-state.ts 同目录放置，保持单一生产来源。
import { describe, expect, it } from "vitest";
import { categorizeBlockers, groupItemBlockers, isItemBlockPath } from "../publication-state.js";

describe("groupItemBlockers", () => {
  it("只把 item.<id>.<field> 路径聚合到词项，忽略 course/unit 路径", () => {
    const map = groupItemBlockers([
      { code: "A", message: "m1", path: "item.a.meaning" },
      { code: "B", message: "m2", path: "item.a.hint" },
      { code: "C", message: "m3", path: "item.b.meaning" },
      { code: "D", message: "m4", path: "unit.u.title" },
      { code: "E", message: "m5", path: "course.title" },
    ]);
    expect(map.get("a")?.map((r) => r.code)).toEqual(["A", "B"]);
    expect(map.get("b")?.map((r) => r.code)).toEqual(["C"]);
    expect(map.has("u")).toBe(false);
    expect(map.size).toBe(2);
  });

  it("isItemBlockPath 只认三段 item 路径", () => {
    expect(isItemBlockPath("item.a.meaning")).toBe(true);
    expect(isItemBlockPath("item.a")).toBe(false);
    expect(isItemBlockPath("unit.u.title")).toBe(false);
    expect(isItemBlockPath("course.title")).toBe(false);
  });
});

describe("categorizeBlockers — fail-closed 状态归类", () => {
  const reason = (
    code: string,
    itemId: string,
    message = code,
  ): {
    itemId: string;
    reasons: { code: string; message: string; path: string }[];
  } => ({
    itemId,
    reasons: [{ code, message, path: `item.${itemId}.meaning` }],
  });

  it("provenance 类 code 归入 provenanceIncomplete", () => {
    const s = categorizeBlockers(
      [reason("PROVENANCE_INCOMPLETE", "a"), reason("LICENSE_INCOMPLETE", "b")],
      3,
    );
    expect(s.provenanceIncomplete.map((i) => i.id)).toEqual(["a", "b"]);
    expect(s.eligibleCount).toBe(1);
    expect(s.blockedCount).toBe(2);
  });

  it("manual_action / budget / ambiguous 归入 manualActionUnresolved", () => {
    const s = categorizeBlockers(
      [reason("DRAFT_BUDGET_EXCEEDED", "a"), reason("WIKI_AMBIGUOUS", "b")],
      2,
    );
    expect(s.manualActionUnresolved.map((i) => i.id)).toEqual(["a", "b"]);
    expect(s.eligibleCount).toBe(0);
  });

  it("reject 类 code 归入 rejected，永不可发布", () => {
    const s = categorizeBlockers([reason("REVIEW_DECISION_REJECTED", "a")], 1);
    expect(s.rejected.map((i) => i.id)).toEqual(["a"]);
    expect(s.eligibleCount).toBe(0);
  });

  it("其它未知 code 归入 otherBlocked（fail-closed 不误判 eligible）", () => {
    const s = categorizeBlockers([reason("SOME_UNKNOWN", "a")], 2);
    expect(s.otherBlocked.map((i) => i.id)).toEqual(["a"]);
    expect(s.eligibleCount).toBe(1);
  });

  it("无阻断错误 → 全部 eligible", () => {
    const s = categorizeBlockers([], 5);
    expect(s.eligibleCount).toBe(5);
    expect(s.blockedCount).toBe(0);
    for (const k of [
      "provenanceIncomplete",
      "manualActionUnresolved",
      "rejected",
      "otherBlocked",
    ] as const) {
      expect(s[k]).toHaveLength(0);
    }
  });

  it("eligibleCount 不为负", () => {
    const s = categorizeBlockers([reason("REJECT", "a"), reason("REJECT", "b")], 1);
    expect(s.eligibleCount).toBe(0);
  });

  it("真实后端 ITEM_ 码：每种都 fail-closed（绝不误判 eligible）", () => {
    // 与 packages/domain/src/courses/validation/eligibility.ts 的输出码逐一核对。
    const allBackendCodes = [
      "ITEM_COMMIT_ROW_MISMATCH",
      "ITEM_CONFLICTING_DECISION",
      "ITEM_DECISION_NOT_ACCEPTED",
      "ITEM_DRAFT_STATUS_INVALID",
      "ITEM_LEXICAL_ENTRY_MISSING",
      "ITEM_MANUAL_ACTION_UNRESOLVED",
      "ITEM_MANUAL_PROVENANCE_INVALID",
      "ITEM_NORMALIZED_SPELLING_MISMATCH",
      "ITEM_NO_REVIEW_DECISION",
      "ITEM_PROVENANCE_CONTRADICTION",
      "ITEM_PROVENANCE_INCOMPLETE",
      "ITEM_PROVENANCE_KIND_UNKNOWN",
      "ITEM_REJECTED_NOT_PUBLISHABLE",
      "ITEM_REVISION_PAGE_MISMATCH",
      "ITEM_SNAPSHOT_SPELLING_MISMATCH",
      "ITEM_SOURCE_FACT_HASH_MISSING",
      "ITEM_SOURCE_FACT_MISMATCH",
      "ITEM_SOURCE_FACT_NOT_FETCHED",
    ];
    for (const code of allBackendCodes) {
      const s = categorizeBlockers([reason(code, "a")], 1);
      expect(s.eligibleCount, `${code} 必须 fail-closed`).toBe(0);
    }
    // 关键码归入预期桶。
    const manualOnly = categorizeBlockers([reason("ITEM_MANUAL_ACTION_UNRESOLVED", "a")], 1);
    expect(manualOnly.manualActionUnresolved).toHaveLength(1);
    const rejectedOnly = categorizeBlockers([reason("ITEM_REJECTED_NOT_PUBLISHABLE", "a")], 1);
    expect(rejectedOnly.rejected).toHaveLength(1);
    const provOnly = categorizeBlockers([reason("ITEM_PROVENANCE_INCOMPLETE", "a")], 1);
    expect(provOnly.provenanceIncomplete).toHaveLength(1);
  });
});
