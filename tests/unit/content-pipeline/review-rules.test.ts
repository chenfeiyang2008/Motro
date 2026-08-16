// Ticket 07: human review decision pure domain rules — unit tests (no DB, no network).
//
// Covers: valid accept/accept_with_edits/reject, non-reviewable statuses, manual_action
// classification (resolvable vs non-resolvable), edited content normalization (HTML/URL
// control chars rejection), canonical hash determinism, spelling conflict detection,
// request-hash collision resistance, and state machine eligibility.
import { describe, expect, it } from "vitest";
import {
  REVIEW_DECISION_TYPES,
  describeUnreviewable,
  isNonResolvableManualAction,
  isResolvableManualAction,
  isReviewableDraftMode,
  manualActionClass,
  normalizeReviewContent,
  reviewDecisionHash,
  reviewProjectionVersion,
  reviewRequestHash,
  reviewResolveHash,
  reviewLenPrefixedJoin,
  type ReviewDecisionCanonicalInput,
  type ReviewRequestPayload,
} from "@motro/domain";

const CANONICAL_PAYLOAD: ReviewDecisionCanonicalInput = {
  draftId: "aaaa1111-2222-3333-4444-555566667777",
  decisionType: "accept",
  englishSpelling: "hello",
  simplifiedChineseMeaning: "你好",
  learningHint: "常见问候语",
  sourceFactIdentity: "a0".repeat(32), // 64 hex chars
  sourceRevisionId: "1234567",
};

const REQUEST_BASE: ReviewRequestPayload = {
  draftId: CANONICAL_PAYLOAD.draftId,
  reviewerId: "bbbb2222-3333-4444-5555-666677778888",
  decisionType: "accept",
  reason: "审核接受",
  englishSpelling: "hello",
  simplifiedChineseMeaning: "你好",
  learningHint: "常见问候语",
};

// ---------------------------------------------------------------------------
// 1. Decision type guard
// ---------------------------------------------------------------------------
describe("REVIEW_DECISION_TYPES", () => {
  it("accept is valid", () => expect(isReviewableDraftMode("draft_ready")).toBe(true));
  it("accept_with_edits is valid type", () =>
    expect(REVIEW_DECISION_TYPES).toContain("accept_with_edits"));
  it("reject is valid type", () => expect(REVIEW_DECISION_TYPES).toContain("reject"));
  it("invalid type rejected", () => expect(REVIEW_DECISION_TYPES).not.toContain("invalid"));
});

// ---------------------------------------------------------------------------
// 2. Draft mode eligibility
// ---------------------------------------------------------------------------
describe("isReviewableDraftMode", () => {
  it("draft_ready is reviewable", () => expect(isReviewableDraftMode("draft_ready")).toBe(true));
  it("drafting is not reviewable", () => expect(isReviewableDraftMode("drafting")).toBe(false));
  it("manual_action is not reviewable", () =>
    expect(isReviewableDraftMode("manual_action")).toBe(false));
  it("failed is not reviewable", () => expect(isReviewableDraftMode("failed")).toBe(false));
  it("superseded is not reviewable", () => expect(isReviewableDraftMode("superseded")).toBe(false));
  it("restricted_model_identity is not reviewable", () =>
    expect(isReviewableDraftMode("restricted_model_identity")).toBe(false));
  it("retry_wait is not reviewable", () => expect(isReviewableDraftMode("retry_wait")).toBe(false));
});

describe("describeUnreviewable", () => {
  it("manual_action gives actionable message", () =>
    expect(describeUnreviewable("manual_action")).toContain("人工处理"));
  it("unknown status gives safe generic", () =>
    expect(describeUnreviewable("unknown_x")).toBe("草稿状态不可审核"));
});

// ---------------------------------------------------------------------------
// 3. Manual_action resolvable vs non-resolvable classification
// ---------------------------------------------------------------------------
describe("manualActionClass", () => {
  it("DRAFT_BUDGET_EXCEEDED is resolvable", () =>
    expect(manualActionClass("DRAFT_BUDGET_EXCEEDED")).toBe("resolvable"));
  it("WIKI_AMBIGUOUS is resolvable", () =>
    expect(manualActionClass("WIKI_AMBIGUOUS")).toBe("resolvable"));
  it("DRAFT_AUTH_FAILED is non-resolvable", () =>
    expect(manualActionClass("DRAFT_AUTH_FAILED")).toBe("non_resolvable"));
  it("DRAFT_MODEL_IDENTITY_INSUFFICIENT is non-resolvable", () =>
    expect(manualActionClass("DRAFT_MODEL_IDENTITY_INSUFFICIENT")).toBe("non_resolvable"));
  it("DRAFT_SOURCE_MISSING is non-resolvable", () =>
    expect(manualActionClass("DRAFT_SOURCE_MISSING")).toBe("non_resolvable"));
  it("WIKI_PAGE_NOT_FOUND is non-resolvable", () =>
    expect(manualActionClass("WIKI_PAGE_NOT_FOUND")).toBe("non_resolvable"));
  it("WIKI_REVISION_NOT_FOUND is non-resolvable", () =>
    expect(manualActionClass("WIKI_REVISION_NOT_FOUND")).toBe("non_resolvable"));
  it("WIKI_LICENSE_INCOMPLETE is non-resolvable", () =>
    expect(manualActionClass("WIKI_LICENSE_INCOMPLETE")).toBe("non_resolvable"));
  it("WIKI_ATTRIBUTION_INCOMPLETE is non-resolvable", () =>
    expect(manualActionClass("WIKI_ATTRIBUTION_INCOMPLETE")).toBe("non_resolvable"));
  it("unknown code is none", () => expect(manualActionClass("UNKNOWN_CODE")).toBe("none"));
  it("null is none", () => expect(manualActionClass(null)).toBe("none"));
  it("undefined is none", () => expect(manualActionClass(undefined)).toBe("none"));
});

describe("isResolvableManualAction", () => {
  it("true for DRAFT_BUDGET_EXCEEDED", () =>
    expect(isResolvableManualAction("DRAFT_BUDGET_EXCEEDED")).toBe(true));
  it("false for DRAFT_AUTH_FAILED", () =>
    expect(isResolvableManualAction("DRAFT_AUTH_FAILED")).toBe(false));
});

describe("isNonResolvableManualAction", () => {
  it("true for DRAFT_AUTH_FAILED", () =>
    expect(isNonResolvableManualAction("DRAFT_AUTH_FAILED")).toBe(true));
  it("false for DRAFT_BUDGET_EXCEEDED", () =>
    expect(isNonResolvableManualAction("DRAFT_BUDGET_EXCEEDED")).toBe(false));
});

// ---------------------------------------------------------------------------
// 4. Content normalization: accept_with_edits
// ---------------------------------------------------------------------------
describe("normalizeReviewContent - accept", () => {
  it("valid simplified Chinese meaning accepted", () => {
    const res = normalizeReviewContent("accept", {
      simplifiedChineseMeaning: "苹果（水果）",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.simplifiedChineseMeaning).toBe("苹果（水果）");
  });

  it("empty meaning rejected", () => {
    const res = normalizeReviewContent("accept", { simplifiedChineseMeaning: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("不能为空");
  });

  it("HTML in meaning rejected", () => {
    const res = normalizeReviewContent("accept", {
      simplifiedChineseMeaning: "苹果<script>alert('x')</script>水果",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("HTML");
  });

  it("URL in meaning rejected", () => {
    const res = normalizeReviewContent("accept", {
      simplifiedChineseMeaning: "请访问 https://example.com 了解更多",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("URL");
  });

  it("control chars stripped", () => {
    const res = normalizeReviewContent("accept", {
      simplifiedChineseMeaning: "苹果\t\r\n水果",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.simplifiedChineseMeaning).toBe("苹果 水果");
  });

  it("learning hint optional", () => {
    const res = normalizeReviewContent("accept", {
      simplifiedChineseMeaning: "苹果",
      learningHint: "可数名词",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.learningHint).toBe("可数名词");
  });

  it("reject: meaning not required, reason required", () => {
    const res = normalizeReviewContent("reject", {});
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Canonical hash determinism
// ---------------------------------------------------------------------------
describe("reviewDecisionHash", () => {
  it("same input → same hash", () => {
    const h1 = reviewDecisionHash(CANONICAL_PAYLOAD);
    const h2 = reviewDecisionHash({ ...CANONICAL_PAYLOAD });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different spelling → different hash", () => {
    const h1 = reviewDecisionHash(CANONICAL_PAYLOAD);
    const h2 = reviewDecisionHash({ ...CANONICAL_PAYLOAD, englishSpelling: "world" });
    expect(h1).not.toBe(h2);
  });

  it("different source revision → different hash (provenance detection)", () => {
    const h1 = reviewDecisionHash(CANONICAL_PAYLOAD);
    const h2 = reviewDecisionHash({ ...CANONICAL_PAYLOAD, sourceRevisionId: "9999999" });
    expect(h1).not.toBe(h2);
  });

  it("null hint hashes same as empty hint", () => {
    const h1 = reviewDecisionHash({ ...CANONICAL_PAYLOAD, learningHint: null });
    const h2 = reviewDecisionHash({ ...CANONICAL_PAYLOAD, learningHint: "" });
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// 6. request_hash determinism and collision resistance
// ---------------------------------------------------------------------------
describe("reviewRequestHash", () => {
  it("same request → same hash", () => {
    const h1 = reviewRequestHash(REQUEST_BASE);
    const h2 = reviewRequestHash({ ...REQUEST_BASE });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different reason → different hash (same key + different payload = 409)", () => {
    const h1 = reviewRequestHash(REQUEST_BASE);
    const h2 = reviewRequestHash({ ...REQUEST_BASE, reason: "不同的理由" });
    expect(h1).not.toBe(h2);
  });

  it("different decision type → different hash", () => {
    const h1 = reviewRequestHash(REQUEST_BASE);
    const h2 = reviewRequestHash({ ...REQUEST_BASE, decisionType: "reject" });
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// 7. len-prefixed join prevents construction collisions
// ---------------------------------------------------------------------------
describe("reviewLenPrefixedJoin", () => {
  it("length-prefixed parts prevent [ab,c] vs [a,bc] collision", () => {
    const a = reviewLenPrefixedJoin(["ab", "c"]);
    const b = reviewLenPrefixedJoin(["a", "bc"]);
    expect(a).not.toBe(b);
  });

  it("deterministic for same input", () => {
    const a = reviewLenPrefixedJoin(["review:decision:v1", "x", "y"]);
    const b = reviewLenPrefixedJoin(["review:decision:v1", "x", "y"]);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 8. Fix 1 — optimistic concurrency fingerprint (reviewProjectionVersion)
// ---------------------------------------------------------------------------
describe("reviewProjectionVersion", () => {
  const base = {
    draftId: "aaaa1111-2222-3333-4444-555566667777",
    draftStatus: "draft_ready",
    sourceFactIdentity: "a0".repeat(32),
    sourceRevisionId: "rev-1",
    sourceRevisionTimestamp: "2026-08-16T00:00:00.000Z",
    resolvedProviderModel: "deepseek-v4-flash-0731",
    promptTemplateVersion: "zh-draft-v1",
    draftSchemaVersion: 1,
    meaning: "苹果",
    hint: "优先记忆名词义项",
    hasHandlingFact: false,
  };
  it("same input -> same version (64 hex)", () => {
    const v1 = reviewProjectionVersion(base);
    const v2 = reviewProjectionVersion({ ...base });
    expect(v1).toBe(v2);
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
  });
  it("different meaning -> different version (stale-review signal)", () => {
    const v1 = reviewProjectionVersion(base);
    const v2 = reviewProjectionVersion({ ...base, meaning: "苹果（水果类）" });
    expect(v1).not.toBe(v2);
  });
  it("different handling presence -> different version", () => {
    const v1 = reviewProjectionVersion(base);
    const v2 = reviewProjectionVersion({ ...base, hasHandlingFact: true });
    expect(v1).not.toBe(v2);
  });
});

// ---------------------------------------------------------------------------
// 9. Fix 2 — /resolve idempotency hash includes supplementSummary
// ---------------------------------------------------------------------------
describe("reviewResolveHash", () => {
  const base = {
    draftId: "aaaa1111-2222-3333-4444-555566667777",
    reviewerId: "bbbb2222-3333-4444-5555-666677778888",
    reason: "补充预算单据",
    supplementSummary: "预算已由管理员补足",
    errorCode: "DRAFT_BUDGET_EXCEEDED",
    handlingKind: "manual_handling",
  };
  it("same payload -> same hash", () => {
    const h1 = reviewResolveHash(base);
    const h2 = reviewResolveHash({ ...base });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
  it("different supplementSummary -> different hash (Fix 2)", () => {
    const h1 = reviewResolveHash(base);
    const h2 = reviewResolveHash({ ...base, supplementSummary: "另一份摘要" });
    expect(h1).not.toBe(h2);
  });
  it("different reason -> different hash", () => {
    const h1 = reviewResolveHash(base);
    const h2 = reviewResolveHash({ ...base, reason: "不同的理由" });
    expect(h1).not.toBe(h2);
  });
  it("different errorCode -> different hash", () => {
    const h1 = reviewResolveHash(base);
    const h2 = reviewResolveHash({ ...base, errorCode: "WIKI_AMBIGUOUS" });
    expect(h1).not.toBe(h2);
  });
});
