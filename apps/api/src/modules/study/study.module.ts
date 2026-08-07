import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module.js";
import { databaseProvider } from "../../auth/database.provider.js";
import { StudyController } from "./study.controller.js";
import { StudyService } from "./study.service.js";

// 学习模块：阶段 5 工单 01 的学习卡与学习展示。
// AuthModule 未导出 POOL，学习模块自声明同一 provider（独立连接池，避免循环依赖）。
@Module({
  imports: [AuthModule],
  controllers: [StudyController],
  providers: [databaseProvider, StudyService],
  exports: [StudyService],
})
export class StudyModule {}
