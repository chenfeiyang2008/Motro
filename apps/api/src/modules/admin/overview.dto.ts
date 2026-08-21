import { ApiProperty } from "@nestjs/swagger";

export class AdminOverviewMetricDto {
  @ApiProperty()
  total!: number;
}

export class AdminOverviewMetricsDto {
  @ApiProperty({ type: () => AdminOverviewMetricDto })
  users!: AdminOverviewMetricDto;

  @ApiProperty({ type: () => AdminOverviewMetricDto })
  members!: AdminOverviewMetricDto;

  @ApiProperty({ type: () => AdminOverviewMetricDto })
  activeLexiconEntries!: AdminOverviewMetricDto;

  @ApiProperty({ type: () => AdminOverviewMetricDto })
  courses!: AdminOverviewMetricDto;

  @ApiProperty({ type: () => AdminOverviewMetricDto })
  publishedCourses!: AdminOverviewMetricDto;
}

export class AdminOverviewReviewItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  createdAt!: string;
}

export class AdminOverviewImportItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class AdminOverviewOperationItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  updatedAt!: string;

  @ApiProperty({ required: false })
  errorCode?: string;
}

export class AdminOverviewCourseItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class AdminOverviewReviewQueueDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ type: () => [AdminOverviewReviewItemDto] })
  items!: AdminOverviewReviewItemDto[];
}

export class AdminOverviewImportQueueDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ type: () => [AdminOverviewImportItemDto] })
  items!: AdminOverviewImportItemDto[];
}

export class AdminOverviewOperationQueueDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ type: () => [AdminOverviewOperationItemDto] })
  items!: AdminOverviewOperationItemDto[];
}

export class AdminOverviewCourseQueueDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ type: () => [AdminOverviewCourseItemDto] })
  items!: AdminOverviewCourseItemDto[];
}

export class AdminOverviewQueuesDto {
  @ApiProperty({ type: () => AdminOverviewReviewQueueDto })
  reviews!: AdminOverviewReviewQueueDto;

  @ApiProperty({ type: () => AdminOverviewImportQueueDto })
  imports!: AdminOverviewImportQueueDto;

  @ApiProperty({ type: () => AdminOverviewOperationQueueDto })
  operations!: AdminOverviewOperationQueueDto;

  @ApiProperty({ type: () => AdminOverviewCourseQueueDto })
  publishing!: AdminOverviewCourseQueueDto;
}

export class AdminOverviewDto {
  @ApiProperty({ format: "date-time" })
  generatedAt!: string;

  @ApiProperty({ type: () => AdminOverviewMetricsDto })
  metrics!: AdminOverviewMetricsDto;

  @ApiProperty({ type: () => AdminOverviewQueuesDto })
  queues!: AdminOverviewQueuesDto;
}
