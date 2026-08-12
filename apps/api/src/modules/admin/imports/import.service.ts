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
  type ImportMapping,
  type ImportRowIssue,
} from "@motro/domain";
import { ImportParser, ImportParseError } from "./import.parser.js";
import { ImportBatchRepository, toRowDto } from "./import.repository.js";
import type {
  ImportBatchDetailDto,
  ImportBatchDto,
  ImportMappingDto,
  ImportRowListDto,
  ImportValidationSummaryDto,
  StoredFileMetaDto,
} from "./import.dto.js";

const IDEMPOTENCY_SCOPE_PREFIX = "import:batch:create";
const VALIDATE_SCOPE_PREFIX = "import:validate";

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
    private readonly repository: ImportBatchRepository,
    private readonly parser: ImportParser,
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
    );
    return {
      items: items.map((r) => toRowDto(r)),
      ...(nextCursor !== null ? { nextCursor: String(nextCursor) } : {}),
      hasMore,
    };
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
  ): Promise<Map<string, string>> {
    if (candidateSpellings.size === 0) return new Map();
    const list = [...candidateSpellings];
    const CHUNK = 500;
    const map = new Map<string, string>();
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const result = await client.query<{ normalized_spelling: string; id: string }>(
        `SELECT normalized_spelling, id
         FROM lexical_entries
         WHERE status = 'active' AND normalized_spelling = ANY($1::text[])`,
        [chunk],
      );
      for (const r of result.rows) map.set(r.normalized_spelling, r.id);
    }
    return map;
  }

  private buildRows(
    extract: {
      rows: { rawSpelling: string }[];
      rowIssues: ImportRowIssue[][];
      ignoredBlankCount: number;
    },
    existing: Map<string, string>,
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
        entryId = existing.get(normalized) ?? null;
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
