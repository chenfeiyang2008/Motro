// 导入批次 DTO（阶段 6 工单 01）：上传创建批次 + 批次详情/列表 + 错误信封。
// 绝不返回真实磁盘路径、storage_key 或敏感元数据。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

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

export class ImportBatchListDto {
  @ApiProperty({ type: [ImportBatchDto], description: "批次列表（按创建时间倒序）" })
  items!: ImportBatchDto[];
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
