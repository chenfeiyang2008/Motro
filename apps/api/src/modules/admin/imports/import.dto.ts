// 导入批次 DTO（阶段 6 工单 01 + 02 + 03）：上传/映射/校验/提交/错误报告。
// 绝不返回真实磁盘路径、storage_key 或敏感元数据。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
export class StoredFileMetaDto {
  @ApiProperty({ description: "不透明文件 ID" })
  fileId!: string;

  @ApiProperty({ description: "原文件名（仅元数据，绝不参与路径构造）" })
  originalFilename!: string;

  @ApiProperty({ description: "嗅探到的 MIME 类型" })
  sniffedMime!: string;

  @ApiProperty({ description: "字节大小" })
  byteSize!: number;

  @ApiProperty({ description: "SHA-256（十六进制）" })
  sha256Hex!: string;

  @ApiProperty({ description: "上传人用户 ID" })
  uploadedBy!: string;

  @ApiProperty({ description: "保留用途（本票固定 original_import）" })
  purpose!: string;

  @ApiProperty({ description: "文件状态" })
  status!: string;

  @ApiProperty({ description: "格式（txt/csv/json/xlsx）" })
  format!: string;

  @ApiProperty({ description: "创建时间（RFC 3339 UTC）" })
  createdAt!: string;
}

export class ImportBatchDto {
  @ApiProperty({ description: "批次 ID" })
  id!: string;

  @ApiProperty({
    type: StoredFileMetaDto,
    description: "批次关联的文件元数据（不含磁盘路径/存储键）",
  })
  file!: StoredFileMetaDto;

  @ApiProperty({ description: "批次格式" })
  format!: string;

  @ApiProperty({ description: "管理员来源声明" })
  sourceDeclaration!: string;

  @ApiProperty({ description: "批次状态（uploaded/validating/ready/committed/failed）" })
  status!: string;

  @ApiProperty({ description: "乐观并发版本" })
  version!: number;

  @ApiProperty({ description: "上传人用户 ID" })
  uploadedBy!: string;

  @ApiProperty({ description: "创建时间（RFC 3339 UTC）" })
  createdAt!: string;

  @ApiPropertyOptional({ description: "更新时间（RFC 3339 UTC）" })
  updatedAt?: string;
}

/** multipart 上传请求体：file（binary）+ sourceDeclaration。 */
export class ImportUploadBodyDto {
  @ApiProperty({
    type: "string",
    format: "binary",
    description: "原始文件（txt/csv/json）",
  })
  file!: string;

  @ApiProperty({ description: "来源声明（必填）" })
  sourceDeclaration!: string;
}

/** 上传/详情接口的通用错误信封。 */
export class ImportErrorFieldDto {
  @ApiProperty({ description: "出错字段路径" })
  path!: string;

  @ApiProperty({ description: "错误码" })
  code!: string;
}

export class ImportErrorDto {
  @ApiProperty({ description: "错误码" })
  code!: string;

  @ApiProperty({ description: "安全的用户文案" })
  message!: string;

  @ApiProperty({ description: "可关联的请求 ID（服务端日志）" })
  requestId!: string;

  @ApiProperty({ description: "是否为可重试错误" })
  retryable!: boolean;

  @ApiPropertyOptional({ type: [ImportErrorFieldDto], description: "字段级错误（可选）" })
  fieldErrors?: ImportErrorFieldDto[];

  @ApiPropertyOptional({ description: "内容冲突时既有批次的 ID" })
  existingBatchId?: string;
}

export class ImportErrorEnvelopeDto {
  @ApiProperty({ type: ImportErrorDto, description: "错误信封" })
  error!: ImportErrorDto;
}

// ---------------------------------------------------------------------------
// 阶段 6 工单 02：映射确认、校验与行结果。
// ---------------------------------------------------------------------------

/** 解析发现的可用字段/工作表选项。 */
export class ImportDiscoveredOptionDto {
  @ApiProperty({ description: "稳定、不歧义的字段/工作表标识（保存到映射）" })
  fieldId!: string;

  @ApiProperty({ description: "展示名" })
  label!: string;
}

/** XLSX 某张工作表内的字段集（fieldIds 与 labels 一一对应）。 */
export class ImportSheetFieldSetDto {
  @ApiProperty({ description: "该工作表内所有字段的稳定标识" })
  fieldIds!: string[];

  @ApiProperty({ description: "与 fieldIds 一一对应的表头展示名" })
  labels!: string[];
}

export class ImportMappingDto {
  @ApiPropertyOptional({ description: "英文拼写来源字段标识（TXT 不提供）" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  spellingField?: string;

  @ApiPropertyOptional({ description: "XLSX 选定的工作表标识" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sheet?: string;
}

export class ImportValidationSummaryDto {
  @ApiProperty({ description: "可用于提交的有效候选行数" })
  candidates!: number;

  @ApiProperty({ description: "文件内重复行数" })
  duplicates!: number;

  @ApiProperty({ description: "系统已有词条行数" })
  existingEntries!: number;

  @ApiProperty({ description: "无效（拼写/超限/空值）行数" })
  invalid!: number;

  @ApiProperty({ description: "忽略的空白行数" })
  ignored!: number;

  @ApiProperty({ description: "总行数" })
  total!: number;
}

/** 导入批次详情响应（工单 02：新增映射/校验信息）。 */
/** POST /admin/imports/{id}/commit 响应：真实、可证明的提交摘要。 */
export class ImportCommitResultDto {
  @ApiProperty({ description: "批次 ID" })
  batchId!: string;

  @ApiProperty({ description: "提交所依据的映射版本" })
  mappingVersion!: number;

  @ApiProperty({ description: "提交时间（RFC 3339 UTC）" })
  committedAt!: string;

  @ApiProperty({ description: "本轮新建的全局词条数" })
  createdEntryCount!: number;

  @ApiProperty({ description: "本轮关联到既有系统词条的数量" })
  associatedExistingEntryCount!: number;

  @ApiProperty({
    description:
      "按 disposition 分组的跳过行数（invalid / duplicate_in_file / existing_entry / stale 等）",
    type: "object",
    additionalProperties: { type: "number" },
  })
  skippedCountByDisposition!: Record<string, number>;

  @ApiProperty({ description: "本轮实际写入提交事实的行数" })
  committedRowCount!: number;

  @ApiProperty({ description: "是否为幂等重放（true 表示返回原始结果）" })
  isIdempotentReplay!: boolean;
}

/** 提交确认身份：客户端回传以证明它基于当前校验快照的显式意图。 */
export class ImportCommitConfirmationDto {
  @ApiProperty({ description: "当前映射版本" })
  mappingVersion!: number;

  @ApiProperty({
    description: "校验输入冻结哈希（validation_input_sha256，安全：仅哈希无路径/密钥）",
  })
  validationInputSha256!: string;
}

export class ImportBatchDetailDto {
  @ApiProperty({ description: "批次 ID" })
  id!: string;

  @ApiProperty({ type: StoredFileMetaDto, description: "批次关联的文件元数据" })
  file!: StoredFileMetaDto;

  @ApiProperty({ description: "批次格式（txt/csv/json/xlsx）" })
  format!: string;

  @ApiProperty({ description: "管理员来源声明" })
  sourceDeclaration!: string;

  @ApiProperty({ description: "批次状态" })
  status!: string;

  @ApiProperty({ description: "乐观并发版本" })
  version!: number;

  @ApiProperty({ description: "校验状态（not_validated/validating/validated/failed）" })
  validationStatus!: string;

  @ApiProperty({ description: "当前映射版本" })
  mappingVersion!: number;

  @ApiPropertyOptional({
    type: ImportMappingDto,
    description: "当前映射（spellingField/sheet）；TXT 为空",
  })
  mapping?: ImportMappingDto;

  @ApiPropertyOptional({ type: [ImportDiscoveredOptionDto], description: "可选工作表（XLSX）" })
  sheets?: ImportDiscoveredOptionDto[];

  @ApiPropertyOptional({
    type: [ImportDiscoveredOptionDto],
    description: "可选字段（CSV/XLSX/JSON）",
  })
  fields?: ImportDiscoveredOptionDto[];

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: {
      type: "object",
      properties: {
        fieldIds: { type: "array", items: { type: "string" } },
        labels: { type: "array", items: { type: "string" } },
      },
    },
    description: "XLSX 各工作表各自的字段集（供按当前选定工作表选择字段；键为工作表标识）",
  })
  sheetFields?: Record<string, ImportSheetFieldSetDto>;

  @ApiPropertyOptional({ type: ImportValidationSummaryDto, description: "校验摘要" })
  validationSummary?: ImportValidationSummaryDto;

  @ApiProperty({ description: "可执行的唯一主操作状态" })
  nextStep!: string;

  @ApiProperty({ description: "上传人用户 ID" })
  uploadedBy!: string;

  @ApiProperty({ description: "创建时间（RFC 3339 UTC）" })
  createdAt!: string;

  @ApiPropertyOptional({ description: "更新时间（RFC 3339 UTC）" })
  updatedAt?: string;

  @ApiProperty({ description: "当前映射/校验结果是否仍有效" })
  isStale!: boolean;

  @ApiPropertyOptional({
    type: ImportCommitResultDto,
    description: "最近一次提交事实摘要（已提交批次提供，供重载后展示事实性计数）",
  })
  commitSummary?: ImportCommitResultDto;

  @ApiPropertyOptional({
    type: ImportCommitConfirmationDto,
    description:
      "提交确认身份（仅当前已校验且非 stale 时提供）：客户端提交时必须原样回传，服务器锁定后无条件比对",
  })
  commitConfirmation?: ImportCommitConfirmationDto;
}

/** PATCH /admin/imports/{id} 请求体：更新映射。 */
export class UpdateImportBatchDto {
  @ApiPropertyOptional({ type: ImportMappingDto, description: "映射（spellingField/sheet）" })
  @IsOptional()
  @ValidateNested()
  @Type(() => ImportMappingDto)
  mapping?: ImportMappingDto;

  @ApiPropertyOptional({ description: "当前批次版本（乐观并发；提供则用于 If-Match 语义）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({
    description: "来源声明（可选更新；非空且 ≤500 字符）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @MinLength(1)
  sourceDeclaration?: string;
}

export class ImportBatchListDto {
  @ApiProperty({ type: [ImportBatchDetailDto], description: "批次列表（按创建时间倒序）" })
  items!: ImportBatchDetailDto[];
}

/** GET /imports/{id}/rows 行摘要。 */
export class ImportRowDto {
  @ApiProperty({ description: "行 ID" })
  id!: string;

  @ApiProperty({ description: "批次内序号（从 1 起）" })
  ordinal!: number;

  @ApiProperty({ description: "原始拼写安全摘要" })
  rawSummary!: string;

  @ApiPropertyOptional({ description: "规范化拼写" })
  normalizedSpelling?: string;

  @ApiProperty({
    description:
      "校验分类（candidate/invalid/duplicate_in_file/existing_entry/stale）；不可变校验事实",
  })
  status!: string;

  @ApiProperty({ description: "结构化错误码列表" })
  errors!: string[];

  @ApiPropertyOptional({ description: "文件内重复：指向的行序号" })
  duplicateOfOrdinal?: number;

  @ApiPropertyOptional({
    description: "关联的系统词条 ID（existing_entry 校验分类或已提交后为最终关联词条）",
  })
  lexicalEntryId?: string;

  @ApiProperty({ description: "映射版本" })
  mappingVersion!: number;

  @ApiProperty({
    description: "提交状态：not_committed 或 committed（由不可变提交事实推导，非覆盖校验分类）",
  })
  commitStatus!: string;

  @ApiPropertyOptional({ description: "提交时间（RFC 3339 UTC；committed 时提供）" })
  committedAt?: string;

  @ApiPropertyOptional({ description: "提交人用户 ID（committed 时提供）" })
  committedBy?: string;
}

export class ImportRowListDto {
  @ApiProperty({ type: [ImportRowDto], description: "行列表（按 ordinal 升序）" })
  items!: ImportRowDto[];

  @ApiPropertyOptional({ description: "下一页游标（null 表示无更多）" })
  nextCursor?: string;

  @ApiProperty({ description: "是否还有更多页" })
  hasMore!: boolean;
}

// ---------------------------------------------------------------------------
// 阶段 6 工单 03：提交有效行与错误报告。
// ---------------------------------------------------------------------------

/** POST /admin/imports/{id}/commit 请求体：显式确认载荷，禁止无绑定「提交全部」。 */
export class CommitImportBatchDto {
  @ApiProperty({
    description: "当前映射版本（要求与服务器权威值一致，防 stale/未绑定提交）",
  })
  @IsInt()
  @Min(1)
  mappingVersion!: number;

  @ApiProperty({
    description:
      "校验输入的身份标识（来自批次详情的 commitConfirmation.validationInputSha256）；必须精确匹配",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  validationInputSha256!: string;
}
