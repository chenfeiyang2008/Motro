// 导入服务（阶段 6 工单 01，二轮审查修复）：
// - P1-1：Idempotency-Key 的 request hash 含文件内容 SHA-256；先哈希落盘再判幂等；
//   同 key 不同内容/元数据 → 409；重放/冲突路径清理临时文件。
// - P1-2：幂等 claim/complete 与 stored_files/import_batches/audit 在同一事务；失败不留 pending。
// - P1-3：嗅探只判「内容类别」utf8/json；.txt/.csv 接受 utf8，.json 只接受 json。
// - P1-4：同上传人同内容不同来源 → 409 IMPORT_CONTENT_CONFLICT（不再由 DB 唯一撞误报 400）。
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
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
  validateFormatMapping,
  safeValueSummary,
  resolveRowDisposition,
  normalizeSpelling,
  mappingEquals,
  commitSemanticHash,
  errorReportCsvLine,
  ERROR_REPORT_CSV_HEADER,
  ERROR_REPORT_CSV_LINE_SEPARATOR,
  safeReportFilename,
  operationInputHash,
  enrichmentOperationTypes,
  type ImportMapping,
  type ImportRowIssue,
} from "@motro/domain";
import { ImportParser, ImportParseError } from "./import.parser.js";
import { ImportBatchRepository, toRowDto } from "./import.repository.js";
import { OperationEnqueueService } from "../../operations/enqueue.service.js";
import type {
  ImportBatchDetailDto,
  ImportBatchDto,
  ImportCommitResultDto,
  ImportMappingDto,
  ImportRowListDto,
  ImportValidationSummaryDto,
  StoredFileMetaDto,
} from "./import.dto.js";

const IDEMPOTENCY_SCOPE_PREFIX = "import:batch:create";
const VALIDATE_SCOPE_PREFIX = "import:validate";
const COMMIT_SCOPE_PREFIX = "import:commit";

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

/** 投递后台任务失败：必须连同整个业务事务一起回滚。 */
export class OperationEnqueueRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationEnqueueRollbackError";
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
    private readonly repository: ImportBatchRepository,
    private readonly parser: ImportParser,
    private readonly enqueuePort: OperationEnqueueService,
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
        // 必须把 chunk 转发给下游（写盘），否则上传的文件内容不会落盘。
        this.push(chunk);
        cb();
      },
    });

    const out = createWriteStream(storagePath, { mode: 0o600 });
    await pipeline(fileStream, collect, out);

    return { sha256: hasher.digest("hex"), byteSize, sniffBuffer: Buffer.concat(sniffChunks) };
  }

  /**
   * PATCH /admin/imports/{id}：更新映射/来源声明（乐观并发）。
   * - 映射变更：校验合法性 → 递增 mapping_version → 使旧校验结果失效（保留行事实，
   *   不改写历史行）→ 写审计。相同映射更新幂等，不递增版本。
   * - 来源声明更新：仅更新 source_declaration，不递增 mapping_version、不失效校验，
   *   写独立审计动作。乐观批次 version 仍保护并发元数据更新。
   */
  async updateBatch(
    batchId: string,
    mapping: ImportMapping | undefined,
    sourceDeclaration: string | undefined,
    expectedVersion: number,
    userId: string,
    requestId: string,
  ): Promise<ImportBatchDetailDto> {
    const batch = await this.repository.getByIdWithVersion(batchId, expectedVersion);
    if (!batch) throw new NotFoundException("导入批次不存在或版本已过期");

    // 校验映射对该格式合法。
    if (mapping !== undefined) {
      const mappingErrors = validateFormatMapping(batch.format, mapping);
      if (mappingErrors.length > 0) {
        const err = new Error(mappingErrors.map((e) => e.message).join("; "));
        (err as { code?: string }).code = "MAPPING_INVALID";
        throw err;
      }
    }
    // 来源声明校验：与初始上传一致（非空且 ≤500）。
    const trimmedSource = sourceDeclaration?.trim();
    if (sourceDeclaration !== undefined) {
      if (!trimmedSource) {
        const err = new Error("来源声明不能为空");
        (err as { code?: string }).code = "SOURCE_INVALID";
        throw err;
      }
      if (trimmedSource.length > 500) {
        const err = new Error("来源声明过长");
        (err as { code?: string }).code = "SOURCE_INVALID";
        throw err;
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        version: number;
        current_mapping: unknown;
        source_declaration: string;
      }>(
        `SELECT version, current_mapping, source_declaration FROM import_batches WHERE id = $1 FOR UPDATE`,
        [batchId],
      );
      const row = current.rows[0];
      if (!row || row.version !== expectedVersion) {
        await client.query("ROLLBACK").catch(() => {});
        throw new NotFoundException("导入批次不存在或版本已过期");
      }

      const existing = row.current_mapping as ImportMapping | null;
      const mappingChanged = !mappingEquals(existing ?? undefined, mapping ?? undefined);
      const sourceChanged =
        sourceDeclaration !== undefined && row.source_declaration !== trimmedSource;

      // 无实际变化 → 幂等，不递增版本。
      if (!mappingChanged && !sourceChanged) {
        await client.query("COMMIT");
        return this.repository.getDetail(batchId);
      }

      const nextVersion = row.version + 1;

      if (mappingChanged && mapping !== undefined) {
        const newMapping = mapping;
        await client.query(
          `UPDATE import_batches
           SET current_mapping = $2, selected_sheet = $3, version = $4,
               mapping_version = mapping_version + 1, updated_at = now()
           WHERE id = $1`,
          [batchId, JSON.stringify(newMapping), newMapping.sheet ?? null, nextVersion],
        );
        // 审计：映射确认/修改（与来源更新区分）。
        await client.query(
          `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
           VALUES ($1, $2, 'import_batch', $3, $4::jsonb, $5::jsonb, $6)`,
          [
            userId,
            "admin.import.mapping.update",
            batchId,
            JSON.stringify({ mappingVersion: row.version, mapping: existing ?? null }),
            JSON.stringify({ mappingVersion: row.version + 1, mapping: newMapping }),
            requestId,
          ],
        );
      }

      if (sourceChanged && trimmedSource) {
        await client.query(
          `UPDATE import_batches
           SET source_declaration = $2, version = $3, updated_at = now()
           WHERE id = $1`,
          [batchId, trimmedSource, nextVersion],
        );
        // 审计：来源声明更新（独立动作，不误报为映射变更）。
        await client.query(
          `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
           VALUES ($1, $2, 'import_batch', $3, $4::jsonb, $5::jsonb, $6)`,
          [
            userId,
            "admin.import.source.update",
            batchId,
            JSON.stringify({ source: truncate(row.source_declaration) }),
            JSON.stringify({ source: truncate(trimmedSource) }),
            requestId,
          ],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return this.repository.getDetail(batchId);
  }

  /** GET /admin/imports/{id}：批次详情 + 可用的工作表/字段发现结果。 */
  async getWithDiscovery(batchId: string): Promise<ImportBatchDetailDto> {
    const detail = await this.repository.getDetail(batchId);
    // 解析服务端已保存原件以发现可用工作表/字段（仅元数据，不校验）。
    const fileInfo = await this.pool.query<{ storage_key: string }>(
      `SELECT f.storage_key
       FROM import_batches b JOIN stored_files f ON f.id = b.file_id
       WHERE b.id = $1`,
      [batchId],
    );
    const file = fileInfo.rows[0];
    if (!file) return detail;
    try {
      const parsed = await this.parser.parse(file.storage_key, detail.format);
      detail.sheets = parsed.sheets;
      detail.fields = parsed.fields;
      // XLSX 各工作表字段集：UI 切换工作表时据此选择正确列。
      if (parsed.sheetFields) detail.sheetFields = parsed.sheetFields;
    } catch {
      // 解析失败不影响详情读取（元数据仍可展示）；字段发现失败不报错。
      void detail;
    }
    return detail;
  }

  /**
   * POST /admin/imports/{id}/validate：同步解析 + 逐行校验（幂等）。
   * - Idempotency-Key 必须；同 key + 同语义重放同一结果；同 key 不同语义 → 409。
   * - 解析服务端已保存原件（绝不信任浏览器内容）。
   * - 解析发生在幂等 claim 之前：解析失败 → 批次 marked failed、无半成品行、幂等键保持空闲可重试。
   * - 同一 mappingVersion 不重复写行；映射未确认时 422。
   */
  async validate(
    batchId: string,
    idempotencyKey: string,
    userId: string,
    requestId: string,
  ): Promise<ImportBatchDetailDto> {
    if (!idempotencyKey) {
      const err = new Error("缺少 Idempotency-Key 请求头");
      (err as { code?: string }).code = "IDEMPOTENCY_KEY_REQUIRED";
      throw err;
    }

    // 解析已保存原件（同步；本票不引入 Worker/202 假异步）。失败 → 单独标记批次 failed 并抛错。
    const fileInfo = await this.pool.query<{ storage_key: string; sha256_hex: string }>(
      `SELECT f.storage_key, f.sha256_hex
       FROM import_batches b JOIN stored_files f ON f.id = b.file_id
       WHERE b.id = $1`,
      [batchId],
    );
    const file = fileInfo.rows[0];
    if (!file) throw new NotFoundException("导入批次关联的文件不存在");

    const client = await this.pool.connect();
    let extract:
      | {
          rows: { rawSpelling: string }[];
          rowIssues: ImportRowIssue[][];
          ignoredBlankCount: number;
        }
      | undefined;

    try {
      await client.query("BEGIN");
      // P1-2：锁定批次行，读取权威映射快照。并发 PATCH 会阻塞于此锁。
      // 在锁内重新读取 mapping_version 与 current_mapping —— 校验绑定的是这份快照，
      // 绝不用锁外的旧映射假装成功。
      const locked = await client.query<{
        mapping_version: number;
        current_mapping: unknown;
        format: string;
        validation_status: string;
      }>(
        `SELECT mapping_version, current_mapping, format, validation_status FROM import_batches WHERE id = $1 FOR UPDATE`,
        [batchId],
      );
      const lockedRow = locked.rows[0];
      if (!lockedRow) {
        await client.query("ROLLBACK").catch(() => {});
        throw new NotFoundException("导入批次不存在");
      }
      const lockedMappingVersion = lockedRow.mapping_version;
      const lockedMapping = (lockedRow.current_mapping as ImportMappingDto | null) ?? undefined;
      const lockedFormat = lockedRow.format;

      // P1-C：同一映射版本的逐行事实不可覆盖。若该 (batch, mappingVersion) 已有已完成的行
      // 事实（validation_status 已是 validated 且行已写入），直接返回既有结果——不重复解析、
      // 不重复写行、不影响既有不可变事实。即使换了新幂等键，也只是同语义重放。
      const existingRows = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM import_rows WHERE batch_id = $1 AND mapping_version = $2`,
        [batchId, lockedMappingVersion],
      );
      const alreadyValidated =
        lockedRow.validation_status === "validated" && Number(existingRows.rows[0]?.n ?? 0) > 0;
      if (alreadyValidated) {
        await client.query("ROLLBACK").catch(() => {});
        return this.repository.getDetail(batchId);
      }

      // 先做发现解析（取得可用字段/工作表），判定是否需要映射。快照已锁定。
      let parsedDiscovery;
      try {
        parsedDiscovery = await this.parser.parse(file.storage_key, lockedFormat);
      } catch (err) {
        if (err instanceof ImportParseError) {
          // 释放行锁后再标记 failed：不能在持有 FOR UPDATE 行锁时让 markFailed 的
          // 新连接 UPDATE 同一行（会阻塞在行锁上，而 validate 又等待 markFailed → 死锁）。
          await client.query("ROLLBACK").catch(() => {});
          await this.markFailed(batchId, err.message, requestId);
          throw this.toValidationError(err);
        }
        throw err;
      }

      const needsMapping =
        lockedFormat === "csv" ||
        lockedFormat === "xlsx" ||
        (lockedFormat === "json" && (parsedDiscovery.fields?.length ?? 0) > 0);
      if (needsMapping && !lockedMapping?.spellingField) {
        const err = new Error("尚未确认英文拼写字段映射，无法校验");
        (err as { code?: string }).code = "MAPPING_REQUIRED";
        throw err;
      }

      try {
        extract = await this.parser.extractRows(
          file.storage_key,
          lockedFormat,
          this.toDomainMapping(lockedMapping),
        );
      } catch (err) {
        if (err instanceof ImportParseError) {
          // 同上：先释放行锁，再在新连接上标记 failed。
          await client.query("ROLLBACK").catch(() => {});
          await this.markFailed(batchId, err.message, requestId);
          throw this.toValidationError(err);
        }
        throw err;
      }

      // 幂等语义哈希（基于锁定的映射快照）。
      const semanticHash = this.validateSemanticHash(
        batchId,
        lockedFormat,
        lockedMappingVersion,
        lockedMapping,
      );
      const claim = await this.claimValidate(client, userId, idempotencyKey, semanticHash);
      if (claim.kind === "replay") {
        await client.query("ROLLBACK").catch(() => {});
        // 同上：不显式 release，统一由 finally 归还连接。
        return this.repository.getDetail(batchId);
      }

      // P2-2：候选拼写先去重，再按候选查询系统已有词条（不做全表扫描）。
      const candidates = this.dedupCandidateSpellings(extract);
      const existing = await this.lookupExistingEntries(client, candidates);

      // 生成行事实：逐行归类 + 文件内重复 + 已有词条。
      const rows = this.buildRows(extract, existing);
      await this.replaceRows(client, batchId, lockedMappingVersion, rows);

      // 批次状态 + 校验摘要 + 冻结哈希。
      const summary = this.buildSummary(extract, rows);
      await client.query(
        `UPDATE import_batches
         SET validation_status = 'validated', validation_summary = $2::jsonb,
             validation_input_sha256 = $3, last_validated_at = now(), updated_at = now()
         WHERE id = $1`,
        [batchId, JSON.stringify(summary), file.sha256_hex],
      );
      // 审计：校验完成（摘要脱敏，不含原始全文）。
      await client.query(
        `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, $2, 'import_batch', $3, NULL, $4::jsonb, $5)`,
        [
          userId,
          "admin.import.validate",
          batchId,
          JSON.stringify({
            mappingVersion: lockedMappingVersion,
            format: lockedFormat,
            rows: rows.length,
            status: "validated",
          }),
          requestId,
        ],
      );
      await this.completeValidate(client, userId, idempotencyKey, batchId);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return this.repository.getDetail(batchId);
  }

  /** GET /admin/imports/{id}/rows：游标分页（按 ordinal 升序）。 */
  async listRows(
    batchId: string,
    cursor: number | null,
    limit: number,
    mappingVersion?: number,
    status?: string,
  ): Promise<ImportRowListDto> {
    // 不存在批次 → 404（getDetail 抛 NotFoundException）。
    const detail = await this.repository.getDetail(batchId);
    // 默认只读当前 mappingVersion 的行（不混入历史版本）；显式传入 mappingVersion 时
    // 允许读取该历史映射版本的行事实（P1-B：旧映射版本可追溯，规格要求）。
    const targetVersion = mappingVersion ?? detail.mappingVersion;
    const { items, nextCursor, hasMore } = await this.repository.listRows(
      batchId,
      targetVersion,
      cursor,
      limit,
      status,
    );
    return {
      items: items.map((r) => toRowDto(r)),
      ...(nextCursor !== null ? { nextCursor: String(nextCursor) } : {}),
      hasMore,
    };
  }

  /**
   * POST /admin/imports/{id}/commit：只提交有效候选行（幂等，单事务，可重放）。
   *
   * 前置条件（事务内锁定批次行后重新权威读取）：
   *   - Idempotency-Key 必须；
   *   - 显式确认载荷必须：mappingVersion 须与批次权威 mappingVersion 一致；
   *   - validation_input_sha256（可选但建议）须与批次校验冻结哈希一致；
   *   - 批次 validation_status == validated；
   *   - 批次未被再次映射变更（非 stale：mappingVersion 与行事实最新版本一致）。
   *
   * 事务内一次性完成：行级提交事实、词条创建/既有关联、lexical_sources(import)、
   * 批次状态/计数、审计与幂等 completed。同一 key 重放返回原始结果；同 key 不同语义
   * → 409；并发不同 key 由唯一约束（batch+mv 一个提交；一个 import_row 至多一次提交）
   * 保证每行/词条/来源只被提交一次。
   *
   * 绝不创建课程、发布版本、学习卡、复习事件、XP、挑战或 Worker 事实。
   */
  async commit(
    batchId: string,
    input: {
      idempotencyKey: string;
      mappingVersion: number;
      validationInputSha256: string;
      userId: string;
      requestId: string;
    },
  ): Promise<ImportCommitResultDto> {
    const { idempotencyKey } = input;
    if (!idempotencyKey) {
      const err = new Error("缺少 Idempotency-Key 请求头");
      (err as { code?: string }).code = "IDEMPOTENCY_KEY_REQUIRED";
      throw err;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 1) 锁定批次行，重读权威前置条件（并发 PATCH/validate 会阻塞于此锁）。
      const locked = await client.query<{
        mapping_version: number;
        validation_status: string;
        validation_input_sha256: string | null;
      }>(
        `SELECT mapping_version, validation_status, validation_input_sha256
         FROM import_batches WHERE id = $1 FOR UPDATE`,
        [batchId],
      );
      const batchRow = locked.rows[0];
      if (!batchRow) {
        await client.query("ROLLBACK").catch(() => {});
        throw new NotFoundException("导入批次不存在");
      }
      const authoritativeMappingVersion = batchRow.mapping_version;

      // 2) 幂等检查必须优先于前置条件错误：
      //    语义哈希绑定「客户端显式确认载荷」（mappingVersion + validationInputSha256），
      //    使同 key 重放返回原始结果、同 key 不同语义 → 409，而不是被前置 422 遮蔽。
      const semanticHash = this.commitSemanticHash(
        batchId,
        input.mappingVersion,
        input.validationInputSha256,
      );
      const idemRow = await client.query<{ response_json: unknown; request_hash: string }>(
        `SELECT response_json, request_hash FROM idempotency_keys
         WHERE scope = $1 AND key = $2`,
        [`${COMMIT_SCOPE_PREFIX}:${input.userId}`, idempotencyKey],
      );
      if (idemRow.rows[0]) {
        const stored = idemRow.rows[0].response_json as { pending?: boolean } | null;
        if (stored && "pending" in stored) {
          await client.query("ROLLBACK").catch(() => {});
          throw new ImportIdempotencyInProgressError();
        }
        if (idemRow.rows[0].request_hash !== semanticHash) {
          await client.query("ROLLBACK").catch(() => {});
          throw new ImportIdempotencyConflictError("该提交请求键已用于不同的语义");
        }
        await client.query("ROLLBACK").catch(() => {});
        return { ...(stored as ImportCommitResultDto), isIdempotentReplay: true };
      }

      // 3) 前置条件校验（仅针对新 key）：确认载荷必须与权威事实一致。
      //    校验输入身份必须无条件比对（P1-1）。
      if (input.mappingVersion !== authoritativeMappingVersion) {
        await client.query("ROLLBACK").catch(() => {});
        const err = new Error("提交所依据的映射版本已过期，请刷新后重新提交");
        (err as { code?: string }).code = "COMMIT_STALE_MAPPING";
        throw err;
      }
      if (batchRow.validation_status !== "validated") {
        await client.query("ROLLBACK").catch(() => {});
        const err = new Error("批次尚未校验通过，无法提交");
        (err as { code?: string }).code = "COMMIT_NOT_VALIDATED";
        throw err;
      }
      if (
        !batchRow.validation_input_sha256 ||
        batchRow.validation_input_sha256 !== input.validationInputSha256
      ) {
        await client.query("ROLLBACK").catch(() => {});
        const err = new Error("校验输入身份不匹配，请刷新批次详情后重新提交");
        (err as { code?: string }).code = "COMMIT_VALIDATION_MISMATCH";
        throw err;
      }

      // 4) 读取当前映射版本的可提交行：candidate（新建）与 existing_entry（关联既有词条），
      //    均要求有规范化拼写、版本一致、尚未被提交。
      const eligible = await client.query<{
        id: string;
        ordinal: number;
        normalized_spelling: string;
        status: string;
        lexical_entry_id: string | null;
      }>(
        `SELECT r.id, r.ordinal, r.normalized_spelling, r.status, r.lexical_entry_id
         FROM import_rows r
         WHERE r.batch_id = $1 AND r.mapping_version = $2
           AND r.status IN ('candidate', 'existing_entry')
           AND r.normalized_spelling IS NOT NULL AND btrim(r.normalized_spelling) <> ''
           AND NOT EXISTS (
             SELECT 1 FROM import_batch_commit_rows cr WHERE cr.import_row_id = r.id
           )
         ORDER BY r.ordinal ASC`,
        [batchId, authoritativeMappingVersion],
      );

      // 5) 并发不同 key：若该批次在当前 mappingVersion 已有提交事实，直接返回其
      //     不可变结果，绝不重复创建词条/来源/行事实/审计。
      const priorCommit = await client.query<{
        id: string;
        created_entry_count: number;
        associated_existing_entry_count: number;
        committed_row_count: number;
        skipped_counts: unknown;
        created_at: Date;
      }>(
        `SELECT id, created_entry_count, associated_existing_entry_count, committed_row_count,
                skipped_counts, created_at
         FROM import_batch_commits
         WHERE batch_id = $1 AND mapping_version = $2`,
        [batchId, authoritativeMappingVersion],
      );
      if (priorCommit.rows[0]) {
        await client.query("ROLLBACK").catch(() => {});
        return {
          batchId,
          mappingVersion: authoritativeMappingVersion,
          committedAt: priorCommit.rows[0].created_at.toISOString(),
          createdEntryCount: priorCommit.rows[0].created_entry_count,
          associatedExistingEntryCount: priorCommit.rows[0].associated_existing_entry_count,
          skippedCountByDisposition:
            (priorCommit.rows[0].skipped_counts as Record<string, number>) ?? {},
          committedRowCount: priorCommit.rows[0].committed_row_count,
          isIdempotentReplay: false,
        };
      }

      // 6) 无候选且无既有提交 → 结构化 422（不 claim，不留 pending，不产生无意义提交事实）。
      if (eligible.rows.length === 0) {
        await client.query("ROLLBACK").catch(() => {});
        const err = new Error("没有可提交的有效候选行");
        (err as { code?: string }).code = "COMMIT_NO_ELIGIBLE_ROWS";
        throw err;
      }

      // 7) 幂等 claim（新 key 插入 pending；并发同 key 由 PK 兜底 → replay/冲突）。
      const claim = await this.claimCommit(client, input.userId, idempotencyKey, semanticHash);
      if (claim.kind === "replay") {
        await client.query("ROLLBACK").catch(() => {});
        return { ...claim.result, isIdempotentReplay: true };
      }

      // 8) 单事务内执行提交：行事实、词条创建/关联、来源、批次状态/计数、审计、幂等。
      const result = await this.executeCommit(client, {
        batchId,
        mappingVersion: authoritativeMappingVersion,
        validationInputSha256: batchRow.validation_input_sha256,
        eligibleRows: eligible.rows,
        userId: input.userId,
        requestId: input.requestId,
        idempotencyKey,
        semanticHash,
      });

      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** 生成错误报告 CSV 内容（服务端生成，绝不信任浏览器；基于当前映射版本）。 */
  async buildErrorReportCsv(batchId: string): Promise<{ filename: string; csv: string }> {
    const detail = await this.repository.getDetail(batchId);
    const mappingVersion = detail.mappingVersion;
    // 只包含当前映射版本中真正不可提交的行：invalid / duplicate_in_file。
    // existing_entry 是「可关联/可提交」行（提交时关联既有词条并写 import 来源事实），
    // 不得出现在错误报告中；stale 行（mapping_version 落后于批次）同样不视为当前错误。
    const rows = await this.pool.query<{
      ordinal: number;
      raw_summary: string;
      status: string;
      errors: unknown;
      duplicate_of_ordinal: number | null;
      mapping_version: number;
    }>(
      `SELECT ordinal, raw_summary, status, errors, duplicate_of_ordinal, mapping_version
       FROM import_rows
       WHERE batch_id = $1 AND mapping_version = $2
         AND status NOT IN ('candidate', 'existing_entry')
       ORDER BY ordinal ASC`,
      [batchId, mappingVersion],
    );

    const lines: string[] = [ERROR_REPORT_CSV_HEADER];
    for (const r of rows.rows) {
      const errorCodes = Array.isArray(r.errors)
        ? (r.errors as { code?: string }[]).map((e) => e.code ?? "unknown")
        : [];
      lines.push(
        errorReportCsvLine({
          ordinal: r.ordinal,
          rawSummary: r.raw_summary,
          status: r.status,
          errorCodes,
          duplicateOfOrdinal: r.duplicate_of_ordinal,
          mappingVersion: r.mapping_version,
        }),
      );
    }
    const csv = lines.join(ERROR_REPORT_CSV_LINE_SEPARATOR) + "\n";
    // 服务端生成的安全文件名（仅含批次 ID 与时间，绝不使用用户原文件名）。
    const filename = safeReportFilename(batchId, new Date().toISOString().replace(/[.:]/g, "-"));
    return { filename, csv };
  }

  // ---- 提交内部实现 ----

  private commitSemanticHash(
    batchId: string,
    mappingVersion: number,
    validationInputSha256: string,
  ): string {
    return commitSemanticHash({ batchId, mappingVersion, validationInputSha256 });
  }

  private async claimCommit(
    client: PoolClient,
    userId: string,
    key: string,
    semanticHash: string,
  ): Promise<{ kind: "claimed" } | { kind: "replay"; result: ImportCommitResultDto }> {
    const scope = `${COMMIT_SCOPE_PREFIX}:${userId}`;
    const claim = await client.query<{ response_json: unknown }>(
      `INSERT INTO idempotency_keys (scope, key, request_hash, response_json) VALUES ($1,$2,$3,$4)
       ON CONFLICT (scope, key) DO NOTHING RETURNING response_json`,
      [scope, key, semanticHash, JSON.stringify({ pending: true })],
    );
    if ((claim.rowCount ?? 0) > 0) return { kind: "claimed" };
    const existing = await client.query<{ response_json: unknown; request_hash: string }>(
      `SELECT response_json, request_hash FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const row = existing.rows[0];
    if (!row) return { kind: "claimed" };
    if (row.request_hash !== semanticHash) {
      throw new ImportIdempotencyConflictError("该提交请求键已用于不同的语义");
    }
    const payload = row.response_json as { pending?: boolean } | null;
    if (payload && "pending" in payload) throw new ImportIdempotencyInProgressError();
    return { kind: "replay", result: row.response_json as ImportCommitResultDto };
  }

  private async completeCommit(
    client: PoolClient,
    userId: string,
    key: string,
    result: ImportCommitResultDto,
  ): Promise<void> {
    const scope = `${COMMIT_SCOPE_PREFIX}:${userId}`;
    await client.query(
      `UPDATE idempotency_keys SET response_json = $3, resource_id = $4
       WHERE scope = $1 AND key = $2`,
      [scope, key, JSON.stringify(result), result.batchId],
    );
  }

  /** 单事务内执行一次真实提交（前置条件已校验、已 claim、无既有提交）。 */
  private async executeCommit(
    client: PoolClient,
    ctx: {
      batchId: string;
      mappingVersion: number;
      validationInputSha256: string | null;
      eligibleRows: Array<{
        id: string;
        ordinal: number;
        normalized_spelling: string;
        status: string;
        lexical_entry_id: string | null;
      }>;
      userId: string;
      requestId: string;
      idempotencyKey: string;
      semanticHash: string;
    },
  ): Promise<ImportCommitResultDto> {
    const { batchId, mappingVersion, userId, requestId, idempotencyKey } = ctx;

    // 0) 批次行锁定已在 commit() 中完成；此处仍持有行锁（同一 client 事务内）。

    // 1) 逐行决定「创建」或「关联」：
    //    - candidate 行：先查询系统词条（候选范围内，非全表）；命中 → 关联；否则创建
    //      （ON CONFLICT DO NOTHING，并发竞态 → 关联既有词条）。
    //    - existing_entry 行：校验时已带 lexical_entry_id → 直接关联既有词条，绝不重建。
    const candidateSpellings = ctx.eligibleRows
      .filter((r) => r.status === "candidate")
      .map((r) => r.normalized_spelling);
    const existing = await this.lookupExistingEntries(client, new Set(candidateSpellings));

    let createdEntryCount = 0;
    let associatedExistingEntryCount = 0;
    const committedRowIds: string[] = [];
    const auditRows: Array<{
      importRowId: string;
      entryId: string;
      sourceId: string;
      created: boolean;
      ordinal: number;
    }> = [];

    // 2) 建立词条/来源事实（不依赖 commit_id），收集行级事实所需数据。
    for (const row of ctx.eligibleRows) {
      const spelling = row.normalized_spelling;
      let entryId: string;
      let created = false;

      if (row.status === "existing_entry") {
        // 校验分类为 existing_entry → 确定性关联既有词条，不新建。
        // 但目标词条可能在校验后被删除：import_rows.lexical_entry_id 因 SET NULL 变 NULL，
        // 或指向的词条已不存在。此时校验事实已不再可安全执行：
        //   - 绝不允许退化为新建词条；
        //   - 也绝不允许「跳过该行 + 部分提交」——必须让整个 commit 请求失败，
        //     要求管理员刷新并重新校验（P1-1）。
        const targetId = row.lexical_entry_id;
        let targetMissing = !targetId;
        if (!targetMissing) {
          // 只接受「仍存在且状态为 active」的词条。若目标在校验后被删除或改归档，
          // 绝不把 import provenance / commit 事实绑定到不存在或非活动词条 ——
          // 保持与「删除目标」一致的「要求重新校验」语义，绝不静默创建含糊关联。
          const targetExists = await client.query<{ id: string }>(
            `SELECT id FROM lexical_entries WHERE id = $1 AND status = 'active'`,
            [targetId],
          );
          targetMissing = !targetExists.rows[0];
        }
        if (targetMissing) {
          await client.query("ROLLBACK").catch(() => {});
          const err = new Error(
            "系统词条已在校验后被删除或归档，无法安全关联。请刷新批次并重新校验后重试。",
          );
          (err as { code?: string }).code = "COMMIT_REVALIDATION_REQUIRED";
          throw err;
        }
        // targetId 在此非空（targetMissing 已排除 NULL/不存在）。
        entryId = targetId!;
        associatedExistingEntryCount += 1;
      } else {
        // candidate 行：若该拼写歧义（多个 active 词条）→ fail closed，绝不任意关联。
        if (existing.ambiguous.has(spelling)) {
          await client.query("ROLLBACK").catch(() => {});
          const err = new Error(
            "该拼写对应多个 active 词条，无法安全关联。请先在词条库消歧并重新校验后重试。",
          );
          (err as { code?: string }).code = "COMMIT_REVALIDATION_REQUIRED";
          throw err;
        }
        const existingEntryId = existing.bySpelling.get(spelling);
        if (existingEntryId) {
          entryId = existingEntryId;
          associatedExistingEntryCount += 1;
        } else {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
             VALUES ($1, $1, '[]'::jsonb)
             ON CONFLICT (canonical_spelling) DO NOTHING
             RETURNING id`,
            [spelling],
          );
          if (ins.rows[0]) {
            created = true;
            createdEntryCount += 1;
            entryId = ins.rows[0].id;
          } else {
            // 插入冲突：refresh 该拼写已存在一行（canonical_spelling 全局唯一，与 status 无关）。
            // 只关联「状态为 active」的词条（并发下另一提交恰好创建的同拼写活动词条）。
            // 若占位的是 archived/非 active 词条，绝不把 import provenance / commit 事实
            // 绑定到非活动词条：唯一约束也禁止我们新建同拼写活动词条。此时唯一结构化结果
            // 是让整个 commit 失败并要求重新校验（与「existing_entry 目标消失」同语义），
            // 绝不静默创建含糊关联、绝不写部分事实。
            const found = await client.query<{ id: string }>(
              `SELECT id FROM lexical_entries
               WHERE canonical_spelling = $1 AND status = 'active'`,
              [spelling],
            );
            // 防御：若同一 canonical_spelling 竟返回多个 active 行（不应发生因 UNIQUE，
            // 但请勿任意取第一行）→ fail closed。
            if (found.rowCount === null || found.rowCount > 1) {
              await client.query("ROLLBACK").catch(() => {});
              const err = new Error(
                "该拼写对应多个 active 词条，无法安全关联。请先消歧并重新校验后重试。",
              );
              (err as { code?: string }).code = "COMMIT_REVALIDATION_REQUIRED";
              throw err;
            }
            const activeId = found.rows[0]?.id;
            if (!activeId) {
              await client.query("ROLLBACK").catch(() => {});
              const err = new Error(
                "该拼写对应的词条已存在但不可关联（状态非 active/已归档）。请刷新批次并重新校验后重试。",
              );
              (err as { code?: string }).code = "COMMIT_REVALIDATION_REQUIRED";
              throw err;
            }
            entryId = activeId;
            associatedExistingEntryCount += 1;
          }
        }
      }

      // 来源事实：source_type=import；content_hash 绑定 (batch, mappingVersion, row)，
      // 使同一提交 URL 的来源可确定性复用（lexical_sources 唯一约束兜底）。
      const sourceHash = this.sourceContentHash(row.id, batchId, mappingVersion);
      const sourceIns = await client.query<{ id: string }>(
        `INSERT INTO lexical_sources (lexical_entry_id, source_type, source_note, content_hash, created_by)
         VALUES ($1, 'import', $2, $3, $4)
         ON CONFLICT (lexical_entry_id, source_type, content_hash) DO NOTHING
         RETURNING id`,
        [entryId, `import:commit:${batchId}`, sourceHash, userId],
      );
      let sourceId: string;
      if (sourceIns.rows[0]) {
        sourceId = sourceIns.rows[0].id;
      } else {
        const found = await client.query<{ id: string }>(
          `SELECT id FROM lexical_sources
           WHERE lexical_entry_id = $1 AND source_type = 'import' AND content_hash = $2`,
          [entryId, sourceHash],
        );
        sourceId = found.rows[0]!.id;
      }

      committedRowIds.push(row.id);
      auditRows.push({
        importRowId: row.id,
        entryId,
        sourceId,
        created,
        ordinal: row.ordinal,
      });
    }

    // 3) 计算跳过行（当前映射版本中不可提交行，按 disposition 计数；不含已提交行）。
    const skipped = await client.query<{ status: string; n: string }>(
      `SELECT r.status, count(*)::text AS n
       FROM import_rows r
       WHERE r.batch_id = $1 AND r.mapping_version = $2
         AND r.status NOT IN ('candidate', 'existing_entry')
         AND NOT EXISTS (SELECT 1 FROM import_batch_commit_rows cr WHERE cr.import_row_id = r.id)
       GROUP BY r.status`,
      [batchId, mappingVersion],
    );
    const skippedCounts: Record<string, number> = {};
    for (const s of skipped.rows) skippedCounts[s.status] = Number(s.n);

    // 3b) 若没有任何行真正提交（全部被跳过）：不产生无意义的提交事实，直接结构化拒绝。
    if (auditRows.length === 0) {
      await client.query("ROLLBACK").catch(() => {});
      const err = new Error("没有可提交的有效候选行");
      (err as { code?: string }).code = "COMMIT_NO_ELIGIBLE_ROWS";
      throw err;
    }

    // 4) 写批次提交事实（先写，获得 commit_id，供行级事实引用）。
    const commitIns = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO import_batch_commits
         (batch_id, committed_by, mapping_version, validation_input_sha256, created_entry_count,
          associated_existing_entry_count, committed_row_count, skipped_counts, semantic_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       RETURNING id, created_at`,
      [
        batchId,
        userId,
        mappingVersion,
        ctx.validationInputSha256,
        createdEntryCount,
        associatedExistingEntryCount,
        committedRowIds.length,
        JSON.stringify(skippedCounts),
        ctx.semanticHash,
      ],
    );
    const commitId = commitIns.rows[0]!.id;
    const committedAt = commitIns.rows[0]!.created_at.toISOString();

    // 5) 写行级提交事实（commit_id 绑定；唯一约束防止同一行二次提交；
    //    0021 要求非空 canonical lexical_entry_id 与来源，且来源须属于该词条）。
    //    同时捕获每个 commit-row 的稳定 id，供第 8 步原子投递 operation。
    const commitRowIds: string[] = [];
    for (const a of auditRows) {
      const rowIns = await client.query<{ id: string }>(
        `INSERT INTO import_batch_commit_rows
           (commit_id, import_row_id, ordinal, normalized_spelling, lexical_entry_id,
            created_entry_id, associated_entry_id, lexical_source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          commitId,
          a.importRowId,
          a.ordinal,
          ctx.eligibleRows.find((r) => r.id === a.importRowId)!.normalized_spelling,
          a.entryId,
          a.created ? a.entryId : null,
          a.created ? null : a.entryId,
          a.sourceId,
        ],
      );
      commitRowIds.push(rowIns.rows[0]!.id);
      // 同步行级关联，使 UI/审核可展示最终关联词条（不改变校验分类 status）。
      await client.query(
        `UPDATE import_rows SET lexical_entry_id = $2 WHERE id = $1 AND lexical_entry_id IS DISTINCT FROM $2`,
        [a.importRowId, a.entryId],
      );
    }

    // 5b) 每个稳定 commit row 原子投递后台 operation（同一事务内 add_job；
    //     operation / job / 审计 / 业务提交全部原子回滚）。
    //     payload 只含不透明 operationId + inputVersion；job key 带 Motro 命名空间。
    const operationType = "motro-op-fixture";
    const queueName = "local";
    const maxAttempts = this.config.worker.maxAttempts;
    for (const crId of commitRowIds) {
      const inputHash = operationInputHash({
        operationType,
        targetType: "import_batch_commit_row",
        targetId: crId,
        inputVersion: 1,
      });
      let enqueued: { created: boolean; operationId: string } | null;
      try {
        enqueued = await this.enqueuePort.enqueueInTransaction(client, {
          operationType,
          targetType: "import_batch_commit_row",
          targetId: crId,
          inputVersion: 1,
          inputHash,
          requestedBy: userId,
          queueName,
          maxAttempts,
        });
      } catch (err) {
        // add_job / schema 未就绪等投递失败：整个业务事务回滚（绝不提交后 fire-and-forget）。
        if (err instanceof OperationEnqueueRollbackError) throw err;
        throw new OperationEnqueueRollbackError(
          err instanceof Error ? err.message : "无法为提交行投递后台任务",
        );
      }
      if (enqueued === null) {
        throw new OperationEnqueueRollbackError("无法为提交行投递后台任务");
      }
    }

    // 5c) 富集链路：为每个稳定 commit row 原子投递 Wiktionary → DeepSeek 两个 operation
    //     （同一事务内 add_job；失败整体回滚）。DeepSeek handler 依 commit_row_id 自取
    //     fetched 源事实（wiktionary_source_facts），缺失时 → DRAFT_SOURCE_MISSING manual_action。
    const enrichment = enrichmentOperationTypes(this.config.providerMode);
    for (const crId of commitRowIds) {
      await this.enqueueEnrichmentOperation(client, {
        operationType: enrichment.wiktionary,
        targetType: "import_batch_commit_row",
        targetId: crId,
        inputVersion: 1,
        requestedBy: userId,
        queueName: "local",
        maxAttempts,
      });
      await this.enqueueEnrichmentOperation(client, {
        operationType: enrichment.deepseek,
        targetType: "import_batch_commit_row",
        targetId: crId,
        inputVersion: 1,
        requestedBy: userId,
        queueName: "local",
        maxAttempts,
      });
    }

    // 6) 批次状态 → committed（本批已提交过有效行；不可变提交事实是权威来源）。
    await client.query(
      `UPDATE import_batches SET status = 'committed', updated_at = now() WHERE id = $1`,
      [batchId],
    );

    // 7) 审计：批次提交 + 逐行提交（只含 ID/计数/状态，不含原始内容）。
    await client.query(
      `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
       VALUES ($1, $2, 'import_batch', $3, NULL, $4::jsonb, $5)`,
      [
        userId,
        "admin.import.commit",
        batchId,
        JSON.stringify({
          mappingVersion,
          createdEntryCount,
          associatedExistingEntryCount,
          committedRowCount: committedRowIds.length,
          skippedCounts,
          commitId,
        }),
        requestId,
      ],
    );
    for (const a of auditRows) {
      await client.query(
        `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES ($1, $2, 'import_row', $3, NULL, $4::jsonb, $5)`,
        [
          userId,
          "admin.import.row.commit",
          a.importRowId,
          JSON.stringify({
            ordinal: a.ordinal,
            entryId: a.entryId,
            sourceId: a.sourceId,
            created: a.created,
          }),
          requestId,
        ],
      );
    }

    // P2-1：committedRowCount == created + associated（跳过行不计入）。
    const finalResult: ImportCommitResultDto = {
      batchId,
      mappingVersion,
      committedAt,
      createdEntryCount,
      associatedExistingEntryCount,
      skippedCountByDisposition: skippedCounts,
      committedRowCount: createdEntryCount + associatedExistingEntryCount,
      isIdempotentReplay: false,
    };
    await this.completeCommit(client, userId, idempotencyKey, finalResult);
    return finalResult;
  }

  /**
   * 富集操作投递（镜像 fixture enqueue 的语义）。
   * 在同一事务内原子投递一个 Wiktionary 或 DeepSeek 操作；add_job 失败时
   * 抛 OperationEnqueueRollbackError，整个业务事务回滚，绝不 fire-and-forget。
   * 返回值非 null（operationId + created），幂等由 application_operations 唯一约束保障。
   */
  private async enqueueEnrichmentOperation(
    client: import("pg").PoolClient,
    spec: {
      operationType: string;
      targetType: string;
      targetId: string;
      inputVersion: number;
      requestedBy: string;
      queueName: string;
      maxAttempts: number;
    },
  ): Promise<{ created: boolean; operationId: string }> {
    const inputHash = operationInputHash({
      operationType: spec.operationType,
      targetType: spec.targetType,
      targetId: spec.targetId,
      inputVersion: spec.inputVersion,
    });
    let enqueued: { created: boolean; operationId: string } | null;
    try {
      enqueued = await this.enqueuePort.enqueueInTransaction(client, {
        operationType: spec.operationType,
        targetType: spec.targetType,
        targetId: spec.targetId,
        inputVersion: spec.inputVersion,
        inputHash,
        requestedBy: spec.requestedBy,
        queueName: spec.queueName,
        maxAttempts: spec.maxAttempts,
      });
    } catch (err) {
      if (err instanceof OperationEnqueueRollbackError) throw err;
      throw new OperationEnqueueRollbackError(
        err instanceof Error ? err.message : "无法为富集操作投递后台任务",
      );
    }
    if (enqueued === null) {
      throw new OperationEnqueueRollbackError("无法为富集操作投递后台任务");
    }
    return enqueued;
  }

  private sourceContentHash(rowId: string, batchId: string, mappingVersion: number): string {
    return createHash("sha256")
      .update(`import:${batchId}:${mappingVersion}:${rowId}`)
      .digest("hex");
  }

  // ---- 校验内部实现 ----
  private validateSemanticHash(
    batchId: string,
    format: string,
    mappingVersion: number,
    mapping: ImportMappingDto | undefined,
  ): string {
    const canonical = JSON.stringify([
      "import:validate",
      batchId,
      format,
      mappingVersion,
      mapping?.spellingField ?? null,
      mapping?.sheet ?? null,
    ]);
    return createHash("sha256").update(canonical).digest("hex");
  }

  private async claimValidate(
    client: PoolClient,
    userId: string,
    key: string,
    semanticHash: string,
  ): Promise<{ kind: "claimed" } | { kind: "replay" }> {
    const scope = `${VALIDATE_SCOPE_PREFIX}:${userId}`;
    const claim = await client.query<{ response_json: unknown }>(
      `INSERT INTO idempotency_keys (scope, key, request_hash, response_json) VALUES ($1,$2,$3,$4)
       ON CONFLICT (scope, key) DO NOTHING RETURNING response_json`,
      [scope, key, semanticHash, JSON.stringify({ pending: true })],
    );
    if ((claim.rowCount ?? 0) > 0) return { kind: "claimed" };
    const existing = await client.query<{ response_json: unknown; request_hash: string }>(
      `SELECT response_json, request_hash FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const row = existing.rows[0];
    if (!row) return { kind: "claimed" };
    if (row.request_hash !== semanticHash) {
      throw new ImportIdempotencyConflictError("该校验请求键已用于不同的语义");
    }
    const payload = row.response_json as { pending?: boolean } | null;
    if (payload && "pending" in payload) throw new ImportIdempotencyInProgressError();
    return { kind: "replay" };
  }

  private async completeValidate(
    client: PoolClient,
    userId: string,
    key: string,
    batchId: string,
  ): Promise<void> {
    const scope = `${VALIDATE_SCOPE_PREFIX}:${userId}`;
    await client.query(
      `UPDATE idempotency_keys SET response_json = $3, resource_id = $4
       WHERE scope = $1 AND key = $2`,
      [scope, key, JSON.stringify({ validated: true, batchId }), batchId],
    );
  }

  /**
   * P2-2：从提取结果中归集已规范化的候选拼写（去重）。
   * 用于候选范围内的已有词条查询，避免全表扫描。
   */
  private dedupCandidateSpellings(extract: {
    rows: { rawSpelling: string }[];
    rowIssues: ImportRowIssue[][];
  }): Set<string> {
    const seen = new Set<string>();
    const maxCellLength = this.config.import.maxCellLength;
    extract.rows.forEach((row, idx) => {
      const issues = extract.rowIssues[idx] ?? [];
      if (issues.length > 0) return;
      const trimmed = row.rawSpelling.trim();
      if (trimmed.length === 0 || trimmed.length > maxCellLength) return;
      seen.add(normalizeSpelling(trimmed));
    });
    return seen;
  }

  /**
   * P2-2：候选范围内的已有词条查询（不全表扫描 lexical_entries）。
   * 只查询本批次候选拼写中实际出现的规范化拼写。
   * 分批查询以安全处理大批量，但批次候选通常 ≤ 50k，单次查询即可。
   */
  private async lookupExistingEntries(
    client: PoolClient,
    candidateSpellings: Set<string>,
  ): Promise<{ bySpelling: Map<string, string>; ambiguous: Set<string> }> {
    const empty = { bySpelling: new Map<string, string>(), ambiguous: new Set<string>() };
    if (candidateSpellings.size === 0) return empty;
    const list = [...candidateSpellings];
    const CHUNK = 500;
    const bySpelling = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const result = await client.query<{
        normalized_spelling: string;
        id: string;
        cnt: string;
      }>(
        `SELECT normalized_spelling, id, count(*) OVER (PARTITION BY normalized_spelling) AS cnt
         FROM lexical_entries
         WHERE status = 'active' AND normalized_spelling = ANY($1::text[])`,
        [chunk],
      );
      const firstBySpelling = new Map<string, string>();
      for (const r of result.rows) {
        // 仅当该拼写恰好 1 个 active 词条时才建立确定性关联；
        // 多个 active → 歧义，绝不任意选取，交给调用方 fail closed。
        if (Number(r.cnt) === 1) {
          firstBySpelling.set(r.normalized_spelling, r.id);
        } else {
          ambiguous.add(r.normalized_spelling);
        }
      }
      for (const [k, v] of firstBySpelling) bySpelling.set(k, v);
    }
    return { bySpelling, ambiguous };
  }

  private buildRows(
    extract: {
      rows: { rawSpelling: string }[];
      rowIssues: ImportRowIssue[][];
      ignoredBlankCount: number;
    },
    existing: { bySpelling: Map<string, string>; ambiguous: Set<string> },
  ): Array<{
    ordinal: number;
    rawSummary: string;
    normalizedSpelling: string | null;
    status: string;
    errors: { code: string; message: string }[];
    duplicateOfOrdinal: number | null;
    lexicalEntryId: string | null;
  }> {
    const seen = new Map<string, number>();
    const rows: Array<{
      ordinal: number;
      rawSummary: string;
      normalizedSpelling: string | null;
      status: string;
      errors: { code: string; message: string }[];
      duplicateOfOrdinal: number | null;
      lexicalEntryId: string | null;
    }> = [];

    extract.rows.forEach((row, idx) => {
      const ordinal = idx + 1;
      const issues = extract.rowIssues[idx] ?? [];
      const rawSummary = safeValueSummary(row.rawSpelling, this.config.import.maxSummaryLength);
      const trimmed = row.rawSpelling.trim();
      let normalized: string | null = null;
      let duplicateOf: number | null = null;
      let entryId: string | null = null;

      if (issues.length === 0 && trimmed.length > 0) {
        normalized = normalizeSpelling(trimmed);
        const prior = seen.get(normalized);
        if (prior !== undefined) {
          duplicateOf = prior;
        } else {
          seen.set(normalized, ordinal);
        }
        // 歧义：同一拼写存在多个 active 词条 → fail closed（绝不任意选取），归为 invalid。
        if (existing.ambiguous.has(normalized)) {
          issues.push("ambiguous_entry");
        } else {
          entryId = existing.bySpelling.get(normalized) ?? null;
        }
      }

      const disposition = resolveRowDisposition({
        issues,
        ...(duplicateOf !== null ? { duplicateOfOrdinal: duplicateOf } : {}),
        ...(entryId !== null ? { matchingEntryId: entryId } : {}),
      });
      rows.push({
        ordinal,
        rawSummary,
        normalizedSpelling: normalized,
        status: disposition,
        errors: issues.map((code) => ({ code, message: this.errorMessage(code) })),
        duplicateOfOrdinal: duplicateOf,
        lexicalEntryId: entryId,
      });
    });
    return rows;
  }

  private buildSummary(
    extract: { rows: unknown[]; ignoredBlankCount: number },
    rows: Array<{ status: string }>,
  ): ImportValidationSummaryDto {
    const by = new Map<string, number>();
    for (const r of rows) by.set(r.status, (by.get(r.status) ?? 0) + 1);
    return {
      candidates: by.get("candidate") ?? 0,
      duplicates: by.get("duplicate_in_file") ?? 0,
      existingEntries: by.get("existing_entry") ?? 0,
      invalid: by.get("invalid") ?? 0,
      ignored: extract.ignoredBlankCount,
      total: rows.length,
    };
  }

  private async replaceRows(
    client: PoolClient,
    batchId: string,
    mappingVersion: number,
    rows: Array<{
      ordinal: number;
      rawSummary: string;
      normalizedSpelling: string | null;
      status: string;
      errors: { code: string; message: string }[];
      duplicateOfOrdinal: number | null;
      lexicalEntryId: string | null;
    }>,
  ): Promise<void> {
    // 逐行事实一旦写入即不可覆盖（P1-C）：同一 (batch, mapping_version, ordinal) 的既有行
    // 绝不被删除或改写，以保证“不可覆盖的逐行事实”。同一映射版本下再次校验（即使换新的
    // 幂等键、内容完全一致）只会 INSERT ... ON CONFLICT DO NOTHING：
    //   - 首次校验 → 插入全部行；
    //   - 重复校验（同映射同文件）→ 全部命中唯一冲突，不写、不改、不删既有事实。
    // 历史不同映射版本的行依旧互不干扰（0019 复合唯一索引）。
    for (const r of rows) {
      await client.query(
        `INSERT INTO import_rows
           (batch_id, ordinal, mapping_version, raw_summary, normalized_spelling, status, errors,
            duplicate_of_ordinal, lexical_entry_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (batch_id, mapping_version, ordinal) DO NOTHING`,
        [
          batchId,
          r.ordinal,
          mappingVersion,
          r.rawSummary,
          r.normalizedSpelling,
          r.status,
          JSON.stringify(r.errors),
          r.duplicateOfOrdinal,
          r.lexicalEntryId,
        ],
      );
    }
  }

  private async markFailed(batchId: string, message: string, requestId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE import_batches
         SET validation_status = 'failed', validation_summary = NULL, updated_at = now()
         WHERE id = $1`,
        [batchId],
      );
      await client.query(
        `INSERT INTO audit_events (actor_id, action, target_type, target_id, before_summary, after_summary, request_id)
         VALUES (NULL, 'admin.import.validate.failed', 'import_batch', $1, NULL, $2::jsonb, $3)`,
        [batchId, JSON.stringify({ reason: safeValueSummary(message, 200) }), requestId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private toValidationError(err: ImportParseError): Error {
    const e = new Error(err.message);
    (e as { code?: string }).code = err.code;
    return e;
  }

  private toDomainMapping(mapping: ImportMappingDto | undefined): ImportMapping {
    if (!mapping) return {};
    return {
      ...(mapping.spellingField !== undefined ? { spellingField: mapping.spellingField } : {}),
      ...(mapping.sheet !== undefined ? { sheet: mapping.sheet } : {}),
    };
  }

  private errorMessage(code: string): string {
    switch (code) {
      case "empty":
        return "该行为空";
      case "invalid_spelling":
        return "拼写不合法（须含英文字母、无控制字符）";
      case "over_field_limit":
        return "超过字段长度上限";
      case "over_row_limit":
        return "超过行数上限";
      case "unparsable":
        return "无法解析该行";
      case "ambiguous_entry":
        return "该拼写存在多个 active 词条，无法安全关联（请先在词条库消歧）";
      default:
        return "校验失败";
    }
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
