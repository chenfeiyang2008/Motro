// 词条重复判定（纯领域规则）：完全重复冲突、同形异义警告、显式确认放行。
// evaluateDuplicates 只接收“同规范化拼写”下的候选；调用方按 normalized_spelling 预过滤。
import { describe, expect, it } from "vitest";
import { evaluateDuplicates } from "@motro/domain";

const CANDIDATES = [
  { id: "e1", canonicalSpelling: "abandon", normalizedSpelling: "abandon" },
  { id: "e2", canonicalSpelling: "Abandon", normalizedSpelling: "abandon" },
  { id: "e3", canonicalSpelling: "lead", normalizedSpelling: "lead" },
];

describe("evaluateDuplicates", () => {
  it("无候选时直接创建", () => {
    expect(
      evaluateDuplicates({ canonicalSpelling: "cat", existing: [], confirmDuplicate: false }),
    ).toEqual({ kind: "create" });
  });

  it("完全相同展示拼写已存在 → 冲突，即使已确认也不放行", () => {
    const verdict = evaluateDuplicates({
      canonicalSpelling: "abandon",
      existing: CANDIDATES,
      confirmDuplicate: true,
    });
    expect(verdict.kind).toBe("duplicate_exact");
    if (verdict.kind === "duplicate_exact") {
      expect(verdict.candidate.id).toBe("e1");
    }
  });

  it("同规范化拼写、不同展示拼写且未确认 → 返回重复警告与全部候选", () => {
    const verdict = evaluateDuplicates({
      canonicalSpelling: "ABANDON",
      existing: [CANDIDATES[0]!, CANDIDATES[1]!],
      confirmDuplicate: false,
    });
    expect(verdict.kind).toBe("duplicate_warning");
    if (verdict.kind === "duplicate_warning") {
      expect(verdict.candidates.map((c) => c.id)).toEqual(["e1", "e2"]);
    }
  });

  it("同规范化拼写、不同展示拼写且显式确认 → 允许创建新词条", () => {
    expect(
      evaluateDuplicates({
        canonicalSpelling: "ABANDON",
        existing: CANDIDATES,
        confirmDuplicate: true,
      }),
    ).toEqual({ kind: "create" });
  });

  it("不同展示拼写可区分同形异义词条：大写变体不与原词条冲突", () => {
    // “Lead” 是 “lead” 的候选（规范化相同、展示不同），但不会命中完全相同冲突。
    const verdict = evaluateDuplicates({
      canonicalSpelling: "Lead",
      existing: [{ id: "e3", canonicalSpelling: "lead", normalizedSpelling: "lead" }],
      confirmDuplicate: false,
    });
    expect(verdict.kind).toBe("duplicate_warning");
  });
});
