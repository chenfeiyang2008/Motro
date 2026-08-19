// 词条查询与管理员命令：搜索/键集分页、详情、手工创建（重复判定 + 来源 + 审计）。
// 所有写操作都产生 audit_events；审计摘要不含大段未脱敏用户输入或敏感凭证。
import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  evaluateDuplicates,
  normalizeSpelling,
  validateCanonicalSpelling,
  validatePartOfSpeech,
  validatePronunciation,
  validateSenses,
  validateSourceNote,
} from "@motro/domain";
import { POOL, type Pool } from "../../../auth/database.provider.js";
import type { UserRecord } from "../../../auth/session.service.js";
import type {
  DuplicateCandidateDto,
  LexicalEntryDetailDto,
  LexicalEntrySummaryDto,
} from "./dto.js";

interface LexicalEntryRow {
  id: string;
  canonical_spelling: string;
  normalized_spelling: string;
  part_of_speech: string | null;
  pronunciation: string | null;
  senses: unknown;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface DuplicateCandidateRow {
  id: string;
  canonical_spelling: string;
  normalized_spelling: string;
}

export interface LexicalEntryListResult {
  items: LexicalEntrySummaryDto[];
  page: { cursor: string | null; hasMore: boolean };
}

export type CreateOutcome =
  | { kind: "created"; entry: LexicalEntryDetailDto }
  | { kind: "duplicate_warning"; candidates: DuplicateCandidateDto[] }
  | { kind: "duplicate_exact"; candidate: DuplicateCandidateDto };

export interface CreateLexicalEntryInput {
  canonicalSpelling: string;
  partOfSpeech: string | undefined;
  pronunciation: string | undefined;
  senses: { meaning: string; example?: string }[] | undefined;
  sourceNote: string | undefined;
  confirmDuplicate: boolean | undefined;
}

@Injectable()
export class LexicalEntryService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async list(opts: {
    q: string | undefined;
    cursor: string | undefined;
    limit: number | undefined;
  }): Promise<LexicalEntryListResult> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const q = (opts.q ?? "").trim();
    const params: unknown[] = [];
    const where: string[] = [];

    if (q.length > 0) {
      const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
      params.push(`%${escaped}%`);
      const idx = params.length;
      where.push(
        `(normalized_spelling ILIKE $${idx} ESCAPE '\\' OR canonical_spelling ILIKE $${idx} ESCAPE '\\')`,
      );
    }

    if (opts.cursor) {
      const key = decodeCursor(opts.cursor);
      params.push(key.normalizedSpelling, key.id);
      const last = params.length;
      where.push(`(normalized_spelling, id) > ($${last - 1}, $${last})`);
    }

    params.push(limit + 1);
    const sql = `
      SELECT e.id, e.canonical_spelling, e.normalized_spelling, e.part_of_speech,
             e.pronunciation, e.senses, e.status, e.created_at, e.updated_at,
             (SELECT s.source_type FROM lexical_sources s
               WHERE s.lexical_entry_id = e.id
               ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS latest_source_type
      FROM lexical_entries e
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.normalized_spelling ASC, e.id ASC
      LIMIT $${params.length}
    `;
    const result = await this.pool.query<LexicalEntryRow & { latest_source_type: string | null }>(
      sql,
      params,
    );
    const rows = result.rows;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(toSummary),
      page: {
        cursor:
          hasMore && last
            ? encodeCursor({ normalizedSpelling: last.normalized_spelling, id: last.id })
            : null,
        hasMore,
      },
    };
  }

  async getDetail(id: string): Promise<LexicalEntryDetailDto> {
    const detail = await this.loadDetail(id);
    if (!detail) throw new NotFoundException("词条不存在");
    return detail;
  }

  async create(
    actor: UserRecord,
    input: CreateLexicalEntryInput,
    requestId: string,
  ): Promise<CreateOutcome> {
    const canonicalSpelling = input.canonicalSpelling.trim();

    const fieldErrors: { path: string; code: string; message: string }[] = [];
    for (const message of validateCanonicalSpelling(canonicalSpelling)) {
      fieldErrors.push({ path: "canonicalSpelling", code: "invalid", message });
    }
    for (const message of validatePartOfSpeech(input.partOfSpeech)) {
      fieldErrors.push({ path: "partOfSpeech", code: "invalid", message });
    }
    for (const message of validatePronunciation(input.pronunciation)) {
      fieldErrors.push({ path: "pronunciation", code: "invalid", message });
    }
    for (const message of validateSenses(input.senses)) {
      fieldErrors.push({ path: "senses", code: "invalid", message });
    }
    for (const message of validateSourceNote(input.sourceNote)) {
      fieldErrors.push({ path: "sourceNote", code: "invalid", message });
    }
    if (fieldErrors.length > 0) {
      throw new UnprocessableEntityException({ message: "词条输入不合法", fieldErrors });
    }

    const normalizedSpelling = normalizeSpelling(canonicalSpelling);
    const existing = await this.findCandidates(normalizedSpelling);
    const verdict = evaluateDuplicates({
      canonicalSpelling,
      existing,
      confirmDuplicate: input.confirmDuplicate ?? false,
    });
    if (verdict.kind === "duplicate_warning") {
      await this.auditDuplicateAttempt(
        actor,
        "admin.lexical_entry.duplicate_warning",
        canonicalSpelling,
        normalizedSpelling,
        verdict.candidates,
        requestId,
      );
      return { kind: "duplicate_warning", candidates: verdict.candidates };
    }
    if (verdict.kind === "duplicate_exact") {
      await this.auditDuplicateAttempt(
        actor,
        "admin.lexical_entry.duplicate_exact",
        canonicalSpelling,
        normalizedSpelling,
        [verdict.candidate],
        requestId,
      );
      return { kind: "duplicate_exact", candidate: verdict.candidate };
    }

    const senses = input.senses && input.senses.length > 0 ? input.senses : [];
    const partOfSpeech = input.partOfSpeech?.trim() ?? null;
    const pronunciation = input.pronunciation?.trim() ?? null;
    const contentHash = createHash("sha256")
      .update(
        JSON.stringify({
          canonicalSpelling,
          normalizedSpelling,
          partOfSpeech,
          pronunciation,
          senses,
        }),
      )
      .digest("hex");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<LexicalEntryRow>(
        `INSERT INTO lexical_entries
           (canonical_spelling, normalized_spelling, part_of_speech, pronunciation, senses, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'active')
         ON CONFLICT (canonical_spelling) DO NOTHING
         RETURNING id, canonical_spelling, normalized_spelling, part_of_speech, pronunciation,
                   senses, status, created_at, updated_at`,
        [
          canonicalSpelling,
          normalizedSpelling,
          partOfSpeech,
          pronunciation,
          JSON.stringify(senses),
        ],
      );
      const entry = inserted.rows[0];
      if (!entry) {
        // 并发竞态防线：另一个请求已插入完全相同的 canonical_spelling。
        await client.query("ROLLBACK");
        const blocker = await this.findCandidates(normalizedSpelling);
        const exact = blocker.find((c) => c.canonicalSpelling === canonicalSpelling) ?? blocker[0];
        if (!exact) {
          throw new Error("词条插入冲突但未找到现有词条");
        }
        await this.auditDuplicateAttempt(
          actor,
          "admin.lexical_entry.duplicate_exact",
          canonicalSpelling,
          normalizedSpelling,
          [exact],
          requestId,
        );
        return { kind: "duplicate_exact", candidate: exact };
      }

      await client.query(
        `INSERT INTO lexical_sources
           (lexical_entry_id, source_type, source_note, content_hash, created_by)
         VALUES ($1, 'manual', $2, $3, $4)
         ON CONFLICT (lexical_entry_id, source_type, content_hash) DO NOTHING`,
        [entry.id, input.sourceNote?.trim() || null, contentHash, actor.id],
      );

      await client.query(
        `INSERT INTO audit_events
           (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, 'admin.lexical_entry.create', 'lexical_entry', $2, NULL, $3::jsonb, $4)`,
        [
          actor.id,
          entry.id,
          JSON.stringify({
            canonicalSpelling,
            normalizedSpelling,
            partOfSpeech,
            duplicateConfirmed: input.confirmDuplicate === true,
            // 有意不写 senses/sourceNote：审计摘要不含大段未脱敏用户输入。
          }),
          requestId,
        ],
      );

      await client.query("COMMIT");
      const detail = await this.loadDetail(entry.id);
      if (!detail) throw new Error("词条插入后详情缺失");
      return { kind: "created", entry: detail };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** 管理员：编辑词条元数据（白名单）。来源事实不变；sourceNote 追加一条 manual 来源（append-only）。 */
  async update(
    actor: UserRecord,
    id: string,
    input: {
      partOfSpeech?: string;
      pronunciation?: string;
      senses?: { meaning: string; example?: string }[];
      sourceNote?: string;
    },
    requestId: string,
  ): Promise<LexicalEntryDetailDto> {
    const existing = await this.loadDetail(id);
    if (!existing) throw new NotFoundException("词条不存在");

    const fieldErrors: { path: string; code: string; message: string }[] = [];
    for (const message of validatePartOfSpeech(input.partOfSpeech)) {
      fieldErrors.push({ path: "partOfSpeech", code: "invalid", message });
    }
    for (const message of validatePronunciation(input.pronunciation)) {
      fieldErrors.push({ path: "pronunciation", code: "invalid", message });
    }
    for (const message of validateSenses(input.senses)) {
      fieldErrors.push({ path: "senses", code: "invalid", message });
    }
    if (fieldErrors.length > 0) {
      throw new UnprocessableEntityException({ message: "词条输入不合法", fieldErrors });
    }

    const senses = input.senses ? input.senses : existing.senses.map((s) => s);
    const partOfSpeech = input.partOfSpeech ? input.partOfSpeech.trim() : existing.partOfSpeech;
    const pronunciation =
      input.pronunciation === undefined ||
      input.pronunciation === null ||
      input.pronunciation.trim() === ""
        ? null
        : input.pronunciation.trim();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const before = stripDetail(existing);
      const updated = await client.query<LexicalEntryRow>(
        `UPDATE lexical_entries
           SET part_of_speech = $2, pronunciation = $3, senses = $4::jsonb, updated_at = now()
         WHERE id = $1
         RETURNING id, canonical_spelling, normalized_spelling, part_of_speech, pronunciation, senses, status, created_at, updated_at`,
        [id, partOfSpeech, pronunciation, JSON.stringify(senses)],
      );
      if (!updated.rows[0]) throw new NotFoundException("词条不存在");

      // sourceNote 追加一条 manual 来源（append-only provenance；既有来源不变）。
      if (input.sourceNote?.trim()) {
        await client.query(
          `INSERT INTO lexical_sources (lexical_entry_id, source_type, source_note, content_hash, created_by)
           VALUES ($1, 'manual', $2, $3, $4)`,
          [
            id,
            input.sourceNote.trim(),
            createHash("sha256")
              .update(JSON.stringify({ senses, partOfSpeech, pronunciation }))
              .digest("hex"),
            actor.id,
          ],
        );
      }

      await client.query(
        `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, 'admin.lexical_entry.update', 'lexical_entry', $2, $3::jsonb, $4::jsonb, $5)`,
        [
          actor.id,
          id,
          JSON.stringify({ before }),
          JSON.stringify({
            partOfSpeech,
            pronunciation,
            sourceNoteAdded: !!input.sourceNote?.trim(),
          }),
          requestId,
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    const detail = await this.loadDetail(id);
    if (!detail) throw new Error("词条更新后详情缺失");
    return detail;
  }

  /** 管理员：归档词条（仅当没有被草稿/发布词项引用，否则 fail-closed 422）。 */
  async archive(actor: UserRecord, id: string, requestId: string): Promise<LexicalEntryDetailDto> {
    const existing = await this.loadDetail(id);
    if (!existing) throw new NotFoundException("词条不存在");
    if (existing.status === "archived") return existing;

    const refs = await this.pool.query<{ n: string }>(
      `SELECT (SELECT count(*)::text FROM draft_course_items WHERE lexical_entry_id = $1)
              || '/' ||
              (SELECT count(*)::text FROM released_course_items WHERE lexical_entry_id = $1) AS n`,
      [id],
    );
    const [draftRefs] = (refs.rows[0]?.n ?? "0/0").split("/");
    if (Number(draftRefs) > 0) {
      throw new UnprocessableEntityException({
        message: "该词条正被草稿课程词项引用，不能归档",
        fieldErrors: [{ path: "status", code: "archived_referenced", message: "正被草稿引用" }],
      });
    }

    await this.updateStatus(actor, id, "archived", requestId);
    const detail = await this.loadDetail(id);
    if (!detail) throw new Error("词条状态更新后详情缺失");
    return detail;
  }

  /** 管理员：重新激活归档词条。 */
  async activate(actor: UserRecord, id: string, requestId: string): Promise<LexicalEntryDetailDto> {
    const existing = await this.loadDetail(id);
    if (!existing) throw new NotFoundException("词条不存在");
    if (existing.status === "active") return existing;
    await this.updateStatus(actor, id, "active", requestId);
    const detail = await this.loadDetail(id);
    if (!detail) throw new Error("词条状态更新后详情缺失");
    return detail;
  }

  private async updateStatus(
    actor: UserRecord,
    id: string,
    status: "active" | "archived",
    requestId: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<LexicalEntryRow>(
        `UPDATE lexical_entries SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, status`,
        [id, status],
      );
      if (!updated.rows[0]) throw new NotFoundException("词条不存在");
      await client.query(
        `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, $2, 'lexical_entry', $3, NULL, $4::jsonb, $5)`,
        [
          actor.id,
          status === "archived" ? "admin.lexical_entry.archive" : "admin.lexical_entry.activate",
          id,
          JSON.stringify({ status }),
          requestId,
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async findCandidates(normalizedSpelling: string): Promise<DuplicateCandidateDto[]> {
    const result = await this.pool.query<DuplicateCandidateRow>(
      `SELECT id, canonical_spelling, normalized_spelling
       FROM lexical_entries WHERE normalized_spelling = $1
       ORDER BY created_at ASC, id ASC`,
      [normalizedSpelling],
    );
    return result.rows.map((r) => ({
      id: r.id,
      canonicalSpelling: r.canonical_spelling,
      normalizedSpelling: r.normalized_spelling,
    }));
  }

  /** 重复阻断（警告/冲突）也写入审计；摘要只含短拼写与候选 ID，不含大段用户输入。 */
  private async auditDuplicateAttempt(
    actor: UserRecord,
    action: string,
    canonicalSpelling: string,
    normalizedSpelling: string,
    candidates: DuplicateCandidateDto[],
    requestId: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events
         (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
       VALUES ($1, $2, 'lexical_entry', $3, NULL, $4::jsonb, $5)`,
      [
        actor.id,
        action,
        candidates[0]?.id ?? "",
        JSON.stringify({
          canonicalSpelling,
          normalizedSpelling,
          duplicateCandidates: candidates.map((c) => c.id),
        }),
        requestId,
      ],
    );
  }

  private async loadDetail(id: string): Promise<LexicalEntryDetailDto | null> {
    const result = await this.pool.query<LexicalEntryRow & { latest_source_type: string | null }>(
      `SELECT e.id, e.canonical_spelling, e.normalized_spelling, e.part_of_speech,
              e.pronunciation, e.senses, e.status, e.created_at, e.updated_at,
              (SELECT s.source_type FROM lexical_sources s
                WHERE s.lexical_entry_id = e.id
                ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS latest_source_type
       FROM lexical_entries e WHERE e.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;

    const [provenance, recentOperations] = await Promise.all([
      this.loadProvenance(id),
      this.loadRecentOperations(id),
    ]);
    return {
      id: row.id,
      canonicalSpelling: row.canonical_spelling,
      normalizedSpelling: row.normalized_spelling,
      partOfSpeech: row.part_of_speech,
      pronunciation: row.pronunciation,
      senses: Array.isArray(row.senses) ? (row.senses as LexicalEntryDetailDto["senses"]) : [],
      status: row.status,
      sourceStatus: row.latest_source_type ?? "manual",
      // 课程词项工单（03）落地后在此按 lexicalEntryId 统计 draft/release 引用；当前恒为 0。
      referenceCount: 0,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      provenance,
      recentOperations,
    };
  }

  private async loadProvenance(id: string): Promise<LexicalEntryDetailDto["provenance"]> {
    const result = await this.pool.query<{
      source_type: string;
      source_note: string | null;
      content_hash: string;
      created_by_username: string | null;
      created_at: Date;
    }>(
      `SELECT s.source_type, s.source_note, s.content_hash, s.created_at,
              u.username AS created_by_username
       FROM lexical_sources s
       LEFT JOIN users u ON u.id = s.created_by
       WHERE s.lexical_entry_id = $1
       ORDER BY s.created_at ASC, s.id ASC`,
      [id],
    );
    return result.rows.map((r) => ({
      sourceType: r.source_type,
      sourceNote: r.source_note,
      contentHash: r.content_hash,
      createdByUsername: r.created_by_username,
      createdAt: r.created_at.toISOString(),
    }));
  }

  private async loadRecentOperations(
    id: string,
  ): Promise<LexicalEntryDetailDto["recentOperations"]> {
    const result = await this.pool.query<{ action: string; created_at: Date }>(
      `SELECT action, created_at FROM audit_events
       WHERE target_type = 'lexical_entry' AND target_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 10`,
      [id],
    );
    return result.rows.map((r) => ({ action: r.action, createdAt: r.created_at.toISOString() }));
  }
}

function toSummary(
  row: LexicalEntryRow & { latest_source_type: string | null },
): LexicalEntrySummaryDto {
  return {
    id: row.id,
    canonicalSpelling: row.canonical_spelling,
    normalizedSpelling: row.normalized_spelling,
    partOfSpeech: row.part_of_speech,
    sourceStatus: row.latest_source_type ?? "manual",
    // 课程词项工单落地前引用次数恒为 0（预留 lexicalEntryId 查询边界）。
    referenceCount: 0,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 审计用的纯数据副本（不含大段未脱敏用户输入；只保留关键字段）。 */
function stripDetail(d: LexicalEntryDetailDto): Record<string, unknown> {
  return {
    canonicalSpelling: d.canonicalSpelling,
    normalizedSpelling: d.normalizedSpelling,
    partOfSpeech: d.partOfSpeech,
    status: d.status,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(key: { normalizedSpelling: string; id: string }): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function invalidCursor(message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: "游标无效",
    fieldErrors: [{ path: "cursor", code: "invalid", message }],
  });
}

function decodeCursor(cursor: string): { normalizedSpelling: string; id: string } {
  let parsed: { normalizedSpelling?: unknown; id?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      normalizedSpelling?: unknown;
      id?: unknown;
    };
  } catch {
    throw invalidCursor("游标无法解析");
  }
  if (typeof parsed.normalizedSpelling !== "string" || typeof parsed.id !== "string") {
    throw invalidCursor("游标缺少必需字段");
  }
  if (!UUID_RE.test(parsed.id)) {
    throw invalidCursor("游标中的词条 ID 非法");
  }
  return { normalizedSpelling: parsed.normalizedSpelling, id: parsed.id };
}
