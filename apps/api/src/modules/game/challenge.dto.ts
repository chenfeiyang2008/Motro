// Ticket 14: challenge quiz DTOs.
// GET /challenge/current + POST /challenge/attempts/:id/answers/:position.
// Response DTOs are OpenAPI-only; request DTOs use class-validator.
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, MinLength } from "class-validator";

export class ChallengeItemDto {
  @ApiProperty({ description: "题号（1–10）" })
  position!: number;
  @ApiProperty({ description: "方向：en_to_zh / zh_to_en" })
  direction!: "en_to_zh" | "zh_to_en";
  @ApiProperty({ description: "题型：choice（四选一）/ spelling（拼写）" })
  questionType!: "choice" | "spelling";
  @ApiProperty({ description: "英文拼写（学习面）" })
  englishSpelling!: string;
  @ApiProperty({ description: "冻结的中文释义（学习面）" })
  meaning!: string;
}

export class ChallengeCurrentDto {
  @ApiProperty({ description: "挑战周键，例如 cw-2026-08-11" })
  challengeWeek!: string;
  @ApiProperty({ description: "周期起点（Asia/Shanghai 周一 00:00 UTC ISO）" })
  weekStart!: string;
  @ApiProperty({ description: "周期终点（下一周一 00:00 UTC ISO，开区间）" })
  weekEnd!: string;
  @ApiProperty({ description: "固定挑战周时区" })
  timezone!: string;
  @ApiPropertyOptional({ description: "当前测验 id（无已接触词条时为 null）" })
  attemptId!: string | null;
  @ApiPropertyOptional({ description: "测验状态：in_progress / completed / cutoff" })
  status!: string;
  @ApiPropertyOptional({ description: "测验过期时刻（ISO）" })
  expiresAt!: string | null;
  @ApiProperty({ type: [ChallengeItemDto], description: "本题测验的 10 题冻结快照" })
  items!: ChallengeItemDto[];
  @ApiProperty({ description: "本题测验可获得的最高积分（可判分题数 × 5）" })
  maxPoints!: number;
}

export class ChallengeAnswerDto {
  @ApiProperty({
    description: "客户端幂等键（每次提交唯一）；同键重放返回冻结首次判分",
  })
  @IsString()
  @MinLength(1)
  clientEventId!: string;

  @ApiProperty({ description: "作答内容（选择=选项文字；拼写=英文拼写）" })
  @IsString()
  @MinLength(1)
  answer!: string;
}

export class ChallengeVerdictDto {
  @ApiProperty({ description: "测验 id" })
  attemptId!: string;
  @ApiProperty({ description: "题号" })
  position!: number;
  @ApiProperty({ description: "本题是否正确" })
  isCorrect!: boolean;
  @ApiProperty({ description: "本题获得的挑战积分（0 或 5）" })
  pointsAwarded!: number;
  @ApiProperty({
    description: "判分类型：scored / review / wrong / already_scored",
  })
  kind!: "scored" | "review" | "wrong" | "already_scored";
  @ApiProperty({ description: "服务端正确答案（判分后给出）" })
  correctAnswer!: string;
}
