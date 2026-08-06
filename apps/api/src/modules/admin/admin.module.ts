import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module.js";

// 管理模块装配：管理用例接入 catalog 边界；当前无独立控制器。
@Module({
  imports: [CatalogModule],
})
export class AdminModule {}
