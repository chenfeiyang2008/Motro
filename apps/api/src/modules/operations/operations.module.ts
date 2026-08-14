// 阶段 6 工单 04：任务状态管理模块。
// 模块边界：
//   - Controller 只处理协议、身份、DTO 与错误映射；
//   - Service/Repository 处理事务、锁与状态机；
//   - EnqueuePort 提供 import commit 的窄投递接口（在调用方事务内工作）。
import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module.js";
import { databaseProvider } from "../../auth/database.provider.js";
import { OperationsController } from "./operations.controller.js";
import { OperationsService } from "./operations.service.js";
import { OperationRepository } from "./operations.repository.js";
import { OperationEnqueueService } from "./enqueue.service.js";

@Module({
  imports: [AuthModule],
  controllers: [OperationsController],
  providers: [databaseProvider, OperationsService, OperationRepository, OperationEnqueueService],
  exports: [OperationEnqueueService],
})
export class OperationsModule {}
