// 课程/草稿/单元命令：稳定课程 + 唯一 active 草稿 + 单元大纲的查询与写操作。
// 写操作全部走 draftVersion 乐观并发控制，过期版本返回 DRAFT_VERSION_CONFLICT；
// 所有成功写操作在事务内写入审计事件。
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import {
  buildCatalogDetail,
  buildCatalogSummary,
  buildEnrollmentState,
  evaluateDraftPublicationEligibility,
  type ItemProvenanceInput,
  type ReviewDecisionProvenance,
  nextReleaseNumber,
  normalizeSlug,
  resolveReleasedUnitId,
  validateCourseDescription,
  validateCourseLevel,
  validateCourseTitle,
  validateCourseDraft,
  validateItemHint,
  validateItemMeaning,
  validateSlug,
  validateUnitDescription,
  validateUnitOrder,
  validateUnitTitle,
  type UnitSnapshot,
  type ValidateDraftInput,
} from "@motro/domain";
import type { Pool, PoolClient } from "pg";
import { POOL } from "../../../auth/database.provider.js";
import type { UserRecord } from "../../../auth/session.service.js";
import type {
  CatalogCourseDetailDto,
  CatalogCourseListResponseDto,
  CourseDraftDetailDto,
  CourseListItemDto,
  CourseValidationResultDto,
  CreateCourseResultDto,
  ItemDto,
  PublishReleaseResultDto,
  ReleaseListItemDto,
  UnitDto,
} from "./dto.js";

// ---- 学习者目录 keyset 分页 ----
// 排序固定为 `release_number DESC, course_id ASC`。游标编码上一页末条的排序边界
// (releaseNumber, courseId)，下一页用 keyset 谓词继续，不使用 offset。
export const CATALOG_DEFAULT_LIMIT = 24;
export const CATALOG_MAX_LIMIT = 50;

export interface CatalogCursor {
  releaseNumber: number;
  courseId: string;
}

const CURSOR_PREFIX = "motro.catalog.course.v1";
const UUID_HEX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 把排序边界编码为不透明游标（base64url JSON，带版本前缀）。 */
export function encodeCatalogCursor(cursor: CatalogCursor): string {
  const payload = Buffer.from(
    `${CURSOR_PREFIX}.${JSON.stringify({
      r: cursor.releaseNumber,
      c: cursor.courseId,
    })}`,
    "utf8",
  ).toString("base64url");
  return payload;
}

/**
 * 解码不透明游标；非法/不可解密/字段缺失 → 返回 null（调用方转 422）。
 * 绝不因解码错误回落默认，把非法游标当空处理会泄露边界。
 */
export function decodeCatalogCursor(encoded: string): CatalogCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!decoded.startsWith(`${CURSOR_PREFIX}.`)) return null;
  const json = decoded.slice(CURSOR_PREFIX.length + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const obj = parsed as { r?: unknown; c?: unknown };
  if (typeof obj.r !== "number" || !Number.isInteger(obj.r) || obj.r < 1) return null;
  if (typeof obj.c !== "string" || !UUID_HEX_RE.test(obj.c)) return null;
  return { releaseNumber: obj.r, courseId: obj.c };
}

/** 草稿版本冲突：服务端当前版本随异常携带，供控制器返回 409 信封。 */
export class DraftVersionConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super("草稿版本冲突");
    this.name = "DraftVersionConflictError";
  }
}

/** 相同幂等键的请求仍在处理中：等待超时后返回 409 IDEMPOTENCY_IN_PROGRESS（可重试）。 */
export class IdempotencyInProgressError extends Error {
  constructor() {
    super("相同幂等键的请求正在处理中");
    this.name = "IdempotencyInProgressError";
  }
}

const IDEMPOTENCY_WAIT_MS = 3000;

function isPendingIdempotencyResponse(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { pending?: boolean }).pending === true
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CourseRow {
  id: string;
  slug: string;
  title: string;
  level: string;
  description: string;
  visibility: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface DraftRow {
  id: string;
  course_id: string;
  version: number;
  title: string;
  level: string;
  description: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface UnitRow {
  id: string;
  draft_id: string;
  position: number;
  title: string;
  description: string;
  created_at: Date;
  updated_at: Date;
}

interface DraftListRow extends CourseRow {
  draft_id: string | null;
  draft_version: number | null;
  draft_title: string | null;
  draft_level: string | null;
  draft_description: string | null;
  draft_updated_at: Date | null;
}

export interface CreateCourseInput {
  slug: string;
  title: string;
  level: string | undefined;
  description: string | undefined;
}

export interface UpdateDraftInput {
  slug: string | undefined;
  title: string | undefined;
  level: string | undefined;
  description: string | undefined;
}

export interface CreateUnitInput {
  title: string;
  description: string | undefined;
}

export interface UpdateUnitInput {
  title: string | undefined;
  description: string | undefined;
}

export interface CreateItemInput {
  unitId: string;
  lexicalEntryId: string;
  meaning: string;
  hint: string | undefined;
  /** Ticket 08 语义桥 Path B：可选提供 Ticket 07 review decision 引用，
      该词项的 meaning 视为来自 accepted 审核内容而非手工输入。 */
  reviewDecisionId: string | undefined;
}

export interface UpdateItemInput {
  meaning: string | undefined;
  hint: string | undefined;
  unitId: string | undefined;
}

export interface PublishReleaseInput {
  draftVersion: number;
  releaseNote: string | undefined;
  validationToken: string | undefined;
}

interface ReleaseCopyRow {
  unit_id: string | null;
  unit_position: number | null;
  unit_title: string | null;
  unit_description: string | null;
  item_id: string | null;
  item_position: number | null;
  meaning: string | null;
  hint: string | null;
  lexical_entry_id: string | null;
  content_review_reference: string | null;
  english_spelling: string | null;
  // ---- Ticket 08 provenance bridge (frozen into release) ----
  provenance_kind: string | null;
  review_decision_id: string | null;
}

interface ReleaseListRow {
  id: string;
  release_number: number;
  title: string;
  level: string;
  description: string;
  content_hash: string;
  source_draft_version: number;
  release_note: string;
  created_by_username: string;
  created_at: Date;
  is_current: boolean;
}

interface ItemRow {
  id: string;
  draft_unit_id: string;
  lexical_entry_id: string;
  position: number;
  meaning: string;
  hint: string | null;
  content_review_reference: string;
  created_at: Date;
  updated_at: Date;
  canonical_spelling: string;
  normalized_spelling: string;
  source_status: string | null;
  // ---- Ticket 08 provenance bridge ----
  provenance_kind: string | null;
  review_decision_id: string | null;
}

interface CatalogCourseRow {
  course_id: string;
  release_id: string;
  release_number: number;
  title: string;
  level: string;
  description: string;
  enrolled_active: boolean | null;
  enrolled_primary: boolean | null;
}

interface ValidationRow {
  version: number;
  title: string;
  unit_id: string | null;
  unit_position: number | null;
  unit_title: string | null;
  unit_description: string | null;
  item_id: string | null;
  item_position: number | null;
  meaning: string | null;
  hint: string | null;
  lexical_entry_id: string | null;
  content_review_reference: string | null;
  lexical_entry_exists: boolean;
  content_review_valid: boolean;
  // ---- Ticket 08 provenance bridge ----
  provenance_kind: string | null;
  review_decision_id: string | null;
  review_decision_type: string | null;
  /** Original enrichment_drafts.status this decision was minted on. */
  review_draft_status: string | null;
  review_provenance_complete: boolean;
  review_handled: boolean;
  review_conflicting: boolean;
  /** True if snapshot source fact is fetched. */
  review_source_fact_fetched: boolean;
  /** True if snapshot source fact carries a content_hash. */
  review_source_fact_hash_present: boolean;
  /** True if snapshot.english_spelling == current lexical canonical_spelling. */
  review_snapshot_spelling_matches: boolean;
  /** True if source_fact.normalized_spelling == current lexical normalized_spelling. */
  review_normalized_spelling_matches: boolean;
  /** True if snapshot.source_fact_identity == draft.wiktionary_source_fact_id. */
  review_source_fact_identity_matches: boolean;
  /** True if source_fact.commit_row_id == draft.import_batch_commit_row_id. */
  review_commit_row_matches: boolean;
  /** True if snapshot page/revision == source fact page/revision. */
  review_revision_page_consistent: boolean;
}

const VALIDATION_SQL = `SELECT d.version, d.title,
        u.id AS unit_id, u.position AS unit_position, u.title AS unit_title,
        u.description AS unit_description,
        i.id AS item_id, i.position AS item_position, i.meaning, i.hint,
        i.lexical_entry_id, i.content_review_reference,
        i.provenance_kind,
        i.review_decision_id,
        rd.decision_type AS review_decision_type,
        -- P1-1: original draft status (draft_ready vs manual_action vs other)
        ed.status AS review_draft_status,
        -- provenance complete: snapshot carries source + revision + license + attribution
        (s.source_fact_identity IS NOT NULL
           AND s.source_revision_id IS NOT NULL
           AND NULLIF(s.license_name, '') IS NOT NULL
           AND NULLIF(s.license_url, '') IS NOT NULL
           AND NULLIF(s.attribution, '') IS NOT NULL) AS review_provenance_complete,
        -- handled: resolvable manual_action with a complete handling fact
        EXISTS (
          SELECT 1 FROM manual_handling_facts h
          WHERE h.draft_id = rd.draft_id AND h.next_status = 'draft_ready'
        ) AS review_handled,
        -- conflicting: this review_decision_id was already used by another draft item
        EXISTS (
          SELECT 1 FROM draft_course_items other
          WHERE other.review_decision_id = i.review_decision_id
            AND other.id <> i.id
        ) AS review_conflicting,
        -- final P1: source fact fetched + content_hash present
        (sf.status = 'fetched') AS review_source_fact_fetched,
        (sf.content_hash IS NOT NULL AND length(sf.content_hash) = 64) AS review_source_fact_hash_present,
        -- final P1: identity bindings.  e = current lexical entry, i = course item,
        -- ed = enrichment draft, s = review snapshot, sf = source fact.
        -- snapshot.english_spelling == current lexical canonical_spelling
        (s.english_spelling = e.canonical_spelling) AS review_snapshot_spelling_matches,
        -- source_fact.normalized_spelling == current lexical normalized_spelling
        (sf.normalized_spelling = e.normalized_spelling) AS review_normalized_spelling_matches,
        -- snapshot.source_fact_identity == draft.wiktionary_source_fact_id
        (s.source_fact_identity = ed.wiktionary_source_fact_id) AS review_source_fact_identity_matches,
        -- source_fact.commit_row_id == draft.import_batch_commit_row_id
        (sf.commit_row_id = ed.import_batch_commit_row_id) AS review_commit_row_matches,
        -- snapshot page/revision identity == source fact page/revision identity
        (s.source_page_id = sf.page_id
         AND s.source_revision_id = sf.revision_id) AS review_revision_page_consistent,
        (e.id IS NOT NULL) AS lexical_entry_exists,
        (a.id IS NOT NULL) AS content_review_valid
 FROM course_drafts d
 LEFT JOIN draft_units u ON u.draft_id = d.id
 LEFT JOIN draft_course_items i ON i.draft_unit_id = u.id
 LEFT JOIN lexical_entries e ON e.id = i.lexical_entry_id
 LEFT JOIN audit_events a ON a.id = i.content_review_reference
 LEFT JOIN review_decisions rd ON rd.id = i.review_decision_id
 LEFT JOIN review_decision_snapshots s ON s.decision_id = rd.id
 LEFT JOIN enrichment_drafts ed ON ed.id = rd.draft_id
 LEFT JOIN wiktionary_source_facts sf ON sf.source_fact_identity = s.source_fact_identity
 WHERE d.course_id = $1 AND d.status = 'active'
 ORDER BY u.position ASC, u.id ASC, i.position ASC, i.id ASC`;

/** 把校验查询行聚合成领域校验输入（纯函数）。 */
function buildSnapshotFromRows(rows: ValidationRow[]): ValidateDraftInput | null {
  const first = rows[0];
  if (!first) return null;
  const units: UnitSnapshot[] = [];
  const unitsById = new Map<string, UnitSnapshot>();
  for (const row of rows) {
    if (!row.unit_id) continue;
    let unit = unitsById.get(row.unit_id);
    if (!unit) {
      unit = {
        id: row.unit_id,
        position: row.unit_position ?? 0,
        title: row.unit_title ?? "",
        description: row.unit_description ?? "",
        items: [],
      };
      unitsById.set(row.unit_id, unit);
      units.push(unit);
    }
    if (row.item_id) {
      unit.items.push({
        id: row.item_id,
        position: row.item_position ?? 0,
        meaning: row.meaning ?? "",
        hint: row.hint,
        lexicalEntryId: row.lexical_entry_id ?? "",
        lexicalEntryExists: row.lexical_entry_exists,
        contentReviewReference: row.content_review_reference ?? "",
        contentReviewValid: row.content_review_valid,
        provenanceKind: row.provenance_kind === "review" ? "review" : "manual",
        reviewDecisionId: row.review_decision_id ?? null,
        reviewDecisionType:
          row.review_decision_type === "accept" ||
          row.review_decision_type === "accept_with_edits" ||
          row.review_decision_type === "reject"
            ? row.review_decision_type
            : null,
        reviewProvenanceComplete: row.review_provenance_complete,
        reviewHandled: row.review_handled,
        reviewConflicting: row.review_conflicting,
        reviewDraftStatus:
          row.review_draft_status === "draft_ready" || row.review_draft_status === "manual_action"
            ? row.review_draft_status
            : "other",
        reviewSourceFactFetched: row.review_source_fact_fetched,
        reviewSnapshotSpellingMatches: row.review_snapshot_spelling_matches,
        reviewNormalizedSpellingMatches: row.review_normalized_spelling_matches,
        reviewSourceFactIdentityMatches: row.review_source_fact_identity_matches,
        reviewCommitRowMatches: row.review_commit_row_matches,
        reviewRevisionPageConsistent: row.review_revision_page_consistent,
        reviewSourceFactHashPresent: row.review_source_fact_hash_present,
      });
    }
  }
  units.sort((a, b) => a.position - b.position);
  return { draftVersion: first.version, title: first.title, units };
}

/** 把发布资格领域规则应用到草稿快照的每个词项，返回阻断 issue（Ticket 08）。 */
function collectEligibilityIssues(
  snapshot: ValidateDraftInput,
): ReturnType<typeof evaluateDraftPublicationEligibility> {
  const items: ItemProvenanceInput[] = snapshot.units.flatMap((u) =>
    u.items.map((item) => ({
      itemId: item.id,
      provenanceKind: item.provenanceKind,
      contentReviewValid: item.contentReviewValid,
      lexicalEntryExists: item.lexicalEntryExists,
      reviewDecision: item.reviewDecisionId
        ? ({
            decisionType: item.reviewDecisionType ?? "reject",
            // P1-1: pass the ORIGINAL draft status; handling requirement is decided by it.
            draftStatus:
              item.reviewDraftStatus === "draft_ready" || item.reviewDraftStatus === "manual_action"
                ? (item.reviewDraftStatus as "draft_ready" | "manual_action")
                : "other",
            provenanceComplete: item.reviewProvenanceComplete,
            handled: item.reviewHandled,
            sourceFactFetched: item.reviewSourceFactFetched,
            snapshotSpellingMatches: item.reviewSnapshotSpellingMatches,
            normalizedSpellingMatches: item.reviewNormalizedSpellingMatches,
            sourceFactIdentityMatches: item.reviewSourceFactIdentityMatches,
            commitRowMatches: item.reviewCommitRowMatches,
            revisionPageConsistent: item.reviewRevisionPageConsistent,
            sourceFactContentHashPresent: item.reviewSourceFactHashPresent,
            conflictingDecision: item.reviewConflicting,
          } satisfies ReviewDecisionProvenance)
        : null,
    })),
  );
  return evaluateDraftPublicationEligibility(items);
}

@Injectable()
export class CourseService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async listCourses(): Promise<CourseListItemDto[]> {
    const result = await this.pool.query<DraftListRow>(
      `SELECT c.id, c.slug, c.title, c.level, c.description, c.visibility, c.status,
              c.created_at, c.updated_at,
              d.id AS draft_id, d.version AS draft_version, d.title AS draft_title,
              d.level AS draft_level, d.description AS draft_description, d.updated_at AS draft_updated_at
       FROM courses c
       LEFT JOIN course_drafts d ON d.course_id = c.id AND d.status = 'active'
       ORDER BY c.created_at ASC, c.id ASC`,
    );
    return result.rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.draft_title ?? r.title,
      level: r.draft_level ?? r.level,
      description: r.draft_description ?? r.description,
      visibility: r.visibility,
      status: r.status,
      draftId: r.draft_id,
      draftVersion: r.draft_version,
      updatedAt: (r.draft_updated_at ?? r.updated_at).toISOString(),
    }));
  }

  /** 学习者目录列表：只读可见课程的 current release，不读草稿；支持 keyset 游标分页。 */
  async listCatalogCourses(
    userId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<CatalogCourseListResponseDto> {
    const limit = Math.min(Math.max(opts.limit ?? CATALOG_DEFAULT_LIMIT, 1), CATALOG_MAX_LIMIT);
    // 显式提供但无法解码的 cursor → 422，绝不回落默认（把非法边界当空首屏会跳过课程）。
    let parsedCursor: CatalogCursor | null = null;
    if (opts.cursor !== undefined) {
      parsedCursor = decodeCatalogCursor(opts.cursor);
      if (parsedCursor === null) {
        throw new UnprocessableEntityException({
          message: "分页游标无效",
          fieldErrors: [{ path: "cursor", code: "invalid", message: "分页游标无效或已过期" }],
        });
      }
    }
    const pgLimit = limit + 1;

    let sql: string;
    let params: unknown[];

    if (parsedCursor) {
      // keyset 谓词：ORDER BY r.release_number DESC, c.id ASC
      //   同 release_number 内取 courseId > 游标 courseId（升序）；
      //   release_number 小于游标的全部保留（DESC 越小越靠后）。
      sql = `SELECT c.id AS course_id, r.id AS release_id, r.release_number, r.title, r.level, r.description,
                    e.active AS enrolled_active, e.is_primary AS enrolled_primary
             FROM courses c
             JOIN course_releases r ON r.id = c.current_release_id
             LEFT JOIN course_enrollments e ON e.course_id = c.id AND e.user_id = $1
             WHERE c.visibility = 'published' AND c.status = 'active'
               AND (r.release_number < $2
                    OR (r.release_number = $2 AND c.id > $3))
             ORDER BY r.release_number DESC, c.id ASC
             LIMIT $4`;
      params = [userId, parsedCursor.releaseNumber, parsedCursor.courseId, pgLimit];
    } else {
      sql = `SELECT c.id AS course_id, r.id AS release_id, r.release_number, r.title, r.level, r.description,
                    e.active AS enrolled_active, e.is_primary AS enrolled_primary
             FROM courses c
             JOIN course_releases r ON r.id = c.current_release_id
             LEFT JOIN course_enrollments e ON e.course_id = c.id AND e.user_id = $1
             WHERE c.visibility = 'published' AND c.status = 'active'
             ORDER BY r.release_number DESC, c.id ASC
             LIMIT $2`;
      params = [userId, pgLimit];
    }

    const result = await this.pool.query<CatalogCourseRow>(sql, params);
    const rows = result.rows;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = items[items.length - 1]!;
      nextCursor = encodeCatalogCursor({
        releaseNumber: last.release_number,
        courseId: last.course_id,
      });
    }

    return {
      items: items.map((row) => {
        const enrollment =
          row.enrolled_active !== null
            ? buildEnrollmentState({
                active: row.enrolled_active,
                is_primary: row.enrolled_primary ?? false,
              })
            : undefined;
        return buildCatalogSummary({
          courseId: row.course_id,
          title: row.title,
          level: row.level,
          description: row.description,
          releaseId: row.release_id,
          releaseNumber: row.release_number,
          enrollment,
        });
      }),
      nextCursor,
      hasMore,
    };
  }

  /** 学习者目录详情：当前 release + 有序单元概要；无 current release/不可见 → 隐藏资源 404。 */
  async getCatalogCourse(userId: string, courseId: string): Promise<CatalogCourseDetailDto> {
    const result = await this.pool.query<CatalogCourseRow>(
      `SELECT c.id AS course_id, r.id AS release_id, r.release_number, r.title, r.level, r.description,
              e.active AS enrolled_active, e.is_primary AS enrolled_primary
       FROM courses c
       JOIN course_releases r ON r.id = c.current_release_id
       LEFT JOIN course_enrollments e ON e.course_id = c.id AND e.user_id = $1
       WHERE c.id = $2 AND c.visibility = 'published' AND c.status = 'active'`,
      [userId, courseId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("课程不存在"); // 隐藏资源 404

    const units = await this.pool.query<{
      unit_id: string;
      position: number;
      title: string;
      description: string;
    }>(
      `SELECT unit_id, position, title, description FROM released_units
       WHERE release_id = $1 ORDER BY position ASC, unit_id ASC`,
      [row.release_id],
    );
    const enrollment =
      row.enrolled_active !== null
        ? buildEnrollmentState({
            active: row.enrolled_active,
            is_primary: row.enrolled_primary ?? false,
          })
        : undefined;
    return buildCatalogDetail(
      {
        courseId: row.course_id,
        title: row.title,
        level: row.level,
        description: row.description,
        releaseId: row.release_id,
        releaseNumber: row.release_number,
        enrollment,
      },
      units.rows.map((u) => ({
        unitId: u.unit_id,
        position: u.position,
        title: u.title,
        description: u.description,
      })),
    );
  }

  /** 加入已发布课程（幂等）：重复报名返回已有报名，不重复建行；可带 makePrimary。 */
  async enroll(
    userId: string,
    courseId: string,
    makePrimary: boolean,
  ): Promise<CatalogCourseDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 首次设主路径先取每用户 advisory 事务锁，再碰任何行锁/插入，
      // 与 setPrimaryCourse 共用同一把锁：串行化并发“报名并设主”，
      // 避免插入行锁与 FOR UPDATE 扫描顺序不同造成死锁或唯一索引冲突。
      if (makePrimary) {
        await this.lockUserPrimarySwitch(client, userId);
      }
      // 目标课程必须可见且有 current release，否则安全 404。
      const course = await client.query<{ course_id: string }>(
        `SELECT c.id AS course_id
         FROM courses c JOIN course_releases r ON r.id = c.current_release_id
         WHERE c.id = $1 AND c.visibility = 'published' AND c.status = 'active'`,
        [courseId],
      );
      if (!course.rows[0]) throw new NotFoundException("课程不存在");

      // 幂等报名：已存在 active 报名则不重复插入；软停用则重新激活。
      const upserted = await client.query<{ id: string; is_primary: boolean }>(
        `INSERT INTO course_enrollments (user_id, course_id, active)
         VALUES ($1, $2, true)
         ON CONFLICT (user_id, course_id) DO UPDATE SET active = true, updated_at = now()
         RETURNING id, is_primary`,
        [userId, courseId],
      );
      if (makePrimary && !upserted.rows[0]?.is_primary) {
        await this.setPrimaryInTransaction(client, userId, courseId);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.getCatalogCourse(userId, courseId);
  }

  /** 把一门已报名课程设为主课程：事务内清除旧 primary 并设置新 primary。 */
  async setPrimaryCourse(userId: string, courseId: string): Promise<CatalogCourseDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 每用户一把 advisory 事务锁，先于任何行锁获取：所有主课程切换在此串行化，
      // partial unique index 是并发场景的最终防线。锁失败会随事务回滚自动释放。
      await this.lockUserPrimarySwitch(client, userId);
      // 目标课程必须可见且有 current release，否则安全 404。
      const course = await client.query<{ course_id: string }>(
        `SELECT c.id AS course_id
         FROM courses c JOIN course_releases r ON r.id = c.current_release_id
         WHERE c.id = $1 AND c.visibility = 'published' AND c.status = 'active'`,
        [courseId],
      );
      if (!course.rows[0]) throw new NotFoundException("课程不存在");

      // 锁定用户全部报名行，串行化并发主课程切换（advisory 锁已串行，行锁保证读一致）。
      const enrollments = await client.query<{ course_id: string; active: boolean }>(
        `SELECT course_id, active FROM course_enrollments WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const target = enrollments.rows.find((e) => e.course_id === courseId && e.active);
      if (!target) {
        throw new ConflictException("未报名该课程，无法设为主课程");
      }
      await this.setPrimaryInTransaction(client, userId, courseId);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.getCatalogCourse(userId, courseId);
  }

  /** 事务内获取每用户 advisory 锁：所有主课程切换（enroll 首次设主 + setPrimaryCourse）在此串行化。 */
  private async lockUserPrimarySwitch(client: PoolClient, userId: string): Promise<void> {
    // hashtextextended(text, bigint) 把 userId 映射为稳定的 int8 advisory 键；
    // 事务锁随 COMMIT/ROLLBACK 自动释放，不会因连接池复用而泄漏。
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [userId]);
  }

  /** 事务内：清除用户所有 active primary，再把目标课程报名置为 primary。 */
  private async setPrimaryInTransaction(
    client: PoolClient,
    userId: string,
    courseId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE course_enrollments SET is_primary = false, updated_at = now()
       WHERE user_id = $1 AND active = true AND is_primary = true`,
      [userId],
    );
    await client.query(
      `UPDATE course_enrollments SET is_primary = true, updated_at = now()
       WHERE user_id = $1 AND course_id = $2 AND active = true`,
      [userId, courseId],
    );
  }

  async createCourse(
    actor: UserRecord,
    input: CreateCourseInput,
    requestId: string,
  ): Promise<CreateCourseResultDto> {
    const slug = normalizeSlug(input.slug);
    const title = input.title.trim();
    const level = (input.level ?? "a1").trim();
    const description = input.description?.trim() ?? "";

    const fieldErrors: { path: string; code: string; message: string }[] = [];
    for (const message of validateSlug(slug)) {
      fieldErrors.push({ path: "slug", code: "invalid", message });
    }
    for (const message of validateCourseTitle(title)) {
      fieldErrors.push({ path: "title", code: "invalid", message });
    }
    for (const message of validateCourseLevel(level)) {
      fieldErrors.push({ path: "level", code: "invalid", message });
    }
    for (const message of validateCourseDescription(description)) {
      fieldErrors.push({ path: "description", code: "invalid", message });
    }
    if (fieldErrors.length > 0) {
      throw new UnprocessableEntityException({ message: "课程输入不合法", fieldErrors });
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 唯一索引兜底并发：ON CONFLICT DO NOTHING 无返回行即 slug 已被占用。
      const inserted = await client.query<CourseRow>(
        `INSERT INTO courses (slug, title, level, description) VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id, slug, title, level, description, visibility, status, created_at, updated_at`,
        [slug, title, level, description],
      );
      const course = inserted.rows[0];
      if (!course) {
        throw new ConflictException({
          message: "slug 已存在",
          fieldErrors: [{ path: "slug", code: "duplicate", message: "slug 已被其他课程使用" }],
        });
      }
      const draft = await client.query<DraftRow>(
        `INSERT INTO course_drafts (course_id, version, title, level, description)
         VALUES ($1, 1, $2, $3, $4)
         RETURNING id, course_id, version, title, level, description, status, created_at, updated_at`,
        [course.id, title, level, description],
      );
      const draftId = draft.rows[0]?.id ?? "";
      await this.audit(
        client,
        actor.id,
        "admin.course.create",
        "course",
        course.id,
        { slug, draftVersion: 1 },
        requestId,
      );
      // 初始草稿的独立审计，与课程创建处于同一事务；任一步失败整体回滚。
      await this.audit(
        client,
        actor.id,
        "admin.course.draft.create",
        "course_draft",
        draftId,
        { courseId: course.id, draftVersion: 1, status: "active" },
        requestId,
      );
      await client.query("COMMIT");
      return {
        courseId: course.id,
        draftId,
        draftVersion: 1,
        slug,
        title,
        level,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getDraft(courseId: string): Promise<CourseDraftDetailDto> {
    const detail = await this.loadDraftDetail(courseId);
    if (!detail) throw new NotFoundException("课程或草稿不存在");
    return detail;
  }

  /** 只读校验：不修改草稿、不创建 release、不改变 current-release，从当前草稿即时计算。 */
  async validateCourse(courseId: string): Promise<CourseValidationResultDto> {
    const rows = (await this.pool.query<ValidationRow>(VALIDATION_SQL, [courseId])).rows;
    const input = buildSnapshotFromRows(rows);
    if (!input) throw new NotFoundException("课程或草稿不存在");
    const outcome = validateCourseDraft(input);
    // Ticket 08：发布资格（accepted/provenance 语义桥）作为阻断错误并入。
    const eligibility = collectEligibilityIssues(input);
    const allBlocking = [...outcome.blockingErrors, ...eligibility.issues];
    return {
      draftVersion: outcome.draftVersion,
      isPublishable: outcome.isPublishable && eligibility.isEligible,
      blockingErrors: allBlocking,
      warnings: outcome.warnings,
      diffSummary: outcome.diffSummary,
      affectedLearnerCount: 0,
      validatedAt: new Date().toISOString(),
      contentHash: outcome.contentHash,
      validationToken: `${outcome.draftVersion}.${outcome.contentHash.slice(0, 12)}`,
    };
  }

  /** 发布不可变版本（幂等）：锁草稿 → 校验 → 分配编号 → 复制快照 → 更新指针 → 审计。 */
  async publishRelease(
    actor: UserRecord,
    courseId: string,
    input: PublishReleaseInput,
    idempotencyKey: string | undefined,
    requestId: string,
  ): Promise<PublishReleaseResultDto> {
    if (!idempotencyKey) throw new BadRequestException("缺少 Idempotency-Key 头");
    const scope = `admin:publish-release:${courseId}`;
    const requestHash = this.requestHashOf({
      draftVersion: input.draftVersion,
      releaseNote: input.releaseNote ?? "",
      validationToken: input.validationToken ?? null,
    });
    const claimed = await this.claimIdempotency(scope, idempotencyKey, requestHash);
    if (claimed !== "claimed") return claimed as PublishReleaseResultDto;
    try {
      // 幂等响应在发布事务内原子写入：release 与 response_json 同事务提交。
      return await this.doPublishRelease(actor, courseId, input, requestId, scope, idempotencyKey);
    } catch (err) {
      // 发布事务失败：清理 key 允许重新尝试。
      await this.releaseIdempotency(scope, idempotencyKey).catch(() => undefined);
      throw err;
    }
  }

  private async doPublishRelease(
    actor: UserRecord,
    courseId: string,
    input: PublishReleaseInput,
    requestId: string,
    idempotencyScope: string,
    idempotencyKey: string,
  ): Promise<PublishReleaseResultDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draft = await this.lockActiveDraft(client, courseId);
      if (!draft) throw new NotFoundException("课程或草稿不存在");
      if (draft.version !== input.draftVersion) throw new DraftVersionConflictError(draft.version);

      // 重新执行 blocking validation。
      const rows = (await client.query<ValidationRow>(VALIDATION_SQL, [courseId])).rows;
      const snapshot = buildSnapshotFromRows(rows);
      if (!snapshot) throw new NotFoundException("课程或草稿不存在");
      const outcome = validateCourseDraft(snapshot);
      // Ticket 08：发布资格（accepted 审核决定 / provenance 语义桥）必须在发布事务内重检，
      // fail-closed —— 任何阻断 item 使整个发布回滚，绝不发布不完整/未审核/来源不完整内容。
      const eligibility = collectEligibilityIssues(snapshot);
      const allBlocking = [...outcome.blockingErrors, ...eligibility.issues];
      if (!outcome.isPublishable || !eligibility.isEligible) {
        throw new UnprocessableEntityException({
          message: "草稿存在阻断错误或发布资格不满足，无法发布",
          fieldErrors: allBlocking.map((e) => ({
            path: e.path,
            code: e.code,
            message: e.message,
          })),
        });
      }
      // 校验 validationToken（如果提供）。
      if (input.validationToken) {
        const expected = `${draft.version}.${outcome.contentHash.slice(0, 12)}`;
        if (input.validationToken !== expected) {
          throw new ConflictException("validationToken 与当前草稿不匹配，请重新校验后发布");
        }
      }

      // 分配下一个 release_number。
      const releaseNumber = nextReleaseNumber(await this.loadReleaseNumbers(client, courseId));

      // 复制完整快照。
      const release = await client.query<{
        id: string;
        created_at: Date;
      }>(
        `INSERT INTO course_releases
           (course_id, release_number, title, level, description, source_draft_version, content_hash, release_note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, created_at`,
        [
          courseId,
          releaseNumber,
          draft.title,
          draft.level,
          draft.description,
          draft.version,
          outcome.contentHash,
          input.releaseNote?.trim() ?? "",
          actor.id,
        ],
      );
      const releaseId = release.rows[0]?.id;
      if (!releaseId) throw new Error("发布版本插入失败");

      const copyRows = (
        await client.query<ReleaseCopyRow>(
          `SELECT u.id AS unit_id, u.position AS unit_position, u.title AS unit_title,
                  u.description AS unit_description,
                  i.id AS item_id, i.position AS item_position, i.meaning, i.hint,
                  i.lexical_entry_id, i.content_review_reference,
                  i.provenance_kind, i.review_decision_id,
                  e.canonical_spelling AS english_spelling
           FROM draft_units u
           LEFT JOIN draft_course_items i ON i.draft_unit_id = u.id
           LEFT JOIN lexical_entries e ON e.id = i.lexical_entry_id
           WHERE u.draft_id = $1
           ORDER BY u.position ASC, u.id ASC, i.position ASC, i.id ASC`,
          [draft.id],
        )
      ).rows;

      // 服务内映射：draft unit → 该 unit 在本次发布中生成的 released_unit 主键。
      // 同一 draft unit 只复制一条 released_units；同单元多个 course 词项全部复用该 id
      // 写 released_course_items。先前逐行依赖「INSERT RETURNING」在第二行即因
      // ON CONFLICT DO NOTHING 无返回行而跳过词项复制（P1 缺陷），现改为服务内映射。
      // 不引入 ON CONFLICT DO UPDATE（released_units/released_course_items 有不可变 UPDATE trigger）。
      const releasedUnitIds = new Map<string, string>();
      for (const row of copyRows) {
        if (!row.unit_id) continue;
        let releasedUnitId: string;
        if (releasedUnitIds.has(row.unit_id)) {
          releasedUnitId = releasedUnitIds.get(row.unit_id)!;
        } else {
          const unitInsert = await client.query<{ id: string }>(
            `INSERT INTO released_units (release_id, unit_id, position, title, description)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (release_id, unit_id) DO NOTHING
             RETURNING id`,
            [releaseId, row.unit_id, row.unit_position, row.unit_title, row.unit_description],
          );
          // 失败路径：INSERT 未返回 id → 抛异常让外层发布事务回滚，绝不提交不完整 release。
          releasedUnitId = resolveReleasedUnitId(row.unit_id, unitInsert, releasedUnitIds);
        }
        if (row.item_id) {
          await client.query(
            `INSERT INTO released_course_items
               (release_id, released_unit_id, course_item_id, lexical_entry_id, position,
                english_spelling, meaning, hint, content_review_reference, provenance_kind, review_decision_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (release_id, course_item_id) DO NOTHING`,
            [
              releaseId,
              releasedUnitId,
              row.item_id,
              row.lexical_entry_id,
              row.item_position,
              row.english_spelling,
              row.meaning,
              row.hint,
              row.content_review_reference,
              row.provenance_kind === "review" ? "review" : "manual",
              row.review_decision_id ?? null,
            ],
          );
        }
      }

      // 更新 current pointer、可见性（发布后对学习者可见）与草稿 based-on。
      await client.query(
        `UPDATE courses SET current_release_id = $2, visibility = 'published', updated_at = now() WHERE id = $1`,
        [courseId, releaseId],
      );
      await client.query(`UPDATE course_drafts SET based_on_release_id = $2 WHERE id = $1`, [
        draft.id,
        releaseId,
      ]);

      await this.audit(
        client,
        actor.id,
        "admin.course.release.create",
        "course",
        courseId,
        { releaseId, releaseNumber, sourceDraftVersion: draft.version },
        requestId,
      );
      // 幂等响应与 release 在同一事务内原子提交：任一失败整体回滚，
      // 避免“release 已创建但 response 缺失”导致 key 永久 pending。
      const result: PublishReleaseResultDto = {
        releaseId,
        releaseNumber,
        contentHash: outcome.contentHash,
        currentReleaseId: releaseId,
        createdAt: release.rows[0]?.created_at.toISOString() ?? new Date().toISOString(),
      };
      await client.query(
        `UPDATE idempotency_keys SET response_json = $3, resource_id = $4 WHERE scope = $1 AND key = $2`,
        [idempotencyScope, idempotencyKey, JSON.stringify(result), releaseId],
      );
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listReleases(courseId: string): Promise<{ items: ReleaseListItemDto[] }> {
    const result = await this.pool.query<ReleaseListRow>(
      `SELECT r.id, r.release_number, r.title, r.level, r.description, r.content_hash,
              r.source_draft_version, r.release_note, r.created_at,
              u.username AS created_by_username,
              (c.current_release_id = r.id) AS is_current
       FROM course_releases r
       JOIN courses c ON c.id = r.course_id
       JOIN users u ON u.id = r.created_by
       WHERE r.course_id = $1
       ORDER BY r.release_number DESC`,
      [courseId],
    );
    return {
      items: result.rows.map((r) => ({
        id: r.id,
        releaseNumber: r.release_number,
        title: r.title,
        level: r.level,
        description: r.description,
        contentHash: r.content_hash,
        sourceDraftVersion: r.source_draft_version,
        releaseNote: r.release_note,
        createdByUsername: r.created_by_username,
        createdAt: r.created_at.toISOString(),
        isCurrent: r.is_current,
      })),
    };
  }

  /** 移动 current pointer：只能指向同一课程的已发布版本，不修改任何 release rows。 */
  async setCurrentRelease(
    actor: UserRecord,
    courseId: string,
    releaseId: string,
    requestId: string,
  ): Promise<{ currentReleaseId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const release = await client.query<{ course_id: string }>(
        "SELECT course_id FROM course_releases WHERE id = $1",
        [releaseId],
      );
      const row = release.rows[0];
      if (!row) throw new NotFoundException("发布版本不存在");
      if (row.course_id !== courseId) {
        throw new ConflictException("该发布版本不属于此课程，不能作为当前版本");
      }
      await client.query(
        `UPDATE courses SET current_release_id = $2, updated_at = now() WHERE id = $1`,
        [courseId, releaseId],
      );
      await this.audit(
        client,
        actor.id,
        "admin.course.current_release.change",
        "course",
        courseId,
        { releaseId },
        requestId,
      );
      await client.query("COMMIT");
      return { currentReleaseId: releaseId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- 幂等 ----

  private async claimIdempotency(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<unknown | "claimed"> {
    const deadline = Date.now() + IDEMPOTENCY_WAIT_MS;
    while (true) {
      const claim = await this.pool.query<{ response_json: unknown; request_hash: string }>(
        `INSERT INTO idempotency_keys (scope, key, request_hash, response_json) VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, key) DO NOTHING RETURNING response_json, request_hash`,
        [scope, key, requestHash, JSON.stringify({ pending: true })],
      );
      if ((claim.rowCount ?? 0) > 0) return "claimed";

      const existing = await this.pool.query<{ response_json: unknown; request_hash: string }>(
        `SELECT response_json, request_hash FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [scope, key],
      );
      const row = existing.rows[0];
      if (!row) continue; // 记录被首次请求失败后清理 → 重新尝试领取。

      if (row.request_hash !== requestHash) {
        throw new ConflictException("IDEMPOTENCY_CONFLICT：该请求键已用于不同的请求内容");
      }
      if (!isPendingIdempotencyResponse(row.response_json)) {
        // 第一次请求已完成 → 返回完整原结果，绝不把 pending 当成功。
        return row.response_json;
      }
      if (Date.now() >= deadline) {
        // 恢复：通过幂等记录的 resource_id 唯一关联到本次发布生成的 release，
        // 避免按 (course, draft_version) 误匹配同草稿版本的其他 release。
        const recovered = await this.recoverReleaseResult(scope, key);
        if (recovered) return recovered;
        throw new IdempotencyInProgressError();
      }
      await sleep(50);
    }
  }

  /** 恢复发布结果：用幂等记录的 resource_id 唯一定位 release；currentReleaseId 读取真实指针。 */
  private async recoverReleaseResult(
    scope: string,
    key: string,
  ): Promise<PublishReleaseResultDto | null> {
    const PREFIX = "admin:publish-release:";
    if (!scope.startsWith(PREFIX)) return null;
    const courseId = scope.slice(PREFIX.length);

    const keyRow = await this.pool.query<{ resource_id: string | null }>(
      `SELECT resource_id FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const releaseId = keyRow.rows[0]?.resource_id;
    if (!releaseId) return null; // 无 resource_id（事务未提交）→ 不可唯一恢复。

    const release = await this.pool.query<{
      id: string;
      release_number: number;
      content_hash: string;
      course_id: string;
      created_at: Date;
    }>(
      `SELECT id, release_number, content_hash, course_id, created_at FROM course_releases WHERE id = $1`,
      [releaseId],
    );
    const row = release.rows[0];
    if (!row || row.course_id !== courseId) return null; // 防御：release 必须属于该课程。

    const course = await this.pool.query<{ current_release_id: string | null }>(
      `SELECT current_release_id FROM courses WHERE id = $1`,
      [courseId],
    );
    const currentReleaseId = course.rows[0]?.current_release_id ?? null;
    return {
      releaseId: row.id,
      releaseNumber: row.release_number,
      contentHash: row.content_hash,
      // currentReleaseId 必须反映真实的 current pointer，不能无条件填被恢复的 release。
      currentReleaseId: currentReleaseId ?? row.id,
      createdAt: row.created_at.toISOString(),
    };
  }

  private requestHashOf(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private async releaseIdempotency(scope: string, key: string): Promise<void> {
    await this.pool.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [
      scope,
      key,
    ]);
  }

  private async loadReleaseNumbers(client: PoolClient, courseId: string): Promise<number[]> {
    const result = await client.query<{ release_number: number }>(
      `SELECT release_number FROM course_releases WHERE course_id = $1`,
      [courseId],
    );
    return result.rows.map((r) => r.release_number);
  }

  async updateDraft(
    actor: UserRecord,
    courseId: string,
    input: UpdateDraftInput,
    expectedVersion: number | undefined,
    requestId: string,
  ): Promise<CourseDraftDetailDto> {
    const fieldErrors: { path: string; code: string; message: string }[] = [];
    if (input.slug !== undefined) {
      for (const message of validateSlug(normalizeSlug(input.slug))) {
        fieldErrors.push({ path: "slug", code: "invalid", message });
      }
    }
    if (input.title !== undefined) {
      for (const message of validateCourseTitle(input.title)) {
        fieldErrors.push({ path: "title", code: "invalid", message });
      }
    }
    if (input.level !== undefined) {
      for (const message of validateCourseLevel(input.level)) {
        fieldErrors.push({ path: "level", code: "invalid", message });
      }
    }
    if (input.description !== undefined) {
      for (const message of validateCourseDescription(input.description)) {
        fieldErrors.push({ path: "description", code: "invalid", message });
      }
    }
    if (fieldErrors.length > 0) {
      throw new UnprocessableEntityException({ message: "草稿输入不合法", fieldErrors });
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draft = await this.lockActiveDraft(client, courseId);
      if (!draft) throw new NotFoundException("课程或草稿不存在");
      if (expectedVersion === undefined)
        throw new BadRequestException("缺少草稿版本（If-Match 或 draftVersion）");
      if (draft.version !== expectedVersion) {
        throw new DraftVersionConflictError(draft.version);
      }

      if (input.slug !== undefined) {
        const slug = normalizeSlug(input.slug);
        const clash = await client.query("SELECT 1 FROM courses WHERE slug = $1 AND id <> $2", [
          slug,
          courseId,
        ]);
        if (clash.rowCount && clash.rowCount > 0) {
          throw new ConflictException({
            message: "slug 已存在",
            fieldErrors: [{ path: "slug", code: "duplicate", message: "slug 已被其他课程使用" }],
          });
        }
        await client.query("UPDATE courses SET slug = $2, updated_at = now() WHERE id = $1", [
          courseId,
          slug,
        ]);
      }

      const title = input.title?.trim() ?? draft.title;
      const level = input.level?.trim() ?? draft.level;
      const description = input.description?.trim() ?? draft.description;
      const nextVersion = draft.version + 1;
      await client.query(
        `UPDATE course_drafts
         SET title = $2, level = $3, description = $4, version = $5, updated_at = now()
         WHERE id = $1`,
        [draft.id, title, level, description, nextVersion],
      );
      await this.audit(
        client,
        actor.id,
        "admin.course.draft.update",
        "course",
        courseId,
        { draftVersion: nextVersion },
        requestId,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const detail = await this.loadDraftDetail(courseId);
    if (!detail) throw new NotFoundException("课程或草稿不存在");
    return detail;
  }

  async createUnit(
    actor: UserRecord,
    courseId: string,
    unitId: string,
    input: CreateUnitInput,
    expectedVersion: number | undefined,
    requestId: string,
  ): Promise<CourseDraftDetailDto> {
    const title = input.title.trim();
    const fieldErrors: { path: string; code: string; message: string }[] = [];
    for (const message of validateUnitTitle(title)) {
      fieldErrors.push({ path: "title", code: "invalid", message });
    }
    for (const message of validateUnitDescription(input.description)) {
      fieldErrors.push({ path: "description", code: "invalid", message });
    }
    if (fieldErrors.length > 0) {
      throw new UnprocessableEntityException({ message: "单元输入不合法", fieldErrors });
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draft = await this.lockActiveDraft(client, courseId);
      if (!draft) throw new NotFoundException("课程或草稿不存在");
      if (expectedVersion === undefined)
        throw new BadRequestException("缺少草稿版本（If-Match 或 draftVersion）");
      if (draft.version !== expectedVersion) throw new DraftVersionConflictError(draft.version);

      const position = await this.nextUnitPosition(client, draft.id);
      await client.query(
        `INSERT INTO draft_units (id, draft_id, position, title, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [unitId, draft.id, position, title, input.description?.trim() ?? ""],
      );
      const nextVersion = draft.version + 1;
      await this.bumpVersion(client, draft.id, nextVersion);
      await this.audit(
        client,
        actor.id,
        "admin.course.unit.create",
        "course",
        courseId,
        { unitId, position, draftVersion: nextVersion },
        requestId,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const detail = await this.loadDraftDetail(courseId);
    if (!detail) throw new NotFoundException("课程或草稿不存在");
    return detail;
  }

  async updateUnit(
    actor: UserRecord,
    courseId: string,
    unitId: string,
    input: UpdateUnitInput,
    expectedVersion: number | undefined,
    requestId: string,
  ): Promise<CourseDraftDetailDto> {
    const fieldErrors: { path: string; code: string; message: string }[] = [];
    if (input.title !== undefined) {
      for (const message of validateUnitTitle(input.title)) {
        fieldErrors.push({ path: "title", code: "invalid", message });
      }
    }
    if (input.description !== undefined) {
      for (const message of validateUnitDescription(input.description)) {
        fieldErrors.push({ path: "description", code: "invalid", message });
      }
    }
    if (fieldErrors.length > 0) {
      throw new UnprocessableEntityException({ message: "单元输入不合法", fieldErrors });
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draft = await this.lockActiveDraft(client, courseId);
      if (!draft) throw new NotFoundException("课程或草稿不存在");
      if (expectedVersion === undefined)
        throw new BadRequestException("缺少草稿版本（If-Match 或 draftVersion）");
      if (draft.version !== expectedVersion) throw new DraftVersionConflictError(draft.version);

      const existing = await client.query<UnitRow>(
        "SELECT * FROM draft_units WHERE id = $1 AND draft_id = $2",
        [unitId, draft.id],
      );
      const unit = existing.rows[0];
      if (!unit) throw new NotFoundException("单元不存在");
      await client.query(
        `UPDATE draft_units SET title = $3, description = $4, updated_at = now() WHERE id = $1 AND draft_id = $2`,
        [
          unitId,
          draft.id,
          input.title?.trim() ?? unit.title,
          input.description?.trim() ?? unit.description,
        ],
      );
      const nextVersion = draft.version + 1;
      await this.bumpVersion(client, draft.id, nextVersion);
      await this.audit(
        client,
        actor.id,
        "admin.course.unit.update",
        "course",
        courseId,
        { unitId, draftVersion: nextVersion },
        requestId,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const detail = await this.loadDraftDetail(courseId);
    if (!detail) throw new NotFoundException("课程或草稿不存在");
    return detail;
  }

  async deleteUnit(
    actor: UserRecord,
    courseId: string,
    unitId: string,
    expectedVersion: number | undefined,
    requestId: string,
  ): Promise<CourseDraftDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draft = await this.lockActiveDraft(client, courseId);
      if (!draft) throw new NotFoundException("课程或草稿不存在");
      if (expectedVersion === undefined)
        throw new BadRequestException("缺少草稿版本（If-Match 或 draftVersion）");
      if (draft.version !== expectedVersion) throw new DraftVersionConflictError(draft.version);

      const deleted = await client.query(
        "DELETE FROM draft_units WHERE id = $1 AND draft_id = $2 RETURNING id",
        [unitId, draft.id],
      );
      if (deleted.rowCount === 0) throw new NotFoundException("单元不存在");

      // 删除后重排为连续的 1..n。
      await this.renumberAll(client, draft.id);
      const nextVersion = draft.version + 1;
      await this.bumpVersion(client, draft.id, nextVersion);
      await this.audit(
        client,
        actor.id,
        "admin.course.unit.delete",
        "course",
        courseId,
        { unitId, draftVersion: nextVersion },
        requestId,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const detail = await this.loadDraftDetail(courseId);
    if (!detail) throw new NotFoundException("课程或草稿不存在");
    return detail;
  }

  async reorderUnits(
    actor: UserRecord,
    courseId: string,
    unitIds: string[],
    expectedVersion: number | undefined,
    requestId: string,
  ): Promise<CourseDraftDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draft = await this.lockActiveDraft(client, courseId);
      if (!draft) throw new NotFoundException("课程或草稿不存在");
      if (expectedVersion === undefined)
        throw new BadRequestException("缺少草稿版本（If-Match 或 draftVersion）");
      if (draft.version !== expectedVersion) throw new DraftVersionConflictError(draft.version);

      const units = await this.loadUnits(client, draft.id);
      const orderErrors = validateUnitOrder(
        units.map((u) => u.id),
        unitIds,
      );
      if (orderErrors.length > 0) {
        throw new UnprocessableEntityException({
          message: "单元顺序不合法",
          fieldErrors: [{ path: "unitIds", code: "invalid", message: orderErrors.join("；") }],
        });
      }
      await this.renumberByIds(client, draft.id, unitIds);
      const nextVersion = draft.version + 1;
      await this.bumpVersion(client, draft.id, nextVersion);
      await this.audit(
        client,
        actor.id,
        "admin.course.units.reorder",
        "course",
        courseId,
        { unitIds, draftVersion: nextVersion },
        requestId,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const detail = await this.loadDraftDetail(courseId);
    if (!detail) throw new NotFoundException("课程或草稿不存在");
    return detail;
  }

  async createItem(
    actor: UserRecord,
    courseId: string,
    itemId: string,
    input: CreateItemInput,
    expectedVersion: number | undefined,
    requestId: string,
  ): Promise<CourseDraftDetailDto> {
    const meaning = input.meaning.trim();
    const fieldErrors: { path: string; code: string; message: string }[] = [];
    for (const message of validateItemMeaning(meaning)) {
      fieldErrors.push({ path: "meaning", code: "invalid", message });
    }
    for (const message of validateItemHint(input.hint)) {
      fieldErrors.push({ path: "hint", code: "invalid", message });
    }
    if (fieldErrors.length > 0) {
      throw new UnprocessableEntityException({ message: "词项输入不合法", fieldErrors });
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draft = await this.lockActiveDraft(client, courseId);
      if (!draft) throw new NotFoundException("课程或草稿不存在");
      if (expectedVersion === undefined)
        throw new BadRequestException("缺少草稿版本（If-Match 或 draftVersion）");
      if (draft.version !== expectedVersion) throw new DraftVersionConflictError(draft.version);

      const unit = await client.query<UnitRow>(
        "SELECT * FROM draft_units WHERE id = $1 AND draft_id = $2",
        [input.unitId, draft.id],
      );
      if (!unit.rows[0]) {
        throw new UnprocessableEntityException({
          message: "单元不属于该课程草稿",
          fieldErrors: [{ path: "unitId", code: "invalid", message: "单元不存在或不属于该草稿" }],
        });
      }
      const entry = await client.query("SELECT 1 FROM lexical_entries WHERE id = $1", [
        input.lexicalEntryId,
      ]);
      if (entry.rowCount === 0) {
        throw new UnprocessableEntityException({
          message: "词条不存在",
          fieldErrors: [{ path: "lexicalEntryId", code: "not_found", message: "引用的词条不存在" }],
        });
      }

      // 手工中文内容 provenance：预生成审计事件 id 作为 content_review_reference。
      // Path B（reviewDecisionId 提供）：该引用记录“吸收 accepted 内容”的审计，
      // provenance_kind='review' 且 review_decision_id 指向真实 review decision。
      const auditId = randomUUID();
      const meaningHash = createHash("sha256").update(meaning).digest("hex");
      await client.query(
        `INSERT INTO audit_events
           (id, actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, $2, 'admin.course.item.create', 'course', $3, NULL, $4::jsonb, $5)`,
        [
          auditId,
          actor.id,
          courseId,
          JSON.stringify({
            itemId,
            unitId: input.unitId,
            lexicalEntryId: input.lexicalEntryId,
            meaningHash,
            ...(input.reviewDecisionId ? { reviewDecisionId: input.reviewDecisionId } : {}),
          }),
          requestId,
        ],
      );
      if (input.reviewDecisionId) {
        // Path B：校验 review_decision 存在、为接受态、且与当前词条目一致（P1-2 fail-closed）。
        // final P1 还校验完整的 source/lexical identity 绑定：
        //   commit_row、page/revision、content_hash、以及 decision 未被其他 item 占用。
        const rd = await client.query<{
          decision_type: string;
          draft_id: string;
          draft_lexical_entry_id: string;
          snapshot_source_fact_identity: string;
          snapshot_english_spelling: string;
          source_fact_status: string | null;
          source_fact_normalized_spelling: string | null;
          source_fact_content_hash: string | null;
          source_fact_commit_row_id: string | null;
          draft_import_batch_commit_row_id: string | null;
          snapshot_page_id: string | null;
          snapshot_revision_id: string | null;
          source_page_id: string | null;
          source_revision_id: string | null;
          entry_canonical_spelling: string | null;
          entry_normalized_spelling: string | null;
          bound_to_another_item: boolean;
        }>(
          `SELECT rd.decision_type AS decision_type, rd.draft_id AS draft_id,
                  ed.lexical_entry_id AS draft_lexical_entry_id,
                  s.source_fact_identity AS snapshot_source_fact_identity,
                  s.english_spelling AS snapshot_english_spelling,
                  sf.status AS source_fact_status,
                  sf.normalized_spelling AS source_fact_normalized_spelling,
                  sf.content_hash AS source_fact_content_hash,
                  sf.commit_row_id AS source_fact_commit_row_id,
                  ed.import_batch_commit_row_id AS draft_import_batch_commit_row_id,
                  s.source_page_id AS snapshot_page_id,
                  s.source_revision_id AS snapshot_revision_id,
                  sf.page_id AS source_page_id,
                  sf.revision_id AS source_revision_id,
                  e.canonical_spelling AS entry_canonical_spelling,
                  e.normalized_spelling AS entry_normalized_spelling,
                  EXISTS (
                    SELECT 1 FROM draft_course_items other
                    WHERE other.review_decision_id = rd.id AND other.id IS NOT NULL
                  ) AS bound_to_another_item
             FROM review_decisions rd
             JOIN enrichment_drafts ed ON ed.id = rd.draft_id
             LEFT JOIN review_decision_snapshots s ON s.decision_id = rd.id
             LEFT JOIN wiktionary_source_facts sf ON sf.source_fact_identity = s.source_fact_identity
             LEFT JOIN lexical_entries e ON e.id = ed.lexical_entry_id
            WHERE rd.id = $1`,
          [input.reviewDecisionId],
        );
        const rdRow = rd.rows[0];
        if (!rdRow) {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "not_found",
            message: "引用的 review decision 不存在",
          });
        }
        if (rdRow.decision_type !== "accept" && rdRow.decision_type !== "accept_with_edits") {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "not_accepted",
            message: "只有 accepted / accepted_with_edits 的审核决定可作为词项来源",
          });
        }
        // P1-2: 审核决定必须属于当前词项的 lexical entry（Apple decision 不能绑到 Banana）。
        if (
          rdRow.draft_lexical_entry_id === null ||
          input.lexicalEntryId !== rdRow.draft_lexical_entry_id
        ) {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "lexical_mismatch",
            message: "该审核决定不属于当前词项（词条不匹配），不可绑定",
          });
        }
        // P1-2: snapshot 必须存在、source fact 必须为 fetched 且属于同一来源。
        if (rdRow.snapshot_source_fact_identity === null) {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "snapshot_missing",
            message: "该审核决定缺少不可变快照，不可绑定",
          });
        }
        if (rdRow.source_fact_status !== "fetched") {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "source_not_fetched",
            message: "该审核决定的来源事实未处于可发布（fetched）状态，不可绑定",
          });
        }
        // final P1: snapshot spelling must match the lexical entry's canonical spelling
        // (Apple decision must not bind to a snapshot whose spelling is banana).
        if (
          rdRow.entry_canonical_spelling !== null &&
          rdRow.snapshot_english_spelling !== null &&
          rdRow.snapshot_english_spelling !== rdRow.entry_canonical_spelling
        ) {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "snapshot_spelling_mismatch",
            message: "该审核决定的快照拼写与词条不一致，不可绑定",
          });
        }
        // final P1: source fact normalized spelling must match the lexical entry's normalized spelling
        if (
          rdRow.entry_normalized_spelling !== null &&
          rdRow.source_fact_normalized_spelling !== null &&
          rdRow.source_fact_normalized_spelling !== rdRow.entry_normalized_spelling
        ) {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "normalized_spelling_mismatch",
            message: "该审核决定的来源事实拼写与词条不一致，不可绑定",
          });
        }
        // final P1: source fact commit_row_id must match the draft's import_batch_commit_row_id.
        if (
          rdRow.source_fact_commit_row_id === null ||
          rdRow.draft_import_batch_commit_row_id === null ||
          rdRow.source_fact_commit_row_id !== rdRow.draft_import_batch_commit_row_id
        ) {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "commit_row_mismatch",
            message: "该审核决定的来源事实 commit row 与草稿不一致，不可绑定",
          });
        }
        // final P1: snapshot page/revision identity must match the source fact's page/revision.
        if (
          rdRow.snapshot_page_id === null ||
          rdRow.snapshot_revision_id === null ||
          rdRow.source_page_id === null ||
          rdRow.source_revision_id === null ||
          rdRow.snapshot_page_id !== rdRow.source_page_id ||
          rdRow.snapshot_revision_id !== rdRow.source_revision_id
        ) {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "revision_page_mismatch",
            message: "该审核决定的 revision/page 身份与来源事实不一致，不可绑定",
          });
        }
        // final P1: source fact must carry a non-empty content_hash (64-hex).
        if (
          rdRow.source_fact_content_hash === null ||
          rdRow.source_fact_content_hash.length !== 64
        ) {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "source_fact_hash_missing",
            message: "该审核决定的来源事实缺少 content_hash，不可绑定",
          });
        }
        // final P1: this review decision must not already be bound to another course item.
        if (rdRow.bound_to_another_item) {
          throw new UnprocessableEntityException({
            path: "reviewDecisionId",
            code: "conflicting_decision",
            message: "该审核决定已被其他课程词项占用，不可重复绑定",
          });
        }
      }

      const position = await this.nextItemPosition(client, input.unitId);
      await client.query(
        `INSERT INTO draft_course_items
           (id, draft_unit_id, lexical_entry_id, position, meaning, hint, content_review_reference,
            provenance_kind, review_decision_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          itemId,
          input.unitId,
          input.lexicalEntryId,
          position,
          meaning,
          input.hint?.trim() ?? null,
          auditId,
          input.reviewDecisionId ? "review" : "manual",
          input.reviewDecisionId ?? null,
        ],
      );
      const nextVersion = draft.version + 1;
      await this.bumpVersion(client, draft.id, nextVersion);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const detail = await this.loadDraftDetail(courseId);
    if (!detail) throw new NotFoundException("课程或草稿不存在");
    return detail;
  }

  async updateItem(
    actor: UserRecord,
    courseId: string,
    itemId: string,
    input: UpdateItemInput,
    expectedVersion: number | undefined,
    requestId: string,
  ): Promise<CourseDraftDetailDto> {
    const fieldErrors: { path: string; code: string; message: string }[] = [];
    if (input.meaning !== undefined) {
      for (const message of validateItemMeaning(input.meaning)) {
        fieldErrors.push({ path: "meaning", code: "invalid", message });
      }
    }
    if (input.hint !== undefined) {
      for (const message of validateItemHint(input.hint)) {
        fieldErrors.push({ path: "hint", code: "invalid", message });
      }
    }
    if (fieldErrors.length > 0) {
      throw new UnprocessableEntityException({ message: "词项输入不合法", fieldErrors });
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draft = await this.lockActiveDraft(client, courseId);
      if (!draft) throw new NotFoundException("课程或草稿不存在");
      if (expectedVersion === undefined)
        throw new BadRequestException("缺少草稿版本（If-Match 或 draftVersion）");
      if (draft.version !== expectedVersion) throw new DraftVersionConflictError(draft.version);

      const itemRes = await client.query<ItemRow>(
        `SELECT * FROM draft_course_items WHERE id = $1
         AND draft_unit_id IN (SELECT id FROM draft_units WHERE draft_id = $2)`,
        [itemId, draft.id],
      );
      const item = itemRes.rows[0];
      if (!item) throw new NotFoundException("词项不存在");

      // review-bound edit integrity (fail-closed):
      // a Path-B item (provenance_kind='review' + review_decision_id) derives its meaning/hint
      // from an accepted review decision.  Editing meaning/hint here would silently overwrite
      // the accepted content while retaining the review provenance => semantic break.
      // Block such edits with a stable 422; Path-A (manual) items keep existing behavior.
      const isReviewBound = item.provenance_kind === "review" && item.review_decision_id !== null;
      if (isReviewBound) {
        const meaningChanged = input.meaning !== undefined && input.meaning.trim() !== item.meaning;
        const hintChanged = input.hint !== undefined && (input.hint.trim() || null) !== item.hint;
        if (meaningChanged || hintChanged) {
          throw new UnprocessableEntityException({
            path: "item",
            code: "ITEM_REVIEW_BOUND_EDIT_BLOCKED",
            message: "该词项绑定 accepted 审核决定，不能通过普通编辑覆盖其 meaning/hint",
          });
        }
      }

      const newMeaning = input.meaning?.trim() ?? item.meaning;
      const newHint = input.hint !== undefined ? input.hint.trim() || null : item.hint;
      let targetUnitId = item.draft_unit_id;
      if (input.unitId !== undefined && input.unitId !== item.draft_unit_id) {
        const unit = await client.query<UnitRow>(
          "SELECT * FROM draft_units WHERE id = $1 AND draft_id = $2",
          [input.unitId, draft.id],
        );
        if (!unit.rows[0]) {
          throw new UnprocessableEntityException({
            message: "单元不属于该课程草稿",
            fieldErrors: [{ path: "unitId", code: "invalid", message: "单元不存在或不属于该草稿" }],
          });
        }
        targetUnitId = input.unitId;
      }

      const auditId = randomUUID();
      const meaningHash = createHash("sha256").update(newMeaning).digest("hex");
      await client.query(
        `INSERT INTO audit_events
           (id, actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, $2, 'admin.course.item.update', 'course', $3, NULL, $4::jsonb, $5)`,
        [
          auditId,
          actor.id,
          courseId,
          JSON.stringify({
            itemId,
            unitId: targetUnitId,
            lexicalEntryId: item.lexical_entry_id,
            meaningHash,
          }),
          requestId,
        ],
      );

      if (targetUnitId !== item.draft_unit_id) {
        // 跨单元移动：从旧单元移除并重排，再追加到目标单元末尾。
        const sourceRemaining = (await this.loadItemIds(client, item.draft_unit_id)).filter(
          (id) => id !== itemId,
        );
        await this.renumberItemIds(client, item.draft_unit_id, sourceRemaining);
        const position = await this.nextItemPosition(client, targetUnitId);
        await client.query(
          `UPDATE draft_course_items
           SET draft_unit_id = $2, position = $3, meaning = $4, hint = $5,
               content_review_reference = $6, updated_at = now()
           WHERE id = $1`,
          [itemId, targetUnitId, position, newMeaning, newHint, auditId],
        );
      } else {
        await client.query(
          `UPDATE draft_course_items
           SET meaning = $2, hint = $3, content_review_reference = $4, updated_at = now()
           WHERE id = $1`,
          [itemId, newMeaning, newHint, auditId],
        );
      }
      const nextVersion = draft.version + 1;
      await this.bumpVersion(client, draft.id, nextVersion);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const detail = await this.loadDraftDetail(courseId);
    if (!detail) throw new NotFoundException("课程或草稿不存在");
    return detail;
  }

  async deleteItem(
    actor: UserRecord,
    courseId: string,
    itemId: string,
    expectedVersion: number | undefined,
    requestId: string,
  ): Promise<CourseDraftDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draft = await this.lockActiveDraft(client, courseId);
      if (!draft) throw new NotFoundException("课程或草稿不存在");
      if (expectedVersion === undefined)
        throw new BadRequestException("缺少草稿版本（If-Match 或 draftVersion）");
      if (draft.version !== expectedVersion) throw new DraftVersionConflictError(draft.version);

      const itemRes = await client.query<{ draft_unit_id: string }>(
        `SELECT draft_unit_id FROM draft_course_items WHERE id = $1
         AND draft_unit_id IN (SELECT id FROM draft_units WHERE draft_id = $2)`,
        [itemId, draft.id],
      );
      const item = itemRes.rows[0];
      if (!item) throw new NotFoundException("词项不存在");

      await client.query("DELETE FROM draft_course_items WHERE id = $1", [itemId]);
      const remaining = (await this.loadItemIds(client, item.draft_unit_id)).filter(
        (id) => id !== itemId,
      );
      await this.renumberItemIds(client, item.draft_unit_id, remaining);

      const nextVersion = draft.version + 1;
      await this.bumpVersion(client, draft.id, nextVersion);
      await this.audit(
        client,
        actor.id,
        "admin.course.item.delete",
        "course",
        courseId,
        { itemId, draftVersion: nextVersion },
        requestId,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const detail = await this.loadDraftDetail(courseId);
    if (!detail) throw new NotFoundException("课程或草稿不存在");
    return detail;
  }

  async reorderItems(
    actor: UserRecord,
    courseId: string,
    unitId: string,
    itemIds: string[],
    expectedVersion: number | undefined,
    requestId: string,
  ): Promise<CourseDraftDetailDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const draft = await this.lockActiveDraft(client, courseId);
      if (!draft) throw new NotFoundException("课程或草稿不存在");
      if (expectedVersion === undefined)
        throw new BadRequestException("缺少草稿版本（If-Match 或 draftVersion）");
      if (draft.version !== expectedVersion) throw new DraftVersionConflictError(draft.version);

      const unit = await client.query<UnitRow>(
        "SELECT * FROM draft_units WHERE id = $1 AND draft_id = $2",
        [unitId, draft.id],
      );
      if (!unit.rows[0]) {
        throw new UnprocessableEntityException({
          message: "单元不属于该课程草稿",
          fieldErrors: [{ path: "unitId", code: "invalid", message: "单元不存在或不属于该草稿" }],
        });
      }
      const existingItemIds = await this.loadItemIds(client, unitId);
      const orderErrors = validateUnitOrder(existingItemIds, itemIds);
      if (orderErrors.length > 0) {
        throw new UnprocessableEntityException({
          message: "词项顺序不合法",
          fieldErrors: [{ path: "itemIds", code: "invalid", message: orderErrors.join("；") }],
        });
      }
      await this.renumberItemIds(client, unitId, itemIds);
      const nextVersion = draft.version + 1;
      await this.bumpVersion(client, draft.id, nextVersion);
      await this.audit(
        client,
        actor.id,
        "admin.course.items.reorder",
        "course",
        courseId,
        { unitId, itemIds, draftVersion: nextVersion },
        requestId,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const detail = await this.loadDraftDetail(courseId);
    if (!detail) throw new NotFoundException("课程或草稿不存在");
    return detail;
  }

  // ---- 内部 ----

  private async loadDraftDetail(courseId: string): Promise<CourseDraftDetailDto | null> {
    const draftResult = await this.pool.query<DraftRow & { slug: string }>(
      `SELECT d.*, c.slug
       FROM course_drafts d JOIN courses c ON c.id = d.course_id
       WHERE d.course_id = $1 AND d.status = 'active'`,
      [courseId],
    );
    const draft = draftResult.rows[0];
    if (!draft) return null;
    const units = await this.loadUnitsByPool(draft.id);
    return {
      courseId,
      draftId: draft.id,
      slug: draft.slug,
      title: draft.title,
      level: draft.level,
      description: draft.description,
      version: draft.version,
      status: draft.status,
      units,
    };
  }

  private async loadUnitsByPool(draftId: string): Promise<UnitDto[]> {
    const result = await this.pool.query<UnitRow>(
      `SELECT * FROM draft_units WHERE draft_id = $1 ORDER BY position ASC, id ASC`,
      [draftId],
    );
    const units: UnitDto[] = [];
    for (const u of result.rows) {
      units.push({
        id: u.id,
        position: u.position,
        title: u.title,
        description: u.description,
        items: await this.loadItemsByPool(u.id),
        createdAt: u.created_at.toISOString(),
        updatedAt: u.updated_at.toISOString(),
      });
    }
    return units;
  }

  private async loadItemsByPool(unitId: string): Promise<ItemDto[]> {
    const result = await this.pool.query<ItemRow>(
      `SELECT i.*, e.canonical_spelling, e.normalized_spelling,
              (SELECT s.source_type FROM lexical_sources s
                WHERE s.lexical_entry_id = i.lexical_entry_id
                ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS source_status
       FROM draft_course_items i
       JOIN lexical_entries e ON e.id = i.lexical_entry_id
       WHERE i.draft_unit_id = $1
       ORDER BY i.position ASC, i.id ASC`,
      [unitId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      position: r.position,
      meaning: r.meaning,
      hint: r.hint,
      contentReviewReference: r.content_review_reference,
      lexicalEntry: {
        id: r.lexical_entry_id,
        canonicalSpelling: r.canonical_spelling,
        normalizedSpelling: r.normalized_spelling,
        sourceStatus: r.source_status ?? "manual",
      },
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  private async nextItemPosition(client: PoolClient, unitId: string): Promise<number> {
    const result = await client.query<{ max: number | null }>(
      `SELECT MAX(position) AS max FROM draft_course_items WHERE draft_unit_id = $1`,
      [unitId],
    );
    return (result.rows[0]?.max ?? 0) + 1;
  }

  private async loadItemIds(client: PoolClient, unitId: string): Promise<string[]> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM draft_course_items WHERE draft_unit_id = $1 ORDER BY position ASC, id ASC`,
      [unitId],
    );
    return result.rows.map((r) => r.id);
  }

  private async renumberItemIds(
    client: PoolClient,
    unitId: string,
    orderedIds: string[],
  ): Promise<void> {
    // 先把该单元所有位置临时偏移到高位，避免逐个赋值时撞上仍占位的旧位置。
    await client.query(
      `UPDATE draft_course_items SET position = position + 1000000 WHERE draft_unit_id = $1`,
      [unitId],
    );
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        `UPDATE draft_course_items SET position = $2, updated_at = now() WHERE id = $1 AND draft_unit_id = $3`,
        [orderedIds[i], i + 1, unitId],
      );
    }
  }

  private async lockActiveDraft(client: PoolClient, courseId: string): Promise<DraftRow | null> {
    const result = await client.query<DraftRow>(
      `SELECT * FROM course_drafts WHERE course_id = $1 AND status = 'active' FOR UPDATE`,
      [courseId],
    );
    return result.rows[0] ?? null;
  }

  private async loadUnits(client: PoolClient, draftId: string): Promise<UnitRow[]> {
    const result = await client.query<UnitRow>(
      `SELECT * FROM draft_units WHERE draft_id = $1 ORDER BY position ASC, id ASC`,
      [draftId],
    );
    return result.rows;
  }

  private async nextUnitPosition(client: PoolClient, draftId: string): Promise<number> {
    const result = await client.query<{ max: number | null }>(
      `SELECT MAX(position) AS max FROM draft_units WHERE draft_id = $1`,
      [draftId],
    );
    return (result.rows[0]?.max ?? 0) + 1;
  }

  private async renumberByIds(
    client: PoolClient,
    draftId: string,
    orderedIds: string[],
  ): Promise<void> {
    // 先把所有位置临时偏移到高位，避免逐个赋值时撞上仍占位的旧位置（draft+position 唯一约束）。
    await client.query(`UPDATE draft_units SET position = position + 1000000 WHERE draft_id = $1`, [
      draftId,
    ]);
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        `UPDATE draft_units SET position = $2, updated_at = now() WHERE id = $1 AND draft_id = $3`,
        [orderedIds[i], i + 1, draftId],
      );
    }
  }

  private async renumberAll(client: PoolClient, draftId: string): Promise<void> {
    const units = await this.loadUnits(client, draftId);
    await this.renumberByIds(
      client,
      draftId,
      units.map((u) => u.id),
    );
  }

  private async bumpVersion(client: PoolClient, draftId: string, version: number): Promise<void> {
    await client.query(`UPDATE course_drafts SET version = $2, updated_at = now() WHERE id = $1`, [
      draftId,
      version,
    ]);
  }

  private async audit(
    client: PoolClient,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    after: unknown,
    requestId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
         (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
       VALUES ($1, $2, $3, $4, NULL, $5::jsonb, $6)`,
      [actorId, action, targetType, targetId, JSON.stringify(after), requestId],
    );
  }
}
