// 课程/草稿/单元 DTO：请求校验（ValidationPipe → 422 fieldErrors）与 OpenAPI 响应形状。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { COURSE_LEVELS } from "@motro/domain";

// ---- 请求 ----

export class CreateCourseDto {
  @ApiProperty({ description: "课程 slug（唯一，小写字母/数字/连字符）" })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  slug!: string;

  @ApiProperty({ description: "课程标题" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ enum: [...COURSE_LEVELS], default: "a1", description: "级别" })
  @IsOptional()
  @IsIn([...COURSE_LEVELS])
  level?: string;

  @ApiPropertyOptional({ description: "课程描述" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class UpdateCourseDraftDto {
  @ApiPropertyOptional({ description: "课程 slug（唯一，小写字母/数字/连字符）" })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  slug?: string;

  @ApiPropertyOptional({ description: "课程标题" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ enum: [...COURSE_LEVELS], description: "级别" })
  @IsOptional()
  @IsIn([...COURSE_LEVELS])
  level?: string;

  @ApiPropertyOptional({ description: "课程描述" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: "期望的草稿版本（If-Match 的替代）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  draftVersion?: number;
}

export class CreateUnitDto {
  @ApiProperty({ description: "单元标题" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: "单元描述" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: "期望的草稿版本（If-Match 的替代）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  draftVersion?: number;
}

export class UpdateUnitDto {
  @ApiPropertyOptional({ description: "单元标题" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: "单元描述" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: "期望的草稿版本（If-Match 的替代）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  draftVersion?: number;
}

export class DeleteUnitDto {
  @ApiPropertyOptional({ description: "期望的草稿版本（If-Match 的替代）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  draftVersion?: number;
}

export class ReorderUnitsDto {
  @ApiProperty({ type: [String], description: "完整单元 ID 顺序（无重复、无遗漏）" })
  @IsArray()
  @IsString({ each: true })
  unitIds!: string[];

  @ApiPropertyOptional({ description: "期望的草稿版本（If-Match 的替代）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  draftVersion?: number;
}

export class CreateItemDto {
  @ApiProperty({ description: "所属草稿单元 ID" })
  @IsString()
  unitId!: string;

  @ApiProperty({ description: "引用的全局词条 ID" })
  @IsString()
  lexicalEntryId!: string;

  @ApiProperty({ description: "课程专属中文释义（必填）" })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  meaning!: string;

  @ApiPropertyOptional({ description: "可选提示" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  hint?: string;

  @ApiPropertyOptional({ description: "期望的草稿版本（If-Match 的替代）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  draftVersion?: number;
}

export class UpdateItemDto {
  @ApiPropertyOptional({ description: "课程专属中文释义（必填）" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  meaning?: string;

  @ApiPropertyOptional({ description: "可选提示" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  hint?: string;

  @ApiPropertyOptional({ description: "移动到其他草稿单元（追加到该单元末尾）" })
  @IsOptional()
  @IsString()
  unitId?: string;

  @ApiPropertyOptional({ description: "期望的草稿版本（If-Match 的替代）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  draftVersion?: number;
}

export class DeleteItemDto {
  @ApiPropertyOptional({ description: "期望的草稿版本（If-Match 的替代）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  draftVersion?: number;
}

export class ReorderItemsDto {
  @ApiProperty({ description: "所属草稿单元 ID" })
  @IsString()
  unitId!: string;

  @ApiProperty({
    type: [String],
    description: "该单元内完整词项 ID 顺序（无重复、无遗漏、无陌生 ID）",
  })
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];

  @ApiPropertyOptional({ description: "期望的草稿版本（If-Match 的替代）" })
  @IsOptional()
  @IsInt()
  @Min(1)
  draftVersion?: number;
}

// ---- 响应（OpenAPI 形状） ----

export class CourseListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: "课程 slug（唯一）" })
  slug!: string;

  @ApiProperty({ description: "当前标题（来自 active 草稿）" })
  title!: string;

  @ApiProperty()
  level!: string;

  @ApiProperty({ type: String, nullable: true, description: "当前描述（来自 active 草稿）" })
  description!: string | null;

  @ApiProperty({ description: "课程可见性" })
  visibility!: string;

  @ApiProperty({ description: "课程状态" })
  status!: string;

  @ApiProperty({ type: String, nullable: true, description: "active 草稿 ID" })
  draftId!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: "active 草稿版本" })
  draftVersion!: number | null;

  @ApiProperty({ description: "最近编辑时间（来自 active 草稿）" })
  updatedAt!: string;
}

export class DraftItemSummaryDto {
  @ApiProperty({ description: "全局词条 ID" })
  id!: string;

  @ApiProperty({ description: "英语拼写" })
  canonicalSpelling!: string;

  @ApiProperty({ description: "规范化拼写" })
  normalizedSpelling!: string;

  @ApiProperty({ description: "词条来源状态" })
  sourceStatus!: string;
}

export class ItemDto {
  @ApiProperty({ description: "稳定 course_item_id" })
  id!: string;

  @ApiProperty({ description: "单元内 1 起始的位置" })
  position!: number;

  @ApiProperty({ description: "课程专属中文释义" })
  meaning!: string;

  @ApiProperty({ type: String, nullable: true, description: "可选提示" })
  hint!: string | null;

  @ApiProperty({ description: "人工内容 provenance：关联的管理员审计事件 ID" })
  contentReviewReference!: string;

  @ApiProperty({ type: DraftItemSummaryDto, description: "引用的全局词条摘要" })
  lexicalEntry!: DraftItemSummaryDto;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class UnitDto {
  @ApiProperty({ description: "稳定 unit_id" })
  id!: string;

  @ApiProperty({ description: "1 起始的位置" })
  position!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: [ItemDto], description: "按 position 升序的课程词项" })
  items!: ItemDto[];

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class CourseDraftDetailDto {
  @ApiProperty()
  courseId!: string;

  @ApiProperty()
  draftId!: string;

  @ApiProperty({ description: "课程 slug（唯一）" })
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  level!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ description: "当前草稿版本" })
  version!: number;

  @ApiProperty()
  status!: string;

  @ApiProperty({ type: [UnitDto], description: "按 position 升序的单元大纲" })
  units!: UnitDto[];
}

export class CreateCourseResultDto {
  @ApiProperty()
  courseId!: string;

  @ApiProperty()
  draftId!: string;

  @ApiProperty({ description: "初始草稿版本" })
  draftVersion!: number;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  level!: string;
}

export class CourseListResponseDto {
  @ApiProperty({ type: [CourseListItemDto] })
  items!: CourseListItemDto[];
}

export class DraftVersionConflictErrorDto {
  @ApiProperty({ description: "错误码：DRAFT_VERSION_CONFLICT" })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty()
  requestId!: string;

  @ApiProperty({ description: "服务端当前草稿版本" })
  currentDraftVersion!: number;

  @ApiProperty({ description: "是否可重试" })
  retryable!: boolean;
}

export class DraftVersionConflictEnvelopeDto {
  @ApiProperty({ type: DraftVersionConflictErrorDto })
  error!: DraftVersionConflictErrorDto;
}

// ---- 校验（草稿发布准备） ----

export class ValidationIssueDto {
  @ApiProperty({ description: "稳定错误码" })
  code!: string;

  @ApiProperty({ description: "定位路径：course、unit.<unitId>、item.<itemId>.<field>" })
  path!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ enum: ["error", "warning"], description: "error 阻断发布，warning 仅提示" })
  severity!: "error" | "warning";
}

export class DiffSummaryDto {
  @ApiProperty({ enum: ["initial", "changed"], description: "首次发布或相对当前版本的差异" })
  kind!: "initial" | "changed";

  @ApiProperty()
  addedUnits!: number;

  @ApiProperty()
  removedUnits!: number;

  @ApiProperty()
  addedItems!: number;

  @ApiProperty()
  removedItems!: number;

  @ApiProperty()
  changedItems!: number;

  @ApiProperty()
  totalUnits!: number;

  @ApiProperty()
  totalItems!: number;
}

export class PublishReleaseDto {
  @ApiProperty({ description: "精确草稿版本（发布须重新确认）" })
  @IsInt()
  @Min(1)
  draftVersion!: number;

  @ApiPropertyOptional({ description: "发布说明" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  releaseNote?: string;

  @ApiPropertyOptional({ description: "校验令牌（可选，须与草稿版本+内容哈希匹配）" })
  @IsOptional()
  @IsString()
  validationToken?: string;
}

export class PublishReleaseResultDto {
  @ApiProperty()
  releaseId!: string;

  @ApiProperty({ description: "每门课程单调递增的版本号" })
  releaseNumber!: number;

  @ApiProperty({ description: "发布快照内容哈希" })
  contentHash!: string;

  @ApiProperty({ description: "发布后成为当前版本指针" })
  currentReleaseId!: string;

  @ApiProperty()
  createdAt!: string;
}

export class SetCurrentReleaseDto {
  @ApiProperty({ description: "指向的已有 release ID（必须属于同一课程）" })
  @IsString()
  releaseId!: string;
}

export class ReleaseListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  releaseNumber!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  level!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ description: "快照内容哈希" })
  contentHash!: string;

  @ApiProperty({ description: "来源草稿版本" })
  sourceDraftVersion!: number;

  @ApiProperty({ type: String, nullable: true, description: "发布说明" })
  releaseNote!: string | null;

  @ApiProperty({ description: "创建者用户名" })
  createdByUsername!: string;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty({ description: "是否为当前版本" })
  isCurrent!: boolean;
}

export class ReleaseListResponseDto {
  @ApiProperty({ type: [ReleaseListItemDto] })
  items!: ReleaseListItemDto[];
}

export class CourseValidationResultDto {
  @ApiProperty({ description: "被校验草稿的版本" })
  draftVersion!: number;

  @ApiProperty({ description: "是否存在阻断错误" })
  isPublishable!: boolean;

  @ApiProperty({ type: [ValidationIssueDto], description: "阻断发布的问题" })
  blockingErrors!: ValidationIssueDto[];

  @ApiProperty({ type: [ValidationIssueDto], description: "提示但可发布的问题" })
  warnings!: ValidationIssueDto[];

  @ApiProperty({ type: DiffSummaryDto })
  diffSummary!: DiffSummaryDto;

  @ApiProperty({ description: "受影响学习者数量；第 4 阶段无报名数据时为 0" })
  affectedLearnerCount!: number;

  @ApiProperty({ description: "校验时刻（RFC 3339 UTC）" })
  validatedAt!: string;

  @ApiProperty({ description: "草稿内容规范化序列化 SHA-256" })
  contentHash!: string;

  @ApiProperty({ description: "校验令牌：draftVersion.contentHash 前缀，发布须携带精确版本" })
  validationToken!: string;
}

// ---- 学习者目录（只读 published release） ----

export class CatalogCourseSummaryDto {
  @ApiProperty()
  courseId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  level!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ description: "当前版本 release ID" })
  releaseId!: string;

  @ApiProperty({ description: "当前版本号" })
  releaseNumber!: number;

  @ApiProperty({ description: "内容来源：published_release（只读发布快照）" })
  contentSource!: string;

  @ApiProperty({ description: "学习进度：阶段 4 恒为 not_started" })
  progressStatus!: string;
}

export class CatalogUnitSummaryDto {
  @ApiProperty({ description: "稳定 unit_id" })
  unitId!: string;

  @ApiProperty({ description: "1 起始的位置" })
  position!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;
}

export class CatalogCourseDetailDto extends CatalogCourseSummaryDto {
  @ApiProperty({ type: [CatalogUnitSummaryDto], description: "按 position 升序的单元概要" })
  units!: CatalogUnitSummaryDto[];
}

export class CatalogCourseListResponseDto {
  @ApiProperty({ type: [CatalogCourseSummaryDto] })
  items!: CatalogCourseSummaryDto[];
}
