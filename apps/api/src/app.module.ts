// 根模块：平台外壳（health）+ 认证 + 空业务模块边界。
import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { HealthModule } from "./health/health.module.js";
import { CatalogModule } from "./modules/catalog/catalog.module.js";
import { GameModule } from "./modules/game/game.module.js";
import { OperationsModule } from "./modules/operations/operations.module.js";
import { StudyModule } from "./modules/study/study.module.js";

@Module({
  imports: [HealthModule, AuthModule, CatalogModule, StudyModule, GameModule, OperationsModule],
})
export class AppModule {}
