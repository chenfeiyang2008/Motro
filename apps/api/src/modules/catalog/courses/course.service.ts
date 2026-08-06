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
import {
  normalizeSlug,
  validateCourseDescription,
  validateCourseLevel,
  validateCourseTitle,
  validateSlug,
  validateUnitDescription,
  validateUnitOrder,
  validateUnitTitle,
} from "@motro/domain";
import type { Pool, PoolClient } from "pg";
import { POOL } from "../../../auth/database.provider.js";
import type { UserRecord } from "../../../auth/session.service.js";
import type {
  CourseDraftDetailDto,
  CourseListItemDto,
  CreateCourseResultDto,
  UnitDto,
} from "./dto.js";

/** 草稿版本冲突：服务端当前版本随异常携带，供控制器返回 409 信封。 */
export class DraftVersionConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super("草稿版本冲突");
    this.name = "DraftVersionConflictError";
  }
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
    return result.rows.map((u) => ({
      id: u.id,
      position: u.position,
      title: u.title,
      description: u.description,
      createdAt: u.created_at.toISOString(),
      updatedAt: u.updated_at.toISOString(),
    }));
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
