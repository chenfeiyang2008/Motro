// 导入批次读仓库：管理员共享内容域（任意管理员可读任意批次）；学习者由角色守卫拒绝。
// 只返回文件元数据，不含磁盘路径/存储键。
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { POOL } from "../../../auth/database.provider.js";
import type { ImportBatchDto, StoredFileMetaDto } from "./import.dto.js";

interface BatchJoinRow {
  id: string;
  format: string;
  source_declaration: string;
  status: string;
  version: number;
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

const JOIN_SELECT = `
  SELECT b.id, b.format, b.source_declaration, b.status, b.version, b.uploaded_by,
         b.created_at, b.updated_at,
         f.id AS file_id, f.original_filename, f.sniffed_mime, f.byte_size, f.sha256_hex,
         f.uploaded_by AS file_uploaded_by, f.purpose, f.status AS file_status,
         f.format AS file_format, f.created_at AS file_created_at
  FROM import_batches b
  JOIN stored_files f ON f.id = b.file_id`;

@Injectable()
export class ImportBatchRepository {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /** 管理员共享列表（全部批次，倒序）。 */
  async listAll(limit = 100): Promise<ImportBatchDto[]> {
    const result = await this.pool.query<BatchJoinRow>(
      `${JOIN_SELECT}
       ORDER BY b.created_at DESC, b.id ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(toBatchDto);
  }

  /** 单个批次；不存在 → 404（学习者由守卫在进入前拒绝）。 */
  async getById(id: string): Promise<ImportBatchDto> {
    const result = await this.pool.query<BatchJoinRow>(
      `${JOIN_SELECT}
       WHERE b.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("导入批次不存在");
    return toBatchDto(row);
  }
}

function toBatchDto(row: BatchJoinRow): ImportBatchDto {
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
  const dto: ImportBatchDto = {
    id: row.id,
    file,
    format: row.format,
    sourceDeclaration: row.source_declaration,
    status: row.status,
    version: row.version,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at.toISOString(),
  };
  if (row.updated_at) dto.updatedAt = row.updated_at.toISOString();
  return dto;
}
