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
  nextReleaseNumber,
  normalizeSlug,
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
}

interface CatalogCourseRow {
  course_id: string;
  release_id: string;
  release_number: number;
  title: string;
  level: string;
  description: string;
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
}

const VALIDATION_SQL = `SELECT d.version, d.title,
        u.id AS unit_id, u.position AS unit_position, u.title AS unit_title,
        u.description AS unit_description,
        i.id AS item_id, i.position AS item_position, i.meaning, i.hint,
        i.lexical_entry_id, i.content_review_reference,
        (e.id IS NOT NULL) AS lexical_entry_exists,
        (a.id IS NOT NULL) AS content_review_valid
 FROM course_drafts d
 LEFT JOIN draft_units u ON u.draft_id = d.id
 LEFT JOIN draft_course_items i ON i.draft_unit_id = u.id
 LEFT JOIN lexical_entries e ON e.id = i.lexical_entry_id
 LEFT JOIN audit_events a ON a.id = i.content_review_reference
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
      });
    }
  }
  units.sort((a, b) => a.position - b.position);
  return { draftVersion: first.version, title: first.title, units };
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

  /** 学习者目录列表：只读可见课程的 current release，不读草稿。 */
  async listCatalogCourses(): Promise<CatalogCourseListResponseDto> {
    const result = await this.pool.query<CatalogCourseRow>(
      `SELECT c.id AS course_id, r.id AS release_id, r.release_number, r.title, r.level, r.description
       FROM courses c
       JOIN course_releases r ON r.id = c.current_release_id
       WHERE c.visibility = 'published' AND c.status = 'active'
       ORDER BY r.release_number DESC, c.id ASC`,
    );
    return {
      items: result.rows.map((row) =>
        buildCatalogSummary({
          courseId: row.course_id,
          title: row.title,
          level: row.level,
          description: row.description,
          releaseId: row.release_id,
          releaseNumber: row.release_number,
        }),
      ),
    };
  }

  /** 学习者目录详情：当前 release + 有序单元概要；无 current release/不可见 → 隐藏资源 404。 */
  async getCatalogCourse(courseId: string): Promise<CatalogCourseDetailDto> {
    const result = await this.pool.query<CatalogCourseRow>(
      `SELECT c.id AS course_id, r.id AS release_id, r.release_number, r.title, r.level, r.description
       FROM courses c
       JOIN course_releases r ON r.id = c.current_release_id
       WHERE c.id = $1 AND c.visibility = 'published' AND c.status = 'active'`,
      [courseId],
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
    return buildCatalogDetail(
      {
        courseId: row.course_id,
        title: row.title,
        level: row.level,
        description: row.description,
        releaseId: row.release_id,
        releaseNumber: row.release_number,
      },
      units.rows.map((u) => ({
        unitId: u.unit_id,
        position: u.position,
        title: u.title,
        description: u.description,
      })),
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
    return {
      draftVersion: outcome.draftVersion,
      isPublishable: outcome.isPublishable,
      blockingErrors: outcome.blockingErrors,
      warnings: outcome.warnings,
      diffSummary: outcome.diffSummary,
      // 第 7 张工单接入真实报名关系后，复用同一字段返回真实影响人数；第 4 阶段无报名数据。
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
      if (!outcome.isPublishable) {
        throw new UnprocessableEntityException({
          message: "草稿存在阻断错误，无法发布",
          fieldErrors: outcome.blockingErrors.map((e) => ({
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
                  e.canonical_spelling AS english_spelling
           FROM draft_units u
           LEFT JOIN draft_course_items i ON i.draft_unit_id = u.id
           LEFT JOIN lexical_entries e ON e.id = i.lexical_entry_id
           WHERE u.draft_id = $1
           ORDER BY u.position ASC, u.id ASC, i.position ASC, i.id ASC`,
          [draft.id],
        )
      ).rows;

      for (const row of copyRows) {
        if (!row.unit_id) continue;
        const unitInsert = await client.query<{ id: string }>(
          `INSERT INTO released_units (release_id, unit_id, position, title, description)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (release_id, unit_id) DO NOTHING
           RETURNING id`,
          [releaseId, row.unit_id, row.unit_position, row.unit_title, row.unit_description],
        );
        const releasedUnitId = unitInsert.rows[0]?.id;
        if (!releasedUnitId) continue;
        if (row.item_id) {
          await client.query(
            `INSERT INTO released_course_items
               (release_id, released_unit_id, course_item_id, lexical_entry_id, position,
                english_spelling, meaning, hint, content_review_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
          }),
          requestId,
        ],
      );

      const position = await this.nextItemPosition(client, input.unitId);
      await client.query(
        `INSERT INTO draft_course_items
           (id, draft_unit_id, lexical_entry_id, position, meaning, hint, content_review_reference)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          itemId,
          input.unitId,
          input.lexicalEntryId,
          position,
          meaning,
          input.hint?.trim() ?? null,
          auditId,
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
