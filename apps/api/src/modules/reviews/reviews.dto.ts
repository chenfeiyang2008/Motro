import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * The review decision body contract per Ticket 07 §9.1.
 * `editedContent` is only honoured for accept_with_edits and is strictly
 * allow-listed (no source/model/provenance overrides).
 */
export class ReviewEditedContentDto {
  @ApiPropertyOptional({ description: "accept_with_edits 时的英文拼写" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  englishSpelling?: string;

  @ApiPropertyOptional({ description: "accept_with_edits 时的中文含义" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  simplifiedChineseMeaning?: string;

  @ApiPropertyOptional({ description: "accept_with_edits 时的学习提示" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  learningHint?: string;
}

export class ReviewDecisionRequestDto {
  @ApiProperty({ enum: ["accept", "accept_with_edits", "reject"] })
  @IsIn(["accept", "accept_with_edits", "reject"])
  decision!: "accept" | "accept_with_edits" | "reject";

  @ApiPropertyOptional({ description: "审核理由；reject 必填" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @ApiPropertyOptional({ description: "accept_with_edits 时的受控编辑内容" })
  @IsOptional()
  @IsObject()
  editedContent?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      "乐观并发版本文本：由 detail/list 返回的 reviewVersion 回填；过期则返回 409（stale-review 防护）",
  })
  @IsOptional()
  @IsString()
  expectedVersion?: string;
}

export class ReviewSourceProjectionDto {
  @ApiProperty() sourceName!: string;
  @ApiProperty() pageId!: string;
  @ApiProperty() revisionId!: string;
  @ApiProperty() revisionTimestamp!: string;
  @ApiProperty() sourceUrl!: string;
  @ApiProperty() licenseName!: string;
  @ApiPropertyOptional() licenseVersion?: string;
  @ApiProperty() licenseUrl!: string;
  @ApiProperty() attribution!: string;
}

export class ManualActionInfoDto {
  @ApiProperty({ enum: ["resolvable", "non_resolvable"], description: "manual_action 分类" })
  cls!: "resolvable" | "non_resolvable";

  @ApiProperty({ type: String, nullable: true, description: "触发错误码（非敏感）" })
  errorCode!: string | null;
}

export class ReviewDraftListItemDto {
  @ApiProperty() draftId!: string;
  @ApiProperty() spelling!: string;
  @ApiProperty() status!: string;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional() decisionType?: string;
  @ApiPropertyOptional() reviewVersion?: string;
  @ApiProperty({ type: ReviewSourceProjectionDto }) source!: ReviewSourceProjectionDto;
  @ApiPropertyOptional({
    type: ManualActionInfoDto,
    description: "manual_action 分类信息（仅 manual_action 草稿）",
  })
  manualAction?: ManualActionInfoDto;
}

export class ReviewListQueryDto {
  @ApiPropertyOptional({ description: "按状态过滤（draft_ready/manual_action）" })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: "manual_action 分类过滤：resolvable/non_resolvable" })
  @IsOptional()
  @IsIn(["resolvable", "non_resolvable"])
  manualAction?: "resolvable" | "non_resolvable";

  @ApiPropertyOptional({ description: "keyset 分页游标" })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: "每页数量（1-100，默认 50）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ReviewDraftListDto {
  @ApiProperty({ type: [ReviewDraftListItemDto] }) items!: ReviewDraftListItemDto[];
  @ApiPropertyOptional({ description: "下一页游标" }) nextCursor?: string;
  @ApiProperty({ description: "是否还有更多" }) hasMore!: boolean;
}

export class ReviewDecisionDto {
  @ApiProperty() id!: string;
  @ApiProperty() draftId!: string;
  @ApiProperty() decisionType!: string;
  @ApiProperty() reason!: string;
  @ApiProperty() reviewerId!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: ReviewSourceProjectionDto }) source!: ReviewSourceProjectionDto;
  @ApiProperty() englishSpelling!: string;
  @ApiPropertyOptional() simplifiedChineseMeaning?: string;
  @ApiPropertyOptional() learningHint?: string;
}

export class ReviewDraftDetailDto {
  @ApiProperty() draftId!: string;
  @ApiProperty() spelling!: string;
  @ApiProperty() status!: string;
  @ApiProperty() simplifiedChineseMeaning!: string;
  @ApiPropertyOptional() learningHint?: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() reviewVersion!: string;
  @ApiProperty({ type: ReviewSourceProjectionDto }) source!: ReviewSourceProjectionDto;
  @ApiPropertyOptional({ type: ReviewDecisionDto }) decision?: ReviewDecisionDto;
  @ApiPropertyOptional({ type: ManualActionInfoDto, description: "manual_action 分类信息" })
  manualAction?: ManualActionInfoDto;
}

export class ReviewDecisionResponseDto {
  @ApiProperty({ type: ReviewDecisionDto }) decision!: ReviewDecisionDto;
  @ApiProperty() isIdempotentReplay!: boolean;
}
