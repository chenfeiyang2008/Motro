// 导入批次/行读仓库（阶段 6 工单 01 + 工单 02）：管理员共享内容域。
// 只返回文件元数据与映射/校验事实，不含磁盘路径/存储键。
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { POOL } from "../../../auth/database.provider.js";
import type {
  ImportBatchDetailDto,
  ImportCommitResultDto,
  ImportRowDto,
  StoredFileMetaDto,
} from "./import.dto.js";

interface BatchDetailRow {
  id: string;
  format: string;
  source_declaration: string;
  status: string;
  version: number;
  mapping_version: number;
  current_mapping: unknown | null;
  selected_sheet: string | null;
  validation_status: string;
  validation_summary: unknown | null;
  validation_input_sha256: string | null;
  uploaded_by: string;
  created_at: Date;
  updated_at: Date | null;
  file_id: string;
  original_filename: string;
  sniffed_mime: string;
  byte_size: number;
  sha256_hex: string;
  file_uploaded_by: string;
  purpose: string;
  file_status: string;
  file_format: string;
  file_created_at: Date;
}

const DETAIL_SELECT = `
  SELECT b.id, b.format, b.source_declaration, b.status, b.version,
         b.mapping_version, b.current_mapping, b.selected_sheet, b.validation_status,
         b.validation_summary, b.validation_input_sha256, b.uploaded_by, b.created_at, b.updated_at,
         f.id AS file_id, f.original_filename, f.sniffed_mime, f.byte_size, f.sha256_hex,
         f.uploaded_by AS file_uploaded_by, f.purpose, f.status AS file_status,
         f.format AS file_format, f.created_at AS file_created_at
  FROM import_batches b
  JOIN stored_files f ON f.id = b.file_id`;

interface RowRow {
  id: string;
  ordinal: number;
  mapping_version: number;
  raw_summary: string;
  normalized_spelling: string | null;
  status: string;
  errors: unknown;
  duplicate_of_ordinal: number | null;
  lexical_entry_id: string | null;
  // 提交状态投影（由不可变提交事实推导；无提交事实时为 null）。
  commit_status: string | null;
  commit_created_at: Date | null;
  commit_committed_by: string | null;
  commit_lexical_entry_id: string | null;
}

@Injectable()
export class ImportBatchRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /** 管理员共享列表（全部批次元数据，倒序）。 */
  async listAll(limit = 100): Promise<ImportBatchDetailDto[]> {
    const result = await this.pool.query<BatchDetailRow>(
      `${DETAIL_SELECT}
       ORDER BY b.created_at DESC, b.id ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(toDetailDto);
  }

  /** 批次详情（含映射/校验事实与文件元数据）。不存在 → 404。 */
  async getDetail(id: string): Promise<ImportBatchDetailDto> {
    const result = await this.pool.query<BatchDetailRow>(
      `${DETAIL_SELECT}
       WHERE b.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("导入批次不存在");
    // 计算 stale：行事实的最新 mappingVersion 是否落后于批次的 mappingVersion。
    const staleRow = await this.pool.query<{ max_mv: number | null }>(
      `SELECT max(mapping_version) AS max_mv FROM import_rows WHERE batch_id = $1`,
      [id],
    );
    const latestRowMv = staleRow.rows[0]?.max_mv ?? 0;
    const dto = toDetailDto(row, latestRowMv);
    const summary = await this.loadCommitSummary(id);
    if (summary) dto.commitSummary = summary;
    // P1-1：仅在当前已校验且非 stale 时暴露提交确认身份（客户端必须原样回传）。
    if (row.validation_status === "validated" && !dto.isStale && row.validation_input_sha256) {
      dto.commitConfirmation = {
        mappingVersion: row.mapping_version,
        validationInputSha256: row.validation_input_sha256,
      };
    }
    return dto;
  }

  /** 加载某批次最近一次提交事实摘要（无提交 → undefined）。 */
  private async loadCommitSummary(batchId: string): Promise<ImportCommitResultDto | undefined> {
    const r = await this.pool.query<{
      mapping_version: number;
      created_entry_count: number;
      associated_existing_entry_count: number;
      committed_row_count: number;
      skipped_counts: unknown;
      created_at: Date;
    }>(
      `SELECT mapping_version, created_entry_count, associated_existing_entry_count,
              committed_row_count, skipped_counts, created_at
       FROM import_batch_commits
       WHERE batch_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [batchId],
    );
    const c = r.rows[0];
    if (!c) return undefined;
    return {
      batchId,
      mappingVersion: c.mapping_version,
      committedAt: c.created_at.toISOString(),
      createdEntryCount: c.created_entry_count,
      associatedExistingEntryCount: c.associated_existing_entry_count,
      skippedCountByDisposition: (c.skipped_counts as Record<string, number>) ?? {},
      committedRowCount: c.committed_row_count,
      isIdempotentReplay: false,
    };
  }

  /** 按映射版本读取某批次（乐观并发）。返回 null 表示不存在/版本不匹配。 */
  async getByIdWithVersion(
    id: string,
    expectedVersion: number,
  ): Promise<ImportBatchDetailDto | null> {
    const result = await this.pool.query<BatchDetailRow>(
      `${DETAIL_SELECT}
       WHERE b.id = $1 AND b.version = $2`,
      [id, expectedVersion],
    );
    const row = result.rows[0];
    return row ? toDetailDto(row) : null;
  }

  /**
   * 分页读取某批次的行（按 ordinal 升序；cursor 为上一页最后一行 ordinal）。
   * 默认只读当前 mappingVersion 的行（不混入历史版本）；如需历史版本，
   * 调用方显式传入 mappingVersion（P1-3）。
   */
  async listRows(
    batchId: string,
    mappingVersion: number | null,
    cursor: number | null,
    limit: number,
  ): Promise<{ items: RowRow[]; nextCursor: number | null; hasMore: boolean }> {
    const baseLimit = Math.max(1, Math.min(limit, 100));
    // 多取一条判断 hasMore。
    const fetchLimit = baseLimit + 1;
    const params: unknown[] = [batchId];
    let where = " AND r.mapping_version = $2";
    params.push(mappingVersion);
    if (cursor !== null) {
      where += " AND r.ordinal > $3";
      params.push(cursor);
    }
    const result = await this.pool.query<RowRow>(
      `SELECT r.id, r.ordinal, r.mapping_version, r.raw_summary, r.normalized_spelling,
              r.status, r.errors, r.duplicate_of_ordinal, r.lexical_entry_id,
              CASE WHEN cr.import_row_id IS NULL THEN NULL ELSE 'committed' END AS commit_status,
              c.created_at AS commit_created_at,
              c.committed_by AS commit_committed_by,
              cr.lexical_entry_id AS commit_lexical_entry_id
       FROM import_rows r
       LEFT JOIN import_batch_commit_rows cr ON cr.import_row_id = r.id
       LEFT JOIN import_batch_commits c ON c.id = cr.commit_id
       WHERE r.batch_id = $1${where}
       ORDER BY r.ordinal ASC
       LIMIT $${params.length + 1}`,
      [...params, fetchLimit],
    );
    const rows = result.rows;
    const hasMore = rows.length > baseLimit;
    const page = rows.slice(0, baseLimit);
    const last = page[page.length - 1];
    return { items: page, nextCursor: hasMore && last ? last.ordinal : null, hasMore };
  }
}

/** 把批次详情行 + 文件元数据映射为 ImportBatchDetailDto。 */
function toDetailDto(row: BatchDetailRow, latestRowMv = 0): ImportBatchDetailDto {
  const file: StoredFileMetaDto = {
    fileId: row.file_id,
    originalFilename: row.original_filename,
    sniffedMime: row.sniffed_mime,
    byteSize: Number(row.byte_size),
    sha256Hex: row.sha256_hex,
    uploadedBy: row.file_uploaded_by,
    purpose: row.purpose,
    status: row.file_status,
    format: row.file_format,
    createdAt: row.file_created_at.toISOString(),
  };
  const dto: ImportBatchDetailDto = {
    id: row.id,
    file,
    format: row.format,
    sourceDeclaration: row.source_declaration,
    status: row.status,
    version: row.version,
    validationStatus: row.validation_status,
    mappingVersion: row.mapping_version,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at.toISOString(),
    nextStep: row.status,
    // stale：批次 mappingVersion 高于其行事实的最新 mappingVersion（映射已变但未重校验）。
    isStale:
      row.validation_status === "validated" && latestRowMv > 0 && latestRowMv < row.mapping_version,
  };
  if (row.current_mapping !== null && row.current_mapping !== undefined) {
    const m = row.current_mapping as { spellingField?: string; sheet?: string };
    dto.mapping = {};
    if (m.spellingField !== undefined) dto.mapping.spellingField = m.spellingField;
    if (m.sheet !== undefined) dto.mapping.sheet = m.sheet;
  }
  if (row.validation_summary !== null && row.validation_summary !== undefined) {
    const s = row.validation_summary as {
      candidates?: number;
      duplicates?: number;
      existingEntries?: number;
      invalid?: number;
      ignored?: number;
      total?: number;
    };
    dto.validationSummary = {
      candidates: s.candidates ?? 0,
      duplicates: s.duplicates ?? 0,
      existingEntries: s.existingEntries ?? 0,
      invalid: s.invalid ?? 0,
      ignored: s.ignored ?? 0,
      total: s.total ?? 0,
    };
  }
  if (row.updated_at) dto.updatedAt = row.updated_at.toISOString();
  return dto;
}

/** 把行事实行映射为 DTO（errors 已是脱敏 JSON 数组）。 */
export function toRowDto(row: RowRow): ImportRowDto {
  const errors = Array.isArray(row.errors)
    ? (row.errors as { code?: string }[]).map((e) => e.code ?? "unknown")
    : [];
  const committed = row.commit_status === "committed";
  // 提交状态投影：已提交行以「提交事实」为权威（关联词条 = commit 行的 canonical entry）；
  // 未提交行回退到校验分类携带的关联（existing_entry 的 lexical_entry_id）。
  const entryId = committed
    ? (row.commit_lexical_entry_id ?? row.lexical_entry_id)
    : row.lexical_entry_id;
  const dto: ImportRowDto = {
    id: row.id,
    ordinal: row.ordinal,
    rawSummary: row.raw_summary,
    status: row.status,
    errors,
    mappingVersion: row.mapping_version,
    commitStatus: committed ? "committed" : "not_committed",
    ...(row.normalized_spelling ? { normalizedSpelling: row.normalized_spelling } : {}),
    ...(row.duplicate_of_ordinal !== null ? { duplicateOfOrdinal: row.duplicate_of_ordinal } : {}),
    ...(entryId ? { lexicalEntryId: entryId } : {}),
    ...(committed && row.commit_created_at
      ? { committedAt: row.commit_created_at.toISOString() }
      : {}),
    ...(committed && row.commit_committed_by ? { committedBy: row.commit_committed_by } : {}),
  };
  return dto;
}
