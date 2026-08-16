// Ticket 08: publication eligibility domain rules — unit tests.
// Covers: Path A/B, accept/reject, provenance completeness, manual_action handling
// (P1-1: only manual_action requires a handling fact), binding consistency (P1-2),
// source-fact state, conflicting decisions.
import { describe, expect, it } from "vitest";
import {
  evaluateItemPublicationEligibility,
  evaluateDraftPublicationEligibility,
  type ItemProvenanceInput,
  type ReviewDecisionProvenance,
} from "@motro/domain";

/** A path-B review decision that is fully eligible by default. */
function rd(overrides: Partial<ReviewDecisionProvenance> = {}): ReviewDecisionProvenance {
  return {
    decisionType: "accept",
    draftStatus: "draft_ready",
    provenanceComplete: true,
    handled: false,
    sourceFactFetched: true,
    snapshotSpellingMatches: true,
    normalizedSpellingMatches: true,
    sourceFactIdentityMatches: true,
    commitRowMatches: true,
    revisionPageConsistent: true,
    sourceFactContentHashPresent: true,
    conflictingDecision: false,
    ...overrides,
  };
}

const basePathA: ItemProvenanceInput = {
  itemId: "item-1",
  provenanceKind: "manual",
  contentReviewValid: true,
  reviewDecision: null,
  lexicalEntryExists: true,
};

const basePathB: ItemProvenanceInput = {
  itemId: "item-2",
  provenanceKind: "review",
  contentReviewValid: true,
  reviewDecision: rd(),
  lexicalEntryExists: true,
};

describe("evaluateItemPublicationEligibility", () => {
  it("Path A (manual) with valid audit reference is eligible", () => {
    expect(evaluateItemPublicationEligibility(basePathA).isEligible).toBe(true);
  });

  it("Path A with invalid content review reference is blocked", () => {
    expect(
      evaluateItemPublicationEligibility({ ...basePathA, contentReviewValid: false }).isEligible,
    ).toBe(false);
  });

  it("Path A with unexpected review decision is blocked (provenance contradiction)", () => {
    expect(
      evaluateItemPublicationEligibility({ ...basePathA, reviewDecision: rd() }).isEligible,
    ).toBe(false);
  });

  // ---- P1-1: draft_ready accepted must NOT require a handling fact, and IS eligible ----
  it("Path B: draft_ready + accepted + complete provenance + no handling fact is ELIGIBLE (P1-1)", () => {
    expect(
      evaluateItemPublicationEligibility({
        ...basePathB,
        reviewDecision: rd({ draftStatus: "draft_ready", handled: false }),
      }).isEligible,
    ).toBe(true);
  });

  it("Path B: draft_ready accepted with handling fact also eligible", () => {
    expect(
      evaluateItemPublicationEligibility({
        ...basePathB,
        reviewDecision: rd({ draftStatus: "draft_ready", handled: true }),
      }).isEligible,
    ).toBe(true);
  });

  // ---- P1-1: manual_action accepted requires a handling fact ----
  it("Path B: manual_action + accepted + HANDLED is eligible", () => {
    expect(
      evaluateItemPublicationEligibility({
        ...basePathB,
        reviewDecision: rd({ draftStatus: "manual_action", handled: true }),
      }).isEligible,
    ).toBe(true);
  });

  it("Path B: manual_action + accepted + UNHANDLED is blocked", () => {
    expect(
      evaluateItemPublicationEligibility({
        ...basePathB,
        reviewDecision: rd({ draftStatus: "manual_action", handled: false }),
      }).isEligible,
    ).toBe(false);
  });

  it("Path B: unrecognized draft status is blocked (fail-closed)", () => {
    expect(
      evaluateItemPublicationEligibility({
        ...basePathB,
        reviewDecision: rd({ draftStatus: "other", handled: true }),
      }).isEligible,
    ).toBe(false);
  });

  it("Path B: rejected decision is not publishable", () => {
    expect(
      evaluateItemPublicationEligibility({
        ...basePathB,
        reviewDecision: rd({ decisionType: "reject" }),
      }).isEligible,
    ).toBe(false);
  });

  it("Path B: incomplete provenance blocks", () => {
    expect(
      evaluateItemPublicationEligibility({
        ...basePathB,
        reviewDecision: rd({ provenanceComplete: false }),
      }).isEligible,
    ).toBe(false);
  });

  it("Path B: conflicting decision blocks", () => {
    expect(
      evaluateItemPublicationEligibility({
        ...basePathB,
        reviewDecision: rd({ conflictingDecision: true }),
      }).isEligible,
    ).toBe(false);
  });

  it("Path B without reviewDecision reference is blocked", () => {
    expect(
      evaluateItemPublicationEligibility({ ...basePathB, reviewDecision: null }).isEligible,
    ).toBe(false);
  });

  // ---- P1-2: binding consistency + source-fact state ----
  it("Path B: source-fact identity mismatch blocks (ITEM_SOURCE_FACT_MISMATCH)", () => {
    const res = evaluateItemPublicationEligibility({
      ...basePathB,
      reviewDecision: rd({ sourceFactIdentityMatches: false }),
    });
    expect(res.isEligible).toBe(false);
    expect(res.issues.some((i) => i.code === "ITEM_SOURCE_FACT_MISMATCH")).toBe(true);
  });

  it("Path B: snapshot spelling mismatch blocks (ITEM_SNAPSHOT_SPELLING_MISMATCH)", () => {
    const res = evaluateItemPublicationEligibility({
      ...basePathB,
      reviewDecision: rd({ snapshotSpellingMatches: false }),
    });
    expect(res.isEligible).toBe(false);
    expect(res.issues.some((i) => i.code === "ITEM_SNAPSHOT_SPELLING_MISMATCH")).toBe(true);
  });

  it("Path B: normalized spelling mismatch blocks (ITEM_NORMALIZED_SPELLING_MISMATCH)", () => {
    const res = evaluateItemPublicationEligibility({
      ...basePathB,
      reviewDecision: rd({ normalizedSpellingMatches: false }),
    });
    expect(res.isEligible).toBe(false);
    expect(res.issues.some((i) => i.code === "ITEM_NORMALIZED_SPELLING_MISMATCH")).toBe(true);
  });

  it("Path B: commit row mismatch blocks (ITEM_COMMIT_ROW_MISMATCH)", () => {
    const res = evaluateItemPublicationEligibility({
      ...basePathB,
      reviewDecision: rd({ commitRowMatches: false }),
    });
    expect(res.isEligible).toBe(false);
    expect(res.issues.some((i) => i.code === "ITEM_COMMIT_ROW_MISMATCH")).toBe(true);
  });

  it("Path B: revision/page identity mismatch blocks (ITEM_REVISION_PAGE_MISMATCH)", () => {
    const res = evaluateItemPublicationEligibility({
      ...basePathB,
      reviewDecision: rd({ revisionPageConsistent: false }),
    });
    expect(res.isEligible).toBe(false);
    expect(res.issues.some((i) => i.code === "ITEM_REVISION_PAGE_MISMATCH")).toBe(true);
  });

  it("Path B: source fact not fetched blocks (ITEM_SOURCE_FACT_NOT_FETCHED)", () => {
    const res = evaluateItemPublicationEligibility({
      ...basePathB,
      reviewDecision: rd({ sourceFactFetched: false }),
    });
    expect(res.isEligible).toBe(false);
    expect(res.issues.some((i) => i.code === "ITEM_SOURCE_FACT_NOT_FETCHED")).toBe(true);
  });

  it("Path B: content hash missing blocks (ITEM_SOURCE_FACT_HASH_MISSING)", () => {
    const res = evaluateItemPublicationEligibility({
      ...basePathB,
      reviewDecision: rd({ sourceFactContentHashPresent: false }),
    });
    expect(res.isEligible).toBe(false);
    expect(res.issues.some((i) => i.code === "ITEM_SOURCE_FACT_HASH_MISSING")).toBe(true);
  });

  it("Path B: review decision already bound to another item blocks (ITEM_CONFLICTING_DECISION)", () => {
    const res = evaluateItemPublicationEligibility({
      ...basePathB,
      reviewDecision: rd({ conflictingDecision: true }),
    });
    expect(res.isEligible).toBe(false);
    expect(res.issues.some((i) => i.code === "ITEM_CONFLICTING_DECISION")).toBe(true);
  });

  it("missing lexical entry is blocked regardless of provenance", () => {
    expect(
      evaluateItemPublicationEligibility({ ...basePathA, lexicalEntryExists: false }).isEligible,
    ).toBe(false);
  });
});

describe("evaluateDraftPublicationEligibility (aggregate)", () => {
  it("all items eligible → eligible", () => {
    expect(evaluateDraftPublicationEligibility([basePathA, basePathB]).isEligible).toBe(true);
  });

  it("one blocked item blocks the whole draft", () => {
    const bad: ItemProvenanceInput = {
      itemId: "bad",
      provenanceKind: "manual",
      contentReviewValid: false,
      reviewDecision: null,
      lexicalEntryExists: true,
    };
    expect(evaluateDraftPublicationEligibility([basePathA, bad]).isEligible).toBe(false);
  });

  it("empty items list is not publishable", () => {
    expect(evaluateDraftPublicationEligibility([]).isEligible).toBe(false);
  });
});
