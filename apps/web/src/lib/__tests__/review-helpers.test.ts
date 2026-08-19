import { describe, expect, it } from "vitest";
import type { ReviewDraftDetail, ReviewDraftListItem } from "../../../src/lib/api";
import {
  canReviewDraft,
  generateReviewIntentKey,
  manualActionExplanation,
  requiresRealMeaning,
  reviewActionLabel,
  reviewActionSet,
  reviewDecisionLabel,
  reviewStatusBadgeClass,
  reviewStatusLabel,
  truncateSourceUrl,
} from "../../../src/lib/review-helpers";

function draft(overrides: Partial<ReviewDraftListItem> = {}): ReviewDraftListItem {
  return {
    draftId: "aaa-bbb",
    spelling: "abandon",
    status: "draft_ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: {
      sourceName: "wiktionary",
      pageId: "p1",
      revisionId: "r1",
      revisionTimestamp: "2026-01-01T00:00:00.000Z",
      sourceUrl: "https://en.wiktionary.org/wiki/abandon",
      licenseName: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      attribution: "Wiktionary contributors",
    },
    ...overrides,
  };
}

function detail(overrides: Partial<ReviewDraftDetail> = {}): ReviewDraftDetail {
  return {
    draftId: "aaa-bbb",
    spelling: "abandon",
    status: "draft_ready",
    simplifiedChineseMeaning: "放弃",
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewVersion: "v1",
    source: {
      sourceName: "wiktionary",
      pageId: "p1",
      revisionId: "r1",
      revisionTimestamp: "2026-01-01T00:00:00.000Z",
      sourceUrl: "https://en.wiktionary.org/wiki/abandon",
      licenseName: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      attribution: "Wiktionary contributors",
    },
    ...overrides,
  };
}

describe("reviewDecisionLabel", () => {
  it("maps the three decisions to zh labels", () => {
    expect(reviewDecisionLabel("accept")).toBe("接受");
    expect(reviewDecisionLabel("accept_with_edits")).toBe("修改后接受");
    expect(reviewDecisionLabel("reject")).toBe("驳回");
  });

  it("falls back to the raw code for unknown decisions", () => {
    expect(reviewDecisionLabel("something_else")).toBe("something_else");
  });
});

describe("reviewStatusLabel", () => {
  it("maps queue states", () => {
    expect(reviewStatusLabel("draft_ready")).toBe("待审核");
    expect(reviewStatusLabel("manual_action")).toBe("待处理");
    expect(reviewStatusLabel("unknown")).toBe("unknown");
  });
});

describe("reviewStatusBadgeClass", () => {
  it("returns token-backed classes", () => {
    expect(reviewStatusBadgeClass("draft_ready")).toBe("review-badge--pending");
    expect(reviewStatusBadgeClass("manual_action")).toBe("review-badge--manual");
    expect(reviewStatusBadgeClass("x")).toBe("review-badge--unknown");
  });
});

describe("canReviewDraft", () => {
  it("allows review only when the projected status is draft_ready", () => {
    expect(canReviewDraft(draft({ status: "draft_ready" }))).toBe(true);
    expect(canReviewDraft(draft({ status: "manual_action" }))).toBe(false);
    expect(canReviewDraft(draft({ status: "rejected" }))).toBe(false);
  });
});

describe("reviewActionLabel", () => {
  it("maps all three action types", () => {
    expect(reviewActionLabel("accept")).toBe("接受");
    expect(reviewActionLabel("accept_with_edits")).toBe("修改后接受");
    expect(reviewActionLabel("reject")).toBe("驳回");
  });
});

describe("generateReviewIntentKey", () => {
  it("produces a non-empty, unique string", () => {
    const a = generateReviewIntentKey();
    const b = generateReviewIntentKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe("manualActionExplanation", () => {
  it("explains known resolvable codes and falls back safely", () => {
    expect(manualActionExplanation("DRAFT_BUDGET_EXCEEDED")).toContain("每日生成预算");
    expect(manualActionExplanation("WIKI_AMBIGUOUS")).toContain("多个候选");
    expect(manualActionExplanation("SOME_OTHER")).toContain("SOME_OTHER");
    expect(manualActionExplanation(null)).toBe("需要人工处理");
  });
});

describe("truncateSourceUrl", () => {
  it("shortens long URLs while keeping the host prefix", () => {
    const url = "https://en.wiktionary.org/wiki/a_very_long_word_that_is_truncated_more";
    const short = truncateSourceUrl(url, 40);
    expect(short.length).toBeLessThanOrEqual(40);
    expect(short).toContain("en.wiktionary.org");
    expect(short.endsWith("…")).toBe(true);
  });

  it("leaves short URLs unchanged", () => {
    const url = "https://en.wiktionary.org";
    expect(truncateSourceUrl(url, 48)).toBe(url);
  });
});

describe("requiresRealMeaning", () => {
  it("returns true when the meaning is empty (manual_action needing real content)", () => {
    expect(requiresRealMeaning(detail({ simplifiedChineseMeaning: "" }))).toBe(true);
    expect(requiresRealMeaning(detail({ simplifiedChineseMeaning: "   " }))).toBe(true);
  });

  it("returns false when the meaning is present (plain draft_ready)", () => {
    expect(requiresRealMeaning(detail({ simplifiedChineseMeaning: "放弃" }))).toBe(false);
    expect(requiresRealMeaning(detail({ simplifiedChineseMeaning: "  to abandon  " }))).toBe(false);
  });
});

describe("reviewActionSet", () => {
  it("allows plain accept when a real meaning is present", () => {
    const actions = reviewActionSet(detail({ simplifiedChineseMeaning: "放弃" }));
    expect(actions.canAccept).toBe(true);
    expect(actions.canAcceptWithEdits).toBe(true);
    expect(actions.canReject).toBe(true);
    expect(actions.forceMeaning).toBe(false);
  });

  it("forces accept_with_edits and disables plain accept when meaning is empty", () => {
    const actions = reviewActionSet(detail({ simplifiedChineseMeaning: "" }));
    expect(actions.canAccept).toBe(false);
    expect(actions.canAcceptWithEdits).toBe(true);
    expect(actions.canReject).toBe(true);
    expect(actions.forceMeaning).toBe(true);
  });

  it("always allows reject even when meaning is missing", () => {
    const actions = reviewActionSet(detail({ simplifiedChineseMeaning: "" }));
    expect(actions.canReject).toBe(true);
  });
});
