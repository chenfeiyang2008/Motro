// 词条管理 DTO：请求校验（ValidationPipe → 422 fieldErrors）与 OpenAPI 响应形状。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { PART_OF_SPEECH_VALUES } from "@motro/domain";

// ---- 请求 ----

export class SenseDto {
  @ApiProperty({ description: "中文释义" })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  meaning!: string;

  @ApiPropertyOptional({ description: "例句" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  example?: string;
}

export class CreateLexicalEntryDto {
  @ApiProperty({ description: "规范展示拼写（保留原样，不因小写无条件合并同形异义词）" })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  canonicalSpelling!: string;

  @ApiPropertyOptional({ enum: [...PART_OF_SPEECH_VALUES], description: "词性" })
  @IsOptional()
  @IsIn([...PART_OF_SPEECH_VALUES])
  partOfSpeech?: string;

  @ApiPropertyOptional({ description: "发音标注" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  pronunciation?: string;

  @ApiPropertyOptional({ type: [SenseDto], description: "结构化释义" })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SenseDto)
  senses?: SenseDto[];

  @ApiPropertyOptional({ description: "来源说明（不进入审计摘要）" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceNote?: string;

  @ApiPropertyOptional({
    description: "确认允许创建同形异义词条（重复候选提示后）",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  confirmDuplicate?: boolean;
}

export class ListLexicalEntriesQuery {
  @ApiPropertyOptional({ description: "按规范化/展示拼写搜索" })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: "键集分页游标（上次响应返回）" })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: "每页数量", default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

// ---- 编辑（PATCH）与状态变更 ----
// 严格白名单：仅允许编辑词条元数据；来源事实（revision/page identity、content hash）
// 与规范化拼写 / canonicalSpelling 不可通过编辑改动。

export class UpdateLexicalEntryDto {
  @ApiPropertyOptional({ enum: [...PART_OF_SPEECH_VALUES], description: "词性" })
  @IsOptional()
  @IsIn([...PART_OF_SPEECH_VALUES])
  partOfSpeech?: string;

  @ApiPropertyOptional({ description: "发音标注（传 null 清除）" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  pronunciation?: string;

  @ApiPropertyOptional({ type: [SenseDto], description: "结构化释义（整体替换）" })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SenseDto)
  senses?: SenseDto[];

  @ApiPropertyOptional({ description: "来源说明（新增一条 manual 来源，append-only）" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceNote?: string;
}

// ---- 响应（OpenAPI 形状） ----

export class LexicalEntrySummaryDto {
  @ApiProperty({ description: "词条 ID" })
  id!: string;

  @ApiProperty({ description: "规范展示拼写" })
  canonicalSpelling!: string;

  @ApiProperty({ description: "查询/去重用规范化拼写" })
  normalizedSpelling!: string;

  @ApiProperty({ type: String, nullable: true, description: "词性（可空）" })
  partOfSpeech!: string | null;

  @ApiProperty({ description: "来源状态（当前权威来源类型）" })
  sourceStatus!: string;

  @ApiProperty({
    description: "课程词项引用次数；课程词项工单落地前恒为 0（预留 lexicalEntryId 查询边界）",
  })
  referenceCount!: number;

  @ApiProperty({ description: "最近更新时间" })
  updatedAt!: string;
}

export class PageInfoDto {
  @ApiProperty({ type: String, nullable: true, description: "下一页游标；无更多时 null" })
  cursor!: string | null;

  @ApiProperty({ description: "是否还有更多" })
  hasMore!: boolean;
}

export class LexicalEntryListResponseDto {
  @ApiProperty({ type: [LexicalEntrySummaryDto] })
  items!: LexicalEntrySummaryDto[];

  @ApiProperty({ type: PageInfoDto })
  page!: PageInfoDto;
}

export class ProvenanceDto {
  @ApiProperty({ description: "来源类型" })
  sourceType!: string;

  @ApiProperty({ type: String, nullable: true, description: "来源说明" })
  sourceNote!: string | null;

  @ApiProperty({ description: "来源内容哈希" })
  contentHash!: string;

  @ApiProperty({ type: String, nullable: true, description: "创建者用户名" })
  createdByUsername!: string | null;

  @ApiProperty({ description: "来源记录时间" })
  createdAt!: string;
}

export class AuditSummaryDto {
  @ApiProperty({ description: "审计动作" })
  action!: string;

  @ApiProperty({ description: "发生时间" })
  createdAt!: string;
}

export class LexicalEntryDetailDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  canonicalSpelling!: string;

  @ApiProperty()
  normalizedSpelling!: string;

  @ApiProperty({ type: String, nullable: true })
  partOfSpeech!: string | null;

  @ApiProperty({ type: String, nullable: true })
  pronunciation!: string | null;

  @ApiProperty({ type: [SenseDto], description: "结构化释义" })
  senses!: SenseDto[];

  @ApiProperty({ description: "词条状态" })
  status!: string;

  @ApiProperty({ description: "来源状态（当前权威来源类型）" })
  sourceStatus!: string;

  @ApiProperty({ description: "课程词项引用次数（课程词项落地前恒为 0）" })
  referenceCount!: number;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;

  @ApiProperty({ type: [ProvenanceDto] })
  provenance!: ProvenanceDto[];

  @ApiProperty({ type: [AuditSummaryDto], description: "最近 10 条针对该词条的审计操作" })
  recentOperations!: AuditSummaryDto[];
}

export class DuplicateCandidateDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  canonicalSpelling!: string;

  @ApiProperty()
  normalizedSpelling!: string;
}

export class DuplicateWarningErrorDto {
  @ApiProperty({ description: "错误码：DUPLICATE_WARNING 或 DUPLICATE_ENTRY" })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty()
  requestId!: string;

  @ApiProperty({ type: [DuplicateCandidateDto], description: "重复候选词条" })
  duplicateCandidates!: DuplicateCandidateDto[];

  @ApiProperty({ description: "是否可重试" })
  retryable!: boolean;
}

/** 409 实际响应信封：与统一错误信封一致，外层包裹 error。 */
export class DuplicateErrorEnvelopeDto {
  @ApiProperty({ type: DuplicateWarningErrorDto })
  error!: DuplicateWarningErrorDto;
}
