// 导入服务（阶段 6 工单 01，二轮审查修复）：
// - P1-1：Idempotency-Key 的 request hash 含文件内容 SHA-256；先哈希落盘再判幂等；
//   同 key 不同内容/元数据 → 409；重放/冲突路径清理临时文件。
// - P1-2：幂等 claim/complete 与 stored_files/import_batches/audit 在同一事务；失败不留 pending。
// - P1-3：嗅探只判「内容类别」utf8/json；.txt/.csv 接受 utf8，.json 只接受 json。
// - P1-4：同上传人同内容不同来源 → 409 IMPORT_CONTENT_CONFLICT（不再由 DB 唯一撞误报 400）。
import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { Transform } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { POOL } from "../../../auth/database.provider.js";
import { APP_CONFIG } from "./tokens.js";
import type { AppConfig } from "@motro/config";
import {
  contentClassAllowedForExtension,
  declaredMimeConsistent,
  generateStorageKey,
  sniffFileContent,
  validateImportFilename,
  validateImportSize,
} from "@motro/domain";
import type { ImportBatchDto, StoredFileMetaDto } from "./import.dto.js";

const IDEMPOTENCY_SCOPE_PREFIX = "import:batch:create";

export interface UploadInput {
  fileStream: NodeJS.ReadableStream;
  filename: string;
  declaredMime: string;
  sourceDeclaration: string;
  idempotencyKey: string;
  userId: string;
  requestId: string;
}

interface UploadResult {
  batch: ImportBatchDto;
  idempotentReplay: boolean;
  /** 是否创建了新的 stored_file 或新的 import_batch；false 表示完全复用了既有事实（返回 200）。 */
  created: boolean;
}

export class ImportWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportWriteError";
  }
}

export class ImportIdempotencyConflictError extends Error {
  constructor(message = "该 Idempotency-Key 已被不同的请求内容占用") {
    super(message);
    this.name = "ImportIdempotencyConflictError";
  }
}

export class ImportIdempotencyInProgressError extends Error {
  constructor() {
    super("该请求正在处理中，请稍后重试");
    this.name = "ImportIdempotencyInProgressError";
  }
}

export class ImportContentConflictError extends Error {
  constructor(
    message: string,
    public readonly existingBatchId: string,
  ) {
    super(message);
    this.name = "ImportContentConflictError";
  }
}

interface StoredFileRow {
  id: string;
  storage_key: string;
  original_filename: string;
  declared_mime: string;
  sniffed_mime: string;
  byte_size: number;
  sha256_hex: string;
  uploaded_by: string;
  purpose: string;
  status: string;
  format: string;
  created_at: Date;
}

interface BatchRow {
  id: string;
  file_id: string;
  format: string;
  source_declaration: string;
  status: string;
  version: number;
  uploaded_by: string;
  created_at: Date;
  updated_at: Date | null;
}

interface DiskWriteOutcome {
  sha256: string;
  byteSize: number;
  sniffBuffer: Buffer;
}

type IdemClaim = { kind: "claimed" } | { kind: "replay"; batch: ImportBatchDto };

@Injectable()
export class ImportService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async uploadAndCreateBatch(input: UploadInput): Promise<UploadResult> {
    const importConfig = this.config.import;
    const { userId, idempotencyKey } = input;
    const source = input.sourceDeclaration.trim();

    if (!source) throw new ImportWriteError("来源声明不能为空");
    if (source.length > 500) throw new ImportWriteError("来源声明过长");

    const nameCheck = validateImportFilename(input.filename, importConfig.allowedFormats);
    if (!nameCheck.ok || !nameCheck.format) {
      throw new ImportWriteError(`文件名不合法：${nameCheck.error ?? "未知"}`);
    }

    const storageDir = resolve(process.cwd(), importConfig.fileRootDir);
    mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    const storageKey = generateStorageKey("import");
    const storagePath = resolve(storageDir, storageKey);

    // 先去重哈希落盘 + 内容嗅探（P1-1 需在拿到 SHA-256 后才判定幂等）。
    let disk: DiskWriteOutcome;
    try {
      disk = await this.writeAndSniff(input.fileStream, storagePath, importConfig.maxFileBytes);
    } catch (err) {
      this.safeUnlink(storagePath);
      // P1-1：写盘失败（文件系统错误）不得包装为面向用户的 ImportWriteError，
      // 原样上抛，由全局异常过滤器返回脱敏 500。仅明确的大小超限是用户错误（已在 writeAndSniff 抛 ImportWriteError）。
      if (err instanceof ImportWriteError) throw err;
      throw err;
    }
    const { sha256, byteSize, sniffBuffer } = disk;

    const sizeErrors = validateImportSize(byteSize, importConfig.maxFileBytes);
    if (sizeErrors.length > 0) {
      this.safeUnlink(storagePath);
      throw new ImportWriteError(sizeErrors.join("; "));
    }

    const sniff = sniffFileContent(sniffBuffer);
    if (!sniff.ok) {
      this.safeUnlink(storagePath);
      throw new ImportWriteError(sniff.error);
    }
    const contentClass = sniff.result.content;
    const sniffedMime: string = sniff.result.sniffedMime;

    // P1-3：扩展名与内容类别一致。
    if (!contentClassAllowedForExtension(contentClass, nameCheck.format)) {
      this.safeUnlink(storagePath);
      throw new ImportWriteError(`文件内容（${contentClass}）与扩展名（${nameCheck.format}）不符`);
    }
    // 声明 MIME 与内容类别一致。
    if (!declaredMimeConsistent(input.declaredMime, sniffedMime)) {
      this.safeUnlink(storagePath);
      throw new ImportWriteError("声明的 MIME 与文件内容不一致");
    }

    // P1-1：request hash 含 SHA-256。
    const requestHash = this.requestHash({
      source,
      filename: input.filename,
      declaredMime: input.declaredMime,
      sha256,
    });

    // P1-2：全部数据库操作同一事务。
    // P1-3：把 pool.connect() 也纳入统一清理边界——连接失败也须清理本轮磁盘临时文件。
    let client: PoolClient | null = null;
    let began = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      began = true;

      // claim（事务内）：同 key 已存在则重放，需回滚本轮船的临时动作。
      const claim = await this.claimIdempotency(client, userId, idempotencyKey, requestHash);
      if (claim.kind === "replay") {
        await client.query("ROLLBACK").catch(() => {});
        this.safeUnlink(storagePath);
        return { batch: claim.batch, idempotentReplay: true, created: false };
      }

      // P1-5：并发安全。对 (userId, sha256) 做事务级 advisory lock，串行化「先查后插」的
      // 文件去重：两个并发（不同 key、同内容）不会同时误判文件不存在而撞唯一约束。
      await client.query("SELECT pg_advisory_xact_lock($1)", [this.contentLockKey(userId, sha256)]);

      // 去重：同 (uploaded_by, sha)。
      const existingFile = await client.query<StoredFileRow>(
        `SELECT * FROM stored_files WHERE uploaded_by = $1 AND sha256_hex = $2 FOR UPDATE`,
        [userId, sha256],
      );
      let fileRow = existingFile.rows[0];
      const dedupReused = !!existingFile.rows[0];
      let created = !dedupReused; // 新建文件行则视为“创建”。

      if (fileRow) {
        // P1-4：同上传人同内容不同来源 → 明确 409 IMPORT_CONTENT_CONFLICT。
        const priorBatch = await client.query<BatchRow>(
          `SELECT * FROM import_batches WHERE file_id = $1`,
          [fileRow.id],
        );
        const prior = priorBatch.rows[0];
        if (prior && prior.source_declaration !== source) {
          throw new ImportContentConflictError("相同文件已使用不同的来源声明导入", prior.id);
        }
        // 同一来源但批次不存在（应已有），仍可继续；若无批次则下面会建。
        // 去重命中：丢弃本轮临时文件。
        this.safeUnlink(storagePath);
      } else {
        // 新建文件行：文件保留在磁盘（它就是原始导入件）。
        // P1-1：保存用户已验证的文件格式（txt/csv/json），内容类别只用于安全验证，不覆盖。
        const fileFormat = nameCheck.format;
        const ins = await client.query<StoredFileRow>(
          `INSERT INTO stored_files
             (storage_key, original_filename, declared_mime, sniffed_mime, byte_size, sha256_hex, uploaded_by, purpose, format)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'original_import',$8)
           RETURNING id, storage_key, original_filename, declared_mime, sniffed_mime, byte_size, sha256_hex, uploaded_by, purpose, status, format, created_at`,
          [
            storageKey,
            input.filename,
            input.declaredMime,
            sniffedMime,
            byteSize,
            sha256,
            userId,
            fileFormat,
          ],
        );
        fileRow = ins.rows[0]!;
      }

      // 批次：同 (file_id, source) 复用。
      const existingBatch = await client.query<BatchRow>(
        `SELECT * FROM import_batches WHERE file_id = $1 AND source_declaration = $2`,
        [fileRow.id, source],
      );
      let batchRow = existingBatch.rows[0];
      if (!batchRow) {
        const insB = await client.query<BatchRow>(
          `INSERT INTO import_batches (file_id, uploaded_by, format, source_declaration, status, version)
           VALUES ($1,$2,$3,$4,'uploaded',1)
           RETURNING id, file_id, format, source_declaration, status, version, uploaded_by, created_at, updated_at`,
          [fileRow.id, userId, fileRow.format, source],
        );
        batchRow = insB.rows[0]!;
        created = true; // 新批次 → 创建。
      }

      // P1-4：只有真正新增 import_batches 行才记录“create”；复用既有 batch 记录“reuse”，
      // 绝不把复用伪造为创建。
      const isNewBatch = created;
      const auditAction = isNewBatch ? "admin.import.batch.create" : "admin.import.batch.reuse";
      await client.query(
        `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, $2, 'import_batch', $3, NULL, $4::jsonb, $5)`,
        [
          userId,
          auditAction,
          batchRow.id,
          JSON.stringify({
            fileId: fileRow.id,
            format: fileRow.format,
            sourceDeclaration: truncate(source),
            dedupReused,
          }),
          input.requestId,
        ],
      );

      const batch: ImportBatchDto = {
        id: batchRow.id,
        file: toFileMeta(fileRow),
        format: fileRow.format,
        sourceDeclaration: source,
        status: batchRow.status,
        version: batchRow.version,
        uploadedBy: userId,
        createdAt: batchRow.created_at.toISOString(),
        ...(batchRow.updated_at ? { updatedAt: batchRow.updated_at.toISOString() } : {}),
      };

      await this.completeIdempotency(client, userId, idempotencyKey, batch);

      await client.query("COMMIT");
      return { batch, idempotentReplay: false, created };
    } catch (err) {
      if (began && client) await client.query("ROLLBACK").catch(() => {});
      this.safeUnlink(storagePath);
      if (err instanceof ImportWriteError) throw err;
      if (err instanceof ImportIdempotencyConflictError) throw err;
      if (err instanceof ImportContentConflictError) throw err;
      if (err instanceof ImportIdempotencyInProgressError) throw err;
      // P1-1：数据库/约束/trigger 等未知异常原样上抛，由全局异常过滤器返回脱敏 500。
      throw err;
    } finally {
      if (client) client.release();
    }
  }

  private async claimIdempotency(
    client: PoolClient,
    userId: string,
    key: string,
    requestHash: string,
  ): Promise<IdemClaim> {
    const scope = `${IDEMPOTENCY_SCOPE_PREFIX}:${userId}`;
    const claim = await client.query<{ response_json: unknown }>(
      `INSERT INTO idempotency_keys (scope, key, request_hash, response_json) VALUES ($1,$2,$3,$4)
       ON CONFLICT (scope, key) DO NOTHING RETURNING response_json`,
      [scope, key, requestHash, JSON.stringify({ pending: true })],
    );
    if ((claim.rowCount ?? 0) > 0) return { kind: "claimed" };
    const existing = await client.query<{ response_json: unknown; request_hash: string }>(
      `SELECT response_json, request_hash FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const row = existing.rows[0];
    if (!row) return { kind: "claimed" };
    if (row.request_hash !== requestHash) {
      throw new ImportIdempotencyConflictError();
    }
    const payload = row.response_json as { pending?: boolean } | null;
    if (payload && "pending" in payload) throw new ImportIdempotencyInProgressError();
    return { kind: "replay", batch: row.response_json as ImportBatchDto };
  }

  private async completeIdempotency(
    client: PoolClient,
    userId: string,
    key: string,
    batch: ImportBatchDto,
  ): Promise<void> {
    const scope = `${IDEMPOTENCY_SCOPE_PREFIX}:${userId}`;
    await client.query(
      `UPDATE idempotency_keys SET response_json = $3, resource_id = $4
       WHERE scope = $1 AND key = $2`,
      [scope, key, JSON.stringify(batch), batch.id],
    );
  }

  /** 内容级 advisory lock key：由 (userId, sha256) 哈希为主键范围整数。 */
  private contentLockKey(userId: string, sha256: string): bigint {
    const digest = createHash("sha256").update(`import-content:${userId}:${sha256}`).digest();
    const u64 = digest.subarray(0, 8).readBigUInt64BE(0);
    return u64 & 0x7fffffffffffffffn;
  }

  /**
   * 幂等请求语义的无歧义编码：用 JSON 数组序列化，避免 `|` 分隔符碰撞。
   * 用户字段可含任意字符（含 `|`、`\n` 等），JSON.stringify 保证结构唯一。
   */
  private requestHash(v: {
    source: string;
    filename: string;
    declaredMime: string;
    sha256: string;
  }): string {
    const canonical = JSON.stringify(["import", v.source, v.filename, v.declaredMime, v.sha256]);
    return createHash("sha256").update(canonical).digest("hex");
  }

  private async writeAndSniff(
    fileStream: NodeJS.ReadableStream,
    storagePath: string,
    maxBytes: number,
  ): Promise<DiskWriteOutcome> {
    const hasher = createHash("sha256");
    let byteSize = 0;
    // P1-2：保留完整内容供 JSON 验证（受 IMPORT_MAX_FILE_BYTES 限制，内存有界）。
    // 不截断到固定 512 KiB——否则合法的大 JSON 会因被截断而 JSON.parse 失败。
    const sniffChunks: Buffer[] = [];

    const collect = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        byteSize += chunk.length;
        hasher.update(chunk);
        if (byteSize > maxBytes) {
          cb(new ImportWriteError(`文件不能超过 ${maxBytes} 字节`));
          return;
        }
        sniffChunks.push(chunk);
        cb();
      },
    });

    const out = createWriteStream(storagePath, { mode: 0o600 });
    await pipeline(fileStream, collect, out);

    return { sha256: hasher.digest("hex"), byteSize, sniffBuffer: Buffer.concat(sniffChunks) };
  }

  private safeUnlink(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // 运维清理。
    }
  }
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function toFileMeta(row: StoredFileRow): StoredFileMetaDto {
  return {
    fileId: row.id,
    originalFilename: row.original_filename,
    sniffedMime: row.sniffed_mime,
    byteSize: Number(row.byte_size),
    sha256Hex: row.sha256_hex,
    uploadedBy: row.uploaded_by,
    purpose: row.purpose,
    status: row.status,
    format: row.format,
    createdAt: row.created_at.toISOString(),
  };
}
