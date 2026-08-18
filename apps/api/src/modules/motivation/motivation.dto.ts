import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { MOTIVATION_COPY_CATEGORIES } from "@motro/domain";

export class MotivationCopyDto {
  @ApiProperty() id!: string;
  @ApiProperty() text!: string;
  @ApiProperty({ enum: MOTIVATION_COPY_CATEGORIES }) category!: string;
  @ApiPropertyOptional({ nullable: true }) attribution!: string | null;
}

export class MotivationResponseDto {
  @ApiProperty({ nullable: true, type: MotivationCopyDto }) message!: MotivationCopyDto | null;
}

export class AdminMotivationCopyDto extends MotivationCopyDto {
  @ApiProperty() isEnabled!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class AdminMotivationListDto {
  @ApiProperty({ type: [AdminMotivationCopyDto] }) items!: AdminMotivationCopyDto[];
  @ApiPropertyOptional({ nullable: true }) nextCursor?: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class CreateMotivationCopyDto {
  @ApiProperty({ maxLength: 180 })
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  text!: string;

  @ApiProperty({ enum: MOTIVATION_COPY_CATEGORIES })
  @IsIn(MOTIVATION_COPY_CATEGORIES)
  category!: string;

  @ApiPropertyOptional({ maxLength: 80, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  attribution?: string | null;
}

export class BatchCreateMotivationCopyDto {
  @ApiProperty({ type: [CreateMotivationCopyDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateMotivationCopyDto)
  items!: CreateMotivationCopyDto[];
}

export class BatchCreateMotivationResultDto {
  @ApiProperty({ type: [AdminMotivationCopyDto] })
  items!: AdminMotivationCopyDto[];

  @ApiProperty({ description: "实际新增条数" })
  createdCount!: number;

  @ApiProperty({ description: "因重复而跳过的条数" })
  skippedCount!: number;

  @ApiProperty({ type: [String], description: "被跳过的重复文案" })
  skippedTexts!: string[];
}

export class UpdateMotivationCopyDto {
  @ApiPropertyOptional({ maxLength: 180 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  text?: string;

  @ApiPropertyOptional({ enum: MOTIVATION_COPY_CATEGORIES })
  @IsOptional()
  @IsIn(MOTIVATION_COPY_CATEGORIES)
  category?: string;

  @ApiPropertyOptional({ maxLength: 80, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  attribution?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
