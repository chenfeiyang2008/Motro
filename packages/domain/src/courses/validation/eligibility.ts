// Ticket 08: publication eligibility + provenance semantic bridge — pure domain rules.
//
// A course item's provenance is one of two paths:
//   Path A (manual): content_review_reference -> a manual audit event; meaning/hint are
//                    admin-authored. provenance_kind = 'manual', review_decision_id = null.
//   Path B (review): provenance_kind = 'review', review_decision_id -> a real Ticket 07
//                    review_decision; meaning derives from review_decision_snapshots.
//
// Publication eligibility (fail-closed):
//   - Path B requires the review decision to be accepted / accepted_with_edits.
//   - reject or unresolved (manual_action without complete handling) is NOT publishable.
//   - provenance must be complete (source fact + revision + license + attribution).
//   - a draft item whose provenance is contradictory (Path B marked manual, or Path A
//     claiming review) is not publishable.
//   - one course item must NOT be bound to two conflicting review decisions.
//
// This module is pure: it makes no DB calls and has no side effects.

import type { ValidationIssue } from "./types.js";

export type ProvenanceKind = "manual" | "review";

export interface ReviewDecisionProvenance {
  /** One of: accept, accept_with_edits, reject. */
  decisionType: "accept" | "accept_with_edits" | "reject";
  /** The original enrichment draft status this review decision was minted on. */
  draftStatus: "draft_ready" | "manual_action" | "other";
  /** True if the review snapshot carries complete source/license/attribution. */
  provenanceComplete: boolean;
  /** True if the decision's draft was a resolvable manual_action that has a complete
      manual_handling_fact.  Required ONLY when draftStatus === 'manual_action'. */
  handled: boolean;
  /** True if the decision's snapshot source fact is in a fetched/publishable state. */
  sourceFactFetched: boolean;
  /** True if the review snapshot's english_spelling matches this course item's
      lexical entry canonical_spelling (P1 final). */
  snapshotSpellingMatches: boolean;
  /** True if the source fact's normalized_spelling matches this course item's
      lexical entry normalized_spelling (P1 final). */
  normalizedSpellingMatches: boolean;
  /** True if snapshot.source_fact_identity == draft.wiktionary_source_fact_id (P1 final). */
  sourceFactIdentityMatches: boolean;
  /** True if source_fact.commit_row_id == draft.import_batch_commit_row_id (P1 final). */
  commitRowMatches: boolean;
  /** True if snapshot page/revision == source fact page/revision (P1 final). */
  revisionPageConsistent: boolean;
  /** True if source fact content_hash is present (P1 final). */
  sourceFactContentHashPresent: boolean;
  /** True if this item is already bound to another review decision (conflict guard). */
  conflictingDecision: boolean;
}

export interface ItemProvenanceInput {
  itemId: string;
  provenanceKind: ProvenanceKind;
  contentReviewValid: boolean;
  reviewDecision: ReviewDecisionProvenance | null;
  lexicalEntryExists: boolean;
}

export interface EligibilityResult {
  isEligible: boolean;
  issues: ValidationIssue[];
}

const PUBLISH_BADGE = "(publication-eligibility)";

/**
 * Evaluate a single course item's publication eligibility.
 * Fail-closed: any missing/contradictory/denied provenance blocks publication.
 */
export function evaluateItemPublicationEligibility(input: ItemProvenanceInput): EligibilityResult {
  const issues: ValidationIssue[] = [];
  const path = `item.${input.itemId}`;

  if (input.provenanceKind === "manual") {
    // Path A: manual item. contentReviewReference must be a valid audit event.
    if (!input.contentReviewValid) {
      issues.push({
        code: "ITEM_MANUAL_PROVENANCE_INVALID",
        path,
        message: `课程词项 ${input.itemId} 缺少有效的手工内容审核引用`,
        severity: "error",
      });
    }
    if (input.reviewDecision) {
      // A Path-A item must not carry a review-decision binding (contradictory provenance).
      issues.push({
        code: "ITEM_PROVENANCE_CONTRADICTION",
        path,
        message: `课程词项 ${input.itemId} 的手工 provenance 与审核决定引用冲突`,
        severity: "error",
      });
    }
  } else if (input.provenanceKind === "review") {
    // Path B: derived from a Ticket 07 review decision.
    if (!input.reviewDecision) {
      issues.push({
        code: "ITEM_NO_REVIEW_DECISION",
        path,
        message: `课程词项 ${input.itemId} 声明为审核来源但缺失 review decision`,
        severity: "error",
      });
      return { isEligible: false, issues };
    }
    const rd = input.reviewDecision;
    if (rd.decisionType === "reject") {
      issues.push({
        code: "ITEM_REJECTED_NOT_PUBLISHABLE",
        path,
        message: `课程词项 ${input.itemId} 引用被驳回的审核决定，不可发布`,
        severity: "error",
      });
    }
    if (rd.decisionType !== "accept" && rd.decisionType !== "accept_with_edits") {
      // Some unresolved/unknown decision type -> fail closed.
      issues.push({
        code: "ITEM_DECISION_NOT_ACCEPTED",
        path,
        message: `课程词项 ${input.itemId} 的审核决定未接受，不可发布`,
        severity: "error",
      });
    }
    if (!rd.provenanceComplete) {
      issues.push({
        code: "ITEM_PROVENANCE_INCOMPLETE",
        path,
        message: `课程词项 ${input.itemId} 的来源/修订/许可/归属不完整，不可发布`,
        severity: "error",
      });
    }
    // P1-1: handling requirement depends on the ORIGINAL draft status, not guessed.
    //   draft_ready -> manual_handling_facts NOT required.
    //   manual_action -> MUST be resolvable AND have a complete handling fact.
    //   other/unrecognized -> fail closed.
    if (rd.draftStatus === "manual_action" && !rd.handled) {
      issues.push({
        code: "ITEM_MANUAL_ACTION_UNRESOLVED",
        path,
        message: `课程词项 ${input.itemId} 的 manual_action 未妥善人工处理，不可发布`,
        severity: "error",
      });
    } else if (rd.draftStatus === "other") {
      issues.push({
        code: "ITEM_DRAFT_STATUS_INVALID",
        path,
        message: `课程词项 ${input.itemId} 对应草稿状态非法，不可发布`,
        severity: "error",
      });
    }
    // P1-2 + final P1: fine-grained review/source/lexical identity binding — each
    // mismatch gets a stable error code; all fail-closed.
    if (!rd.sourceFactIdentityMatches) {
      issues.push({
        code: "ITEM_SOURCE_FACT_MISMATCH",
        path,
        message: `课程词项 ${input.itemId} 的 snapshot 来源事实与草稿来源不一致，不可发布`,
        severity: "error",
      });
    }
    if (!rd.snapshotSpellingMatches) {
      issues.push({
        code: "ITEM_SNAPSHOT_SPELLING_MISMATCH",
        path,
        message: `课程词项 ${input.itemId} 的审核快照拼写与词条不一致，不可发布`,
        severity: "error",
      });
    }
    if (!rd.normalizedSpellingMatches) {
      issues.push({
        code: "ITEM_NORMALIZED_SPELLING_MISMATCH",
        path,
        message: `课程词项 ${input.itemId} 的来源事实拼写与词条不一致，不可发布`,
        severity: "error",
      });
    }
    if (!rd.commitRowMatches) {
      issues.push({
        code: "ITEM_COMMIT_ROW_MISMATCH",
        path,
        message: `课程词项 ${input.itemId} 的来源事实 commit row 与草稿不一致，不可发布`,
        severity: "error",
      });
    }
    if (!rd.revisionPageConsistent) {
      issues.push({
        code: "ITEM_REVISION_PAGE_MISMATCH",
        path,
        message: `课程词项 ${input.itemId} 的 revision/page 身份不一致，不可发布`,
        severity: "error",
      });
    }
    if (!rd.sourceFactFetched) {
      issues.push({
        code: "ITEM_SOURCE_FACT_NOT_FETCHED",
        path,
        message: `课程词项 ${input.itemId} 的来源事实未处于 fetched，不可发布`,
        severity: "error",
      });
    }
    if (!rd.sourceFactContentHashPresent) {
      issues.push({
        code: "ITEM_SOURCE_FACT_HASH_MISSING",
        path,
        message: `课程词项 ${input.itemId} 的来源事实缺少 content_hash，不可发布`,
        severity: "error",
      });
    }
    if (rd.conflictingDecision) {
      issues.push({
        code: "ITEM_CONFLICTING_DECISION",
        path,
        message: `课程词项 ${input.itemId} 绑定到冲突/已被其他词项占用的审核决定，不可发布`,
        severity: "error",
      });
    }
  } else {
    issues.push({
      code: "ITEM_PROVENANCE_KIND_UNKNOWN",
      path,
      message: `课程词项 ${input.itemId} 的 provenance 类别未知，不可发布`,
      severity: "error",
    });
  }

  if (!input.lexicalEntryExists) {
    issues.push({
      code: "ITEM_LEXICAL_ENTRY_MISSING",
      path,
      message: `课程词项 ${input.itemId} 引用的词条不存在`,
      severity: "error",
    });
  }

  return { isEligible: issues.length === 0, issues };
}

/**
 * Aggregate item eligibility into a draft-level publication eligibility verdict.
 * All items must be eligible for the release to be allowed.
 */
export function evaluateDraftPublicationEligibility(
  items: ItemProvenanceInput[],
): EligibilityResult {
  const issues: ValidationIssue[] = [];
  let eligible = true;
  for (const item of items) {
    const r = evaluateItemPublicationEligibility(item);
    if (!r.isEligible) eligible = false;
    issues.push(...r.issues);
  }
  if (items.length === 0) {
    issues.push({
      code: "DRAFT_NO_ITEMS",
      path: "draft",
      message: `${PUBLISH_BADGE} 草稿没有任何课程词项，不可发布`,
      severity: "error",
    });
    eligible = false;
  }
  return { isEligible: eligible, issues };
}
