import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module.js";
import { databaseProvider } from "../../auth/database.provider.js";
import { AdminXpController } from "./admin-xp.controller.js";
import { AdminXpService } from "./admin-xp.service.js";
import { ChallengeController } from "./challenge.controller.js";
import { ChallengeService } from "./challenge.service.js";
import { GameController } from "./game.controller.js";
import { GameService } from "./game.service.js";

// 游戏/挑战模块边界：XP 台账、Challenge Points 台账、周挑战榜投影、
// 服务端判分的挑战测验（Ticket 14）。个人 XP 永不进入排行榜；只读挑战积分参与排名（ADR-0007）。
// ChallengeController/Service 使用 SessionGuard（来自 AuthModule），故须导入 AuthModule
// 使 SessionService 在 GameModule 上下文中可解析（否则 Nest 启动即抛
// UnknownDependenciesException，阻断整个应用启动与 openapi:generate）。
@Module({
  imports: [AuthModule],
  controllers: [GameController, ChallengeController, AdminXpController],
  providers: [databaseProvider, GameService, ChallengeService, AdminXpService],
  exports: [GameService, ChallengeService, AdminXpService],
})
export class GameModule {}
