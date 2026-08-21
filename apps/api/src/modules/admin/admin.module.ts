import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module.js";
import { databaseProvider } from "../../auth/database.provider.js";
import { CatalogModule } from "../catalog/catalog.module.js";
import { AdminOverviewController } from "./overview.controller.js";
import { AdminOverviewService } from "./overview.service.js";

// 管理模块装配：管理用例接入 catalog 边界与只读首页概览。
@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [AdminOverviewController],
  providers: [databaseProvider, AdminOverviewService],
})
export class AdminModule {}
