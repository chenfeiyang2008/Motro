// Ticket 07: pure human-review decision rules (zero side effects, fake-only).
//
// This module is the domain seam for review decisions.  It intentionally does NOT
// own persistence (the API service owns transactions / projections) and does NOT
// import Nest / pg / Graphile / network.  Everything here is deterministic and
// unit-testable: canonical hashing, state-machine eligibility, and the
// resolvable / non-resolvable manual_action classification that gates both the
// decision commands and the manual-handling (resolve) path.
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Decision types (the three command verbs).
// ---------------------------------------------------------------------------
export const REVIEW_DECISION_TYPES = ["accept", "accept_with_edits", "reject"] as const;
export type ReviewDecisionType = (typeof REVIEW_DECISION_TYPES)[number];

export function isReviewDecisionType(value: string): value is ReviewDecisionType {
  return (REVIEW_DECISION_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Draft statuses consumed from Ticket 06.
// ---------------------------------------------------------------------------
export const REVIEWABLE_DRAFT_MODES = [
  "drafting",
  "draft_ready",
  "retry_wait",
  "manual_action",
  "failed",
  "superseded",
  "restricted_model_identity",
] as const;
export type ReviewableDraftMode = (typeof REVIEWABLE_DRAFT_MODES)[number];

/**
 * A draft may receive a terminal review decision ONLY when it is `draft_ready`.
 * All other statuses (drafting / retry_wait / manual_action / failed / superseded
 * / restricted_model_identity) are not reviewable.  manual_action is handled via
 * the resolve path for resolvable classes exclusively — never a direct decision.
 */
export function isReviewableDraftMode(status: string): status is "draft_ready" {
  return status === "draft_ready";
}

/** Human-readable reason block for a non-reviewable draft (structured, not leaked). */
export function describeUnreviewable(status: string): string {
  switch (status) {
    case "drafting":
      return "草稿仍在生成中";
    case "retry_wait":
      return "草稿等待自动重试中";
    case "manual_action":
      return "草稿需要人工处理（可补全或需上游修复），不能直接审核";
    case "failed":
      return "草稿失败";
    case "superseded":
      return "草稿已被新版本代替";
    case "restricted_model_identity":
      return "草稿模型身份不足";
    default:
      return "草稿状态不可审核";
  }
}

// ---------------------------------------------------------------------------
// Manual_action classification (resolvable vs non-resolvable).
//
// Resolvable: an admin supplements structure WITHOUT changing source truth,
// model identity or security conclusion:
//   - DRAFT_BUDGET_EXCEEDED  (budget/quota has been supplied)
//   - WIKI_AMBIGUOUS         (single sense resolved among many senses/POS/pages)
//
// Everything else in the manual set is NON-resolvable: provider auth failure,
// model identity insufficient, source or revision missing/unverifiable, schema /
// security failure, license/attribution unverifiable.  Those may never be
// advanced to draft_ready by an admin "marking it resolved" — the DB trigger
// enforces this at the physical layer too.
// ---------------------------------------------------------------------------
const RESOLVABLE_MANUAL_ACTION_CODES: ReadonlySet<string> = new Set([
  "DRAFT_BUDGET_EXCEEDED",
  "WIKI_AMBIGUOUS",
]);

const NON_RESOLVABLE_MANUAL_ACTION_CODES: ReadonlySet<string> = new Set([
  "DRAFT_AUTH_FAILED",
  "DRAFT_MODEL_IDENTITY_INSUFFICIENT",
  "DRAFT_SOURCE_MISSING",
  "WIKI_PAGE_NOT_FOUND",
  "WIKI_REVISION_NOT_FOUND",
  "WIKI_LICENSE_INCOMPLETE",
  "WIKI_ATTRIBUTION_INCOMPLETE",
]);

/** Is this error code a resolvable manual_action (may become draft_ready)? */
export function isResolvableManualAction(errorCode: string | null | undefined): boolean {
  return (
    errorCode !== null && errorCode !== undefined && RESOLVABLE_MANUAL_ACTION_CODES.has(errorCode)
  );
}

/** Is this error code a non-resolvable manual_action (must NOT become draft_ready)? */
export function isNonResolvableManualAction(errorCode: string | null | undefined): boolean {
  return (
    errorCode !== null &&
    errorCode !== undefined &&
    NON_RESOLVABLE_MANUAL_ACTION_CODES.has(errorCode)
  );
}

export type ManualActionClass = "resolvable" | "non_resolvable" | "none";

export function manualActionClass(errorCode: string | null | undefined): ManualActionClass {
  if (isResolvableManualAction(errorCode)) return "resolvable";
  if (isNonResolvableManualAction(errorCode)) return "non_resolvable";
  return "none";
}

// ---------------------------------------------------------------------------
// Canonical hashing (deterministic, length-prefixed to defeat construction
// collisions — same scheme as the draft identity hashes in drafts/rules.ts).
// ---------------------------------------------------------------------------
export function reviewLenPrefixedJoin(parts: Array<string | number>): string {
  return parts.map((p) => `${String(p).length}:${String(p)}`).join("");
}

export interface ReviewRequestPayload {
  draftId: string;
  reviewerId: string;
  decisionType: ReviewDecisionType;
  reason: string;
  englishSpelling: string | null;
  simplifiedChineseMeaning: string | null;
  learningHint: string | null;
}

/**
 * request_hash: identity of the review request.  Same (reviewer, idempotency_key,
 * request_hash) replays the frozen first response; same key but different hash is
 * a 409 conflict.
 */
export function reviewRequestHash(payload: ReviewRequestPayload): string {
  return createHash("sha256")
    .update(
      reviewLenPrefixedJoin([
        "review:decision:v1",
        payload.draftId,
        payload.reviewerId,
        payload.decisionType,
        payload.reason,
        payload.englishSpelling ?? "",
        payload.simplifiedChineseMeaning ?? "",
        payload.learningHint ?? "",
      ]),
    )
    .digest("hex");
}

export interface ReviewDecisionCanonicalInput {
  draftId: string;
  decisionType: ReviewDecisionType;
  englishSpelling: string;
  simplifiedChineseMeaning: string | null;
  learningHint: string | null;
  sourceFactIdentity: string;
  sourceRevisionId: string;
}

/**
 * decision_hash: a deterministic digest over the accepted/edit/rejected content
 * snapshot + the fixed source/revision identity it rests on.  Recomputable from
 * the immutable snapshot; used to prove two decisions are byte-identical and to
 * detect any provenance mismatch at decision time.
 */
export function reviewDecisionHash(input: ReviewDecisionCanonicalInput): string {
  return createHash("sha256")
    .update(
      reviewLenPrefixedJoin([
        "review:decision:snp:v1",
        input.draftId,
        input.decisionType,
        input.englishSpelling,
        input.simplifiedChineseMeaning ?? "",
        input.learningHint ?? "",
        input.sourceFactIdentity,
        input.sourceRevisionId,
      ]),
    )
    .digest("hex");
}

/**
 * reviewProjectionVersion: an OCC fingerprint of the current immutable reviewable
 * projection for a draft.  It is computed deterministically over the fields that
 * would change if the draft / its provenance / its manual handling were to change
 * between the time a reviewer loads the detail page and the time they submit a
 * decision.  The client echoes this value as `expectedVersion`; a stale value is
 * rejected with a structured 409 (optimistic concurrency — not `FOR UPDATE` alone).
 *
 * NOTE: this is NOT an auto-incrementing column on an immutable fact; it is a
 * derived digest over stable reviewable identity.  It changes only when the
 * underlying draft/source/manual-handling state that affects reviewability
 * changes, which is exactly the stale-review condition the contract requires.
 */
export interface ReviewProjectionVersionInput {
  draftId: string;
  draftStatus: string;
  sourceFactIdentity: string;
  sourceRevisionId: string;
  sourceRevisionTimestamp: string;
  resolvedProviderModel: string | null;
  promptTemplateVersion: string;
  draftSchemaVersion: number;
  meaning: string | null;
  hint: string | null;
  hasHandlingFact: boolean;
}

export function reviewProjectionVersion(input: ReviewProjectionVersionInput): string {
  return createHash("sha256")
    .update(
      reviewLenPrefixedJoin([
        "review:projection:v1",
        input.draftId,
        input.draftStatus,
        input.sourceFactIdentity,
        input.sourceRevisionId,
        input.sourceRevisionTimestamp,
        input.resolvedProviderModel ?? "",
        input.promptTemplateVersion,
        String(input.draftSchemaVersion),
        input.meaning ?? "",
        input.hint ?? "",
        input.hasHandlingFact ? "handled" : "unhandled",
      ]),
    )
    .digest("hex");
}

export interface ReviewResolvePayload {
  draftId: string;
  reviewerId: string;
  reason: string;
  supplementSummary: string | null;
  errorCode: string | null;
  handlingKind: string;
}

/**
 * reviewResolveHash: identity of a /resolve manual-handling request.  Correctly
 * includes supplementSummary (which the previous request_hash omitted), so a same
 * Idempotency-Key with a different supplementSummary is a distinct payload → 409.
 * Same key + same full payload → frozen replay (no new fact, no new audit).
 */
export function reviewResolveHash(payload: ReviewResolvePayload): string {
  return createHash("sha256")
    .update(
      reviewLenPrefixedJoin([
        "review:resolve:v1",
        payload.draftId,
        payload.reviewerId,
        payload.reason,
        payload.supplementSummary ?? "",
        payload.errorCode ?? "",
        payload.handlingKind,
      ]),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Review content normalization for accept_with_edits (narrow allowlist).
// Only the two draft content fields are editable; source/model/provenance cannot
// be overridden from a decision body.
// ---------------------------------------------------------------------------
export interface ReviewContentInput {
  simplifiedChineseMeaning?: string | null;
  learningHint?: string | null;
}

export interface NormalizedReviewContent {
  simplifiedChineseMeaning: string | null;
  learningHint: string | null;
}

// C0 control chars 0x00..0x1f + DEL (0x7f) + U+2028/U+2029 line separators.

// eslint-disable-next-line no-control-regex -- intentionally match control chars to strip untrusted text
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;
// Reject HTML/script/URL markers in reviewer-edited text.
const HTML_SCRIPT_RE = /<\s*\/?[a-z]|<\/|\]\]>|javascript:|data:text\/html/i;
const URL_RE = /https?:\/\/|www\./i;
// Simplified-Chinese basic detection: at least one CJK unified ideograph char.
const CJK_RE = /[㐀-䶿一-鿿]/;

function cleanText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 && cleaned.length <= max ? cleaned : null;
}

/**
 * Validates + normalizes accept_with_edits content.
 * On reject, returns the controlled reject snapshot (no meaning required).
 * On accept, returns the frozen draft meaning/hint (validated here too).
 */
export function normalizeReviewContent(
  decisionType: ReviewDecisionType,
  input: ReviewContentInput,
): { ok: true; value: NormalizedReviewContent } | { ok: false; reason: string } {
  const meaningRaw =
    input.simplifiedChineseMeaning === undefined
      ? null
      : String(input.simplifiedChineseMeaning ?? "");
  const hintRaw = input.learningHint === undefined ? null : String(input.learningHint ?? "");

  if (decisionType === "reject") {
    // reject requires a non-empty reason (enforced in the service); the content
    // snapshot is a controlled read-only copy, not required from the body.
    const hint = cleanText(hintRaw, 80);
    if (hintRaw !== null && hintRaw !== "" && hint === null)
      return { ok: false, reason: "学习提示格式或长度不合法" };
    return { ok: true, value: { simplifiedChineseMeaning: null, learningHint: hint } };
  }

  const meaning = cleanText(meaningRaw, 120);
  if (!meaning) return { ok: false, reason: "中文含义不能为空" };
  if (meaningRaw !== null && meaning !== null && !CJK_RE.test(meaning))
    return { ok: false, reason: "中文含义需包含简体中文字符" };
  if (HTML_SCRIPT_RE.test(meaning)) return { ok: false, reason: "中文含义不能包含 HTML/脚本" };
  if (URL_RE.test(meaning)) return { ok: false, reason: "中文含义不能包含 URL" };

  const hint = cleanText(hintRaw, 80);
  if (hintRaw !== null && hintRaw !== "" && hint === null)
    return { ok: false, reason: "学习提示格式或长度不合法" };
  if (hint && HTML_SCRIPT_RE.test(hint)) return { ok: false, reason: "学习提示不能包含 HTML/脚本" };
  if (hint && URL_RE.test(hint)) return { ok: false, reason: "学习提示不能包含 URL" };

  return { ok: true, value: { simplifiedChineseMeaning: meaning, learningHint: hint } };
}
