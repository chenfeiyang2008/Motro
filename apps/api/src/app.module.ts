// 根模块：平台外壳（health）+ 认证 + 业务模块边界。
import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { HealthModule } from "./health/health.module.js";
import { AdminModule } from "./modules/admin/admin.module.js";
import { CatalogModule } from "./modules/catalog/catalog.module.js";
import { GameModule } from "./modules/game/game.module.js";
import { OperationsModule } from "./modules/operations/operations.module.js";
import { StudyModule } from "./modules/study/study.module.js";
import { ImportModule } from "./modules/admin/imports/import.module.js";
import { ReviewsModule } from "./modules/reviews/reviews.module.js";

@Module({
  imports: [
    HealthModule,
    AuthModule,
    CatalogModule,
    AdminModule,
    StudyModule,
    GameModule,
    OperationsModule,
    ImportModule,
    ReviewsModule,
  ],
})
export class AppModule {}
