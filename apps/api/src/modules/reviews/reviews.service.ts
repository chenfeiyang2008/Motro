/* eslint-disable no-control-regex -- reviewer text is normalized before persistence */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { POOL } from "../../auth/database.provider.js";
import {
  describeUnreviewable,
  isNonResolvableManualAction,
  manualActionClass,
  normalizeReviewContent,
  reviewDecisionHash,
  reviewProjectionVersion,
  reviewRequestHash,
  reviewResolveHash,
  type ManualActionClass,
  type ReviewDecisionType,
} from "@motro/domain";
import type {
  ReviewDecisionRequestDto,
  ReviewDecisionResponseDto,
  ReviewDraftDetailDto,
  ReviewDraftListDto,
  ReviewSourceProjectionDto,
} from "./reviews.dto.js";

interface ReviewableRow {
  draft_id: string;
  draft_status: string;
  draft_created_at: Date;
  spelling: string;
  draft_meaning: string;
  draft_hint: string | null;
  draft_error_code: string | null;
  configured_model_alias: string;
  resolved_provider_model: string | null;
  provider_fingerprint: string | null;
  prompt_template_version: string;
  draft_schema_version: number;
  source_fact_identity: string;
  source_page_id: string;
  source_revision_id: string;
  source_revision_timestamp: Date | null;
  source_url: string;
  license_name: string | null;
  license_version: string | null;
  license_url: string | null;
  attribution: string | null;
  content_hash: string | null;
  part_of_speech: string | null;
}

interface DecisionRow {
  id: string;
  draft_id: string;
  decision_type: string;
  reason: string;
  reviewer_id: string;
  created_at: Date;
  english_spelling: string;
  simplified_chinese_meaning: string | null;
  learning_hint: string | null;
  source_page_id: string;
  source_revision_id: string;
  source_revision_timestamp: Date;
  source_url: string;
  license_name: string;
  license_version: string | null;
  license_url: string;
  attribution: string;
}

/**
 * Projection of reviewable drafts.  All source-derived columns are required to be
 * complete (Ticket 07 §7.1 A2 provenance complete).  The meaning requirement is
 * NOT applied here — it is decided per-draft-path by the effective-reviewable
 * condition: draft_ready requires meaning; a resolvable manual_action draft that
 * has a complete manual_handling_fact is reviewable with null meaning (the reviewer
 * supplies real content via accept_with_edits).
 */
const REVIEWABLE_SELECT = `
  SELECT d.id AS draft_id, d.status AS draft_status, d.created_at AS draft_created_at,
         r.normalized_spelling AS spelling, f.part_of_speech AS part_of_speech,
         d.simplified_chinese_meaning AS draft_meaning, d.learning_hint AS draft_hint,
         d.error_code AS draft_error_code,
         d.configured_model_alias, d.resolved_provider_model, d.provider_fingerprint,
         d.prompt_template_version, d.draft_schema_version,
         f.source_fact_identity, f.page_id AS source_page_id, f.revision_id AS source_revision_id,
         f.revision_timestamp AS source_revision_timestamp, f.source_url,
         f.license_name, f.license_version, f.license_url, f.attribution, f.content_hash
  FROM enrichment_drafts d
  JOIN import_batch_commit_rows r ON r.id = d.import_batch_commit_row_id
  JOIN wiktionary_source_facts f
    ON f.source_fact_identity = d.wiktionary_source_fact_id AND f.status = 'fetched'
   AND f.content_hash IS NOT NULL
  WHERE f.revision_timestamp IS NOT NULL
    AND NULLIF(f.source_url, '') IS NOT NULL
    AND NULLIF(f.license_name, '') IS NOT NULL
    AND NULLIF(f.license_url, '') IS NOT NULL
    AND NULLIF(f.attribution, '') IS NOT NULL`;

// ---- effective-reviewable condition ----
// A draft is reviewable iff:
//   (a) it is draft_ready with a non-empty meaning, OR
//   (b) it is a resolvable manual_action (DRAFT_BUDGET_EXCEEDED / WIKI_AMBIGUOUS)
//       that has a complete manual_handling_fact (next_status = draft_ready).
// AND it must NOT already have a terminal review decision (Fix 3: decided drafts
// leave the queue for list/detail/decide/resolve).
// The manual_action path never rewrites the immutable draft's physical status
// and never fabricates a meaning; it is surfaced purely by the projection.
const EFFECTIVE_REVIEWABLE_SQL = `
  ( d.status = 'draft_ready' AND d.simplified_chinese_meaning IS NOT NULL
      AND length(d.simplified_chinese_meaning) > 0
    OR ( d.status = 'manual_action'
         AND d.error_code IN ('DRAFT_BUDGET_EXCEEDED', 'WIKI_AMBIGUOUS')
         AND EXISTS (SELECT 1 FROM manual_handling_facts h
                      WHERE h.draft_id = d.id AND h.next_status = 'draft_ready') ) )
  AND NOT EXISTS (SELECT 1 FROM review_decisions xd WHERE xd.draft_id = d.id)`;

function sourceOf(
  row: Pick<
    ReviewableRow,
    | "source_page_id"
    | "source_revision_id"
    | "source_revision_timestamp"
    | "source_url"
    | "license_name"
    | "license_version"
    | "license_url"
    | "attribution"
  >,
): ReviewSourceProjectionDto {
  return {
    sourceName: "Wiktionary",
    pageId: row.source_page_id,
    revisionId: row.source_revision_id,
    revisionTimestamp: new Date(row.source_revision_timestamp!).toISOString(),
    sourceUrl: row.source_url,
    licenseName: row.license_name!,
    ...(row.license_version ? { licenseVersion: row.license_version } : {}),
    licenseUrl: row.license_url!,
    attribution: row.attribution!,
  };
}

function cleanReason(reason: string | undefined, type: ReviewDecisionType): string {
  const value = (reason ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (type === "reject" && value.length === 0)
    throw new UnprocessableEntityException("驳回必须填写理由");
  if (value.length > 1000) throw new UnprocessableEntityException("理由长度超限");
  return value || (type === "accept" ? "管理员审核接受" : "管理员编辑后接受");
}

function toDecision(row: DecisionRow): ReviewDecisionResponseDto["decision"] {
  return {
    id: row.id,
    draftId: row.draft_id,
    decisionType: row.decision_type,
    reason: row.reason,
    reviewerId: row.reviewer_id,
    createdAt: row.created_at.toISOString(),
    source: sourceOf(row),
    englishSpelling: row.english_spelling,
    ...(row.simplified_chinese_meaning
      ? { simplifiedChineseMeaning: row.simplified_chinese_meaning }
      : {}),
    ...(row.learning_hint ? { learningHint: row.learning_hint } : {}),
  };
}

/** OCC fingerprint of the current reviewable projection for a draft row. */
function projectionVersionOf(
  row: Pick<
    ReviewableRow,
    | "draft_id"
    | "draft_status"
    | "draft_meaning"
    | "draft_hint"
    | "source_fact_identity"
    | "source_revision_id"
    | "source_revision_timestamp"
    | "resolved_provider_model"
    | "prompt_template_version"
    | "draft_schema_version"
  >,
  hasHandlingFact: boolean,
): string {
  return reviewProjectionVersion({
    draftId: row.draft_id,
    draftStatus: row.draft_status,
    sourceFactIdentity: row.source_fact_identity,
    sourceRevisionId: row.source_revision_id,
    sourceRevisionTimestamp: new Date(row.source_revision_timestamp!).toISOString(),
    resolvedProviderModel: row.resolved_provider_model,
    promptTemplateVersion: row.prompt_template_version,
    draftSchemaVersion: row.draft_schema_version,
    meaning: row.draft_meaning,
    hint: row.draft_hint,
    hasHandlingFact,
  });
}

@Injectable()
export class ReviewsService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /** 待审队列：有效审核投影（draft_ready 带含义，或 可解除 manual_action 已人工处理），来源完整。 */
  async list(): Promise<ReviewDraftListDto> {
    const result = await this.pool.query<
      ReviewableRow & { decision_type: string | null; handling_fact_exists: boolean }
    >(
      `SELECT dec.decision_type,
              EXISTS (SELECT 1 FROM manual_handling_facts h2 WHERE h2.draft_id = d.id AND h2.next_status='draft_ready') AS handling_fact_exists,
              d.id AS draft_id,
              r.normalized_spelling AS spelling,
              CASE WHEN d.status = 'draft_ready' THEN d.status ELSE 'draft_ready' END AS draft_status,
              f.part_of_speech AS part_of_speech,
              d.simplified_chinese_meaning AS draft_meaning, d.learning_hint AS draft_hint,
              d.error_code AS draft_error_code,
              d.configured_model_alias, d.resolved_provider_model, d.provider_fingerprint,
              d.prompt_template_version, d.draft_schema_version,
              f.source_fact_identity, f.page_id AS source_page_id, f.revision_id AS source_revision_id,
              f.revision_timestamp AS source_revision_timestamp, f.source_url,
              f.license_name, f.license_version, f.license_url, f.attribution, f.content_hash
       FROM enrichment_drafts d
       JOIN import_batch_commit_rows r ON r.id = d.import_batch_commit_row_id
       JOIN wiktionary_source_facts f
         ON f.source_fact_identity = d.wiktionary_source_fact_id AND f.status = 'fetched'
        AND f.content_hash IS NOT NULL
       LEFT JOIN review_decisions dec ON dec.draft_id = d.id
       WHERE f.revision_timestamp IS NOT NULL
         AND NULLIF(f.source_url, '') IS NOT NULL
         AND NULLIF(f.license_name, '') IS NOT NULL
         AND NULLIF(f.license_url, '') IS NOT NULL
         AND NULLIF(f.attribution, '') IS NOT NULL
         AND ( ${EFFECTIVE_REVIEWABLE_SQL} )
       ORDER BY d.created_at DESC, d.id DESC LIMIT 100`,
    );
    return {
      items: result.rows.map((row) => ({
        draftId: row.draft_id,
        spelling: row.spelling,
        status: row.draft_status,
        createdAt: row.draft_created_at.toISOString(),
        ...(row.decision_type ? { decisionType: row.decision_type } : {}),
        reviewVersion: projectionVersionOf(row, row.handling_fact_exists),
        source: sourceOf(row),
      })),
    };
  }

  /**
   * 单草稿详情。仅在草稿属于【有效审核投影】（draft_ready 或 可解除 manual_action 且已完成人工处理）
   * 且来源完整时返回；否则 404（隐藏资源语义，不暴露差异）。
   */
  async detail(draftId: string): Promise<ReviewDraftDetailDto> {
    const result = await this.pool.query<ReviewableRow & { handling_fact_exists: boolean }>(
      `${REVIEWABLE_SELECT.replace(
        "SELECT d.id AS draft_id",
        "SELECT EXISTS (SELECT 1 FROM manual_handling_facts h2 WHERE h2.draft_id = d.id AND h2.next_status='draft_ready') AS handling_fact_exists, d.id AS draft_id",
      )}
         AND d.id = $1
         AND ( ${EFFECTIVE_REVIEWABLE_SQL} )`,
      [draftId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("草稿不存在、未在有效审核投影中或来源尚未完整");
    const decisionResult = await this.pool.query<DecisionRow>(
      `SELECT d.id, d.draft_id, d.decision_type, d.reason, d.reviewer_id, d.created_at,
              s.english_spelling, s.simplified_chinese_meaning, s.learning_hint,
              s.source_page_id, s.source_revision_id, s.source_revision_timestamp,
              s.source_url, s.license_name, s.license_version, s.license_url, s.attribution
       FROM review_decisions d
       JOIN review_decision_snapshots s ON s.decision_id = d.id
       WHERE d.draft_id = $1`,
      [draftId],
    );
    return {
      draftId: row.draft_id,
      spelling: row.spelling,
      // 有效审核投影中的 manual_action 草稿以 draft_ready 语义展示给审核员（不伪装物理状态）。
      status: "draft_ready",
      simplifiedChineseMeaning: row.draft_meaning ?? "",
      ...(row.draft_hint ? { learningHint: row.draft_hint } : {}),
      createdAt: row.draft_created_at.toISOString(),
      reviewVersion: projectionVersionOf(row, row.handling_fact_exists),
      source: sourceOf(row),
      ...(decisionResult.rows[0] ? { decision: toDecision(decisionResult.rows[0]) } : {}),
    };
  }

  /** 历史决定（不可变只读）：该 draft 的所有既往决定。当前 schema 为一 draft 至多一终态。 */
  async history(draftId: string): Promise<ReviewDraftListDto> {
    const exists = await this.pool.query("SELECT 1 FROM enrichment_drafts WHERE id = $1", [
      draftId,
    ]);
    if (exists.rowCount === 0) throw new NotFoundException("草稿不存在");
    const result = await this.pool.query<DecisionRow>(
      `SELECT d.id, d.draft_id, d.decision_type, d.reason, d.reviewer_id, d.created_at,
              s.english_spelling, s.simplified_chinese_meaning, s.learning_hint,
              s.source_page_id, s.source_revision_id, s.source_revision_timestamp,
              s.source_url, s.license_name, s.license_version, s.license_url, s.attribution
       FROM review_decisions d
       JOIN review_decision_snapshots s ON s.decision_id = d.id
       WHERE d.draft_id = $1
       ORDER BY d.created_at DESC`,
      [draftId],
    );
    return {
      items: result.rows.map((row) => ({
        draftId: row.draft_id,
        spelling: row.english_spelling,
        status: row.decision_type,
        createdAt: row.created_at.toISOString(),
        decisionType: row.decision_type,
        source: sourceOf(row),
      })),
    };
  }

  /** 提交一次不可变审核决定（短事务，10 步）。 */
  async decide(opts: {
    draftId: string;
    reviewerId: string;
    idempotencyKey: string;
    body: ReviewDecisionRequestDto;
    requestId: string;
    expectedVersion?: string;
  }): Promise<ReviewDecisionResponseDto> {
    const type = opts.body.decision as ReviewDecisionType;
    const reason = cleanReason(opts.body.reason, type);
    const edited = opts.body.editedContent ?? {};

    const input = {
      draftId: opts.draftId,
      reviewerId: opts.reviewerId,
      decisionType: type,
      reason,
      englishSpelling: typeof edited.englishSpelling === "string" ? edited.englishSpelling : null,
      simplifiedChineseMeaning:
        typeof edited.simplifiedChineseMeaning === "string"
          ? edited.simplifiedChineseMeaning
          : null,
      learningHint: typeof edited.learningHint === "string" ? edited.learningHint : null,
    };
    const requestHash = reviewRequestHash(input);

    const client = await this.pool.connect();
    await client.query("BEGIN");
    try {
      // (6) idempotency
      const idem = await client.query<{
        request_hash: string;
        response_json: ReviewDecisionResponseDto | null;
      }>(
        `INSERT INTO review_decision_idempotency (reviewer_id, idempotency_key, request_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (reviewer_id, idempotency_key) DO NOTHING
         RETURNING request_hash, response_json`,
        [opts.reviewerId, opts.idempotencyKey, requestHash],
      );
      if (idem.rowCount === 0) {
        const existing = await client.query<{
          request_hash: string;
          response_json: ReviewDecisionResponseDto | null;
        }>(
          `SELECT request_hash, response_json FROM review_decision_idempotency
           WHERE reviewer_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [opts.reviewerId, opts.idempotencyKey],
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== requestHash)
          throw new ConflictException("该 Idempotency-Key 已用于不同的审核请求");
        if (!row.response_json) throw new ConflictException("该审核请求正在处理中，请稍后重试");
        await client.query("ROLLBACK");
        return { ...row.response_json, isIdempotentReplay: true };
      }

      // (1) lock draft, (2) re-read authoritative state — effective reviewable set
      const draft = await client.query<ReviewableRow & { handling_fact_exists: boolean }>(
        `${REVIEWABLE_SELECT.replace(
          "SELECT d.id AS draft_id",
          "SELECT EXISTS (SELECT 1 FROM manual_handling_facts h2 WHERE h2.draft_id = d.id AND h2.next_status='draft_ready') AS handling_fact_exists, d.id AS draft_id",
        )}
           AND d.id = $1
           AND ( ${EFFECTIVE_REVIEWABLE_SQL} )
           FOR UPDATE`,
        [opts.draftId],
      );
      const row = draft.rows[0];
      if (!row) throw new NotFoundException("草稿不存在、未在有效审核投影中或来源尚未完整");

      // (1b) optimistic concurrency: reject a stale expectedVersion with 409 (Fix 1).
      //      The fingerprint is derived from the immutable projection; it is not a
      //      FOR UPDATE substitute, it is the client-echoed reviewVersion contract.
      const currentVersion = projectionVersionOf(row, row.handling_fact_exists);
      if (opts.expectedVersion && opts.expectedVersion !== currentVersion) {
        throw new ConflictException("该草稿的审核投影已变化（stale review）；请刷新后重试");
      }

      // (3) eligibility — draft_ready OR resolvable manual_action in effective projection.
      //     A resolvable manual_action draft has NO meaning (physical NULL); accept is
      //     not valid for it — the reviewer must supply real content via accept_with_edits.
      const isEffectiveManual = row.draft_status === "manual_action";
      if (row.draft_status !== "draft_ready" && !isEffectiveManual) {
        throw new UnprocessableEntityException(describeUnreviewable(row.draft_status));
      }

      // (7) already-decided guard
      const existingDecision = await client.query<{ id: string }>(
        "SELECT id FROM review_decisions WHERE draft_id = $1",
        [opts.draftId],
      );
      if (existingDecision.rowCount) throw new ConflictException("该草稿已经完成审核");

      // (5) normalize + validate edited content (narrow allowlist).
      //     For a resolvable manual_action draft (meaning NULL), accept is invalid —
      //     only accept_with_edits with a real meaning is permitted.
      if (isEffectiveManual && type !== "accept_with_edits") {
        throw new UnprocessableEntityException(
          "该草稿为已人工处理的可补全 manual_action（无原始含义），须以 accept_with_edits 提供真实中文含义",
        );
      }
      const content = normalizeReviewContent(type, {
        simplifiedChineseMeaning:
          type === "accept"
            ? row.draft_meaning
            : type === "reject"
              ? row.draft_meaning // Fix 4: reject snapshot keeps the draft's controlled content if it has any.
              : (input.simplifiedChineseMeaning ?? null),
        learningHint:
          type === "accept"
            ? row.draft_hint
            : type === "reject"
              ? row.draft_hint // Fix 4: preserve draft hint in the reject snapshot when present.
              : (input.learningHint ?? null),
      });
      if (!content.ok) throw new UnprocessableEntityException(content.reason);
      const spelling = (
        type === "accept_with_edits" ? input.englishSpelling : row.spelling
      )?.trim();
      if (!spelling || spelling.length > 1000)
        throw new UnprocessableEntityException("英文拼写不能为空或超长");

      // (4) provenance validity implicitly guaranteed by REVIEWABLE_SELECT joins.
      const decisionHash = reviewDecisionHash({
        draftId: opts.draftId,
        decisionType: type,
        englishSpelling: spelling,
        simplifiedChineseMeaning: content.value.simplifiedChineseMeaning,
        learningHint: content.value.learningHint,
        sourceFactIdentity: row.source_fact_identity,
        sourceRevisionId: row.source_revision_id,
      });

      const decisionId = randomUUID();
      const auditId = randomUUID();
      const contentHash = reviewDecisionHash({
        draftId: opts.draftId,
        decisionType: type,
        englishSpelling: spelling,
        simplifiedChineseMeaning: content.value.simplifiedChineseMeaning,
        learningHint: content.value.learningHint,
        sourceFactIdentity: row.source_fact_identity,
        sourceRevisionId: row.source_revision_id,
      });

      // (9) audit event
      await client.query(
        `INSERT INTO audit_events
           (id, actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, $2, 'admin.review.decision', 'review_decision', $3, $4::jsonb, $5::jsonb, $6)`,
        [
          auditId,
          opts.reviewerId,
          decisionId,
          JSON.stringify({ draftId: opts.draftId, status: "reviewable" }),
          JSON.stringify({ draftId: opts.draftId, decisionType: type, decisionHash }),
          opts.requestId,
        ],
      );

      // (7) decision fact
      await client.query(
        `INSERT INTO review_decisions
          (id, draft_id, reviewer_id, decision_type, reason, decision_hash, request_hash,
           idempotency_key, audit_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          decisionId,
          opts.draftId,
          opts.reviewerId,
          type,
          reason,
          decisionHash,
          requestHash,
          opts.idempotencyKey,
          auditId,
        ],
      );

      // (8) snapshot
      await client.query(
        `INSERT INTO review_decision_snapshots
          (decision_id, draft_id, decision_type, english_spelling, part_of_speech,
           simplified_chinese_meaning, learning_hint, source_fact_identity, source_name,
           source_page_id, source_revision_id, source_revision_timestamp, source_url,
           license_name, license_version, license_url, attribution, configured_model_alias,
           resolved_provider_model, provider_fingerprint, prompt_template_version,
           draft_schema_version, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Wiktionary',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          decisionId,
          opts.draftId,
          type,
          spelling,
          row.part_of_speech,
          content.value.simplifiedChineseMeaning,
          content.value.learningHint,
          row.source_fact_identity,
          row.source_page_id,
          row.source_revision_id,
          row.source_revision_timestamp,
          row.source_url,
          row.license_name,
          row.license_version,
          row.license_url,
          row.attribution,
          row.configured_model_alias,
          row.resolved_provider_model,
          row.provider_fingerprint,
          row.prompt_template_version,
          row.draft_schema_version,
          contentHash,
        ],
      );

      const full = await client.query<DecisionRow>(
        `SELECT d.id, d.draft_id, d.decision_type, d.reason, d.reviewer_id, d.created_at,
                s.english_spelling, s.simplified_chinese_meaning, s.learning_hint,
                s.source_page_id, s.source_revision_id, s.source_revision_timestamp,
                s.source_url, s.license_name, s.license_version, s.license_url, s.attribution
         FROM review_decisions d JOIN review_decision_snapshots s ON s.decision_id = d.id WHERE d.id = $1`,
        [decisionId],
      );
      const response: ReviewDecisionResponseDto = {
        decision: toDecision(full.rows[0]!),
        isIdempotentReplay: false,
      };

      await client.query(
        `UPDATE review_decision_idempotency SET response_json = $3
          WHERE reviewer_id = $1 AND idempotency_key = $2`,
        [opts.reviewerId, opts.idempotencyKey, JSON.stringify(response)],
      );
      await client.query("COMMIT");
      return response;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 人工处理可补全的 manual_action：写入 append-only manual_handling_facts + 审计。
   *
   * 架构性限制（诚实声明）：Ticket 06 enrichment_drafts 是不可变（INSERT-only）事实，
   * 且 manual_action 失败路径【不写草稿行】；(0033 的 enrichment_drafts_no_update
   * BEFORE UPDATE trigger 会 RAISE) 本端点在当前 schema 下无法把不可变草稿 UPDATE 为
   * draft_ready（修改那属于 Ticket 06 核心状态机，超本票范围，且绝不绕过 0033 trigger）。
   * 因此本端点记录【可审计、不可变的人工处理事实】(manual_handling_facts) 与审计事件，
   * 作为「人工已处理该 manual_action」的权威记录（供 Ticket 08 / 未来状态机改造消费），
   * 绝不伪造草稿就绪、不直接放行审核、不绕过 DB trigger。
   *
   * 幂等：以 (draft_id, idempotency_key) 唯一约束为最终防线；重放同 key 同 payload
   * 返回冻结首响应，同 key 不同 payload → 409；重放不新增 handling fact 与 audit event。
   */
  async resolve(opts: {
    draftId: string;
    actorId: string;
    idempotencyKey: string;
    body: Record<string, unknown>;
    requestId: string;
  }): Promise<{ handled: boolean; draftId: string }> {
    // 理由 / 补充摘要：只读白名单字段；非字符串即视为非法。
    const reason = typeof opts.body.reason === "string" ? opts.body.reason.trim() : "";
    if (!reason) throw new UnprocessableEntityException("人工处理必须填写理由");
    if (reason.length > 1000) throw new UnprocessableEntityException("理由长度超限");
    const supplement =
      typeof opts.body.supplementSummary === "string" ? opts.body.supplementSummary : null;
    if (supplement !== null && supplement.length > 500)
      throw new UnprocessableEntityException("补充内容摘要超长");

    const unpublishedInput = {
      draftId: opts.draftId,
      actorId: opts.actorId,
      idempotencyKey: opts.idempotencyKey,
      reason,
      errorCode: null as string | null, // error_code determined under lock
    };
    const client = await this.pool.connect();
    await client.query("BEGIN");
    try {
      const draft = await client.query<{ status: string; error_code: string | null }>(
        `SELECT status, error_code FROM enrichment_drafts WHERE id = $1 FOR UPDATE`,
        [opts.draftId],
      );
      const drow = draft.rows[0];
      if (!drow) throw new NotFoundException("草稿不存在");

      // 必须是 manual_action，且属于可补全类。
      if (drow.status !== "manual_action")
        throw new UnprocessableEntityException("只有处于 manual_action 的草稿可人工处理");
      const cls: ManualActionClass = manualActionClass(drow.error_code);
      if (cls !== "resolvable") {
        if (isNonResolvableManualAction(drow.error_code)) {
          throw new UnprocessableEntityException(
            "该 manual_action 不可经审核直接解除，需上游重跑/修复或归档（产生新事实）",
          );
        }
        throw new UnprocessableEntityException("该 manual_action 不支持人工补全为就绪");
      }

      // 幂等 claim：先查是否已有同 (draft,key) 的 handling fact。
      const existing = await client.query<{ request_hash: string }>(
        `SELECT request_hash FROM manual_handling_facts
         WHERE draft_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [opts.draftId, opts.idempotencyKey],
      );
      unpublishedInput.errorCode = drow.error_code;
      const requestHash = reviewResolveHash({
        draftId: opts.draftId,
        reviewerId: opts.actorId,
        reason,
        supplementSummary: supplement,
        errorCode: drow.error_code,
        handlingKind: "manual_handling",
      });
      if (existing.rowCount) {
        const same = existing.rows[0]!.request_hash === requestHash;
        await client.query("ROLLBACK").catch(() => undefined);
        if (!same) throw new ConflictException("该 Idempotency-Key 已用于不同的人工处理请求");
        // 同 key 同 payload：重放，返回冻结首响应，不新增事实/审计。
        return { handled: true, draftId: opts.draftId };
      }

      const auditId = randomUUID();
      await client.query(
        `INSERT INTO audit_events
           (id, actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, $2, 'admin.review.resolve', 'manual_handling_fact', $3, $4::jsonb, $5::jsonb, $6)`,
        [
          auditId,
          opts.actorId,
          opts.draftId,
          JSON.stringify({ draftId: opts.draftId, status: drow.status, errorCode: cls }),
          JSON.stringify({ draftId: opts.draftId, nextStatus: "draft_ready" }),
          opts.requestId,
        ],
      );

      // 写入 append-only handling fact。UNIQUE(draft_id, idempotency_key) 为并发最终防线。
      await client.query(
        `INSERT INTO manual_handling_facts
           (draft_id, actor_id, handling_kind, reason, previous_status, next_status,
            target_state, request_hash, idempotency_key, audit_event_id, supplement_summary,
            error_code, source_error_summary)
         VALUES ($1, $2, 'manual_handling', $3, 'manual_action', 'draft_ready', 'draft_ready',
                 $4, $5, $6, $7, $8, $9)
         ON CONFLICT (draft_id, idempotency_key) DO NOTHING`,
        [
          opts.draftId,
          opts.actorId,
          reason,
          requestHash,
          opts.idempotencyKey,
          auditId,
          supplement,
          drow.error_code,
          drow.error_code,
        ],
      );

      await client.query("COMMIT");
      return { handled: true, draftId: opts.draftId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
