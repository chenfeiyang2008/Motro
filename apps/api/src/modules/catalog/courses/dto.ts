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

export class UnitDto {
  @ApiProperty({ description: "稳定 unit_id" })
  id!: string;

  @ApiProperty({ description: "1 起始的位置" })
  position!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

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
