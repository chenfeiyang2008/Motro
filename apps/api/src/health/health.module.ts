import { Module } from "@nestjs/common";
import { DbHealthService } from "./db-health.service.js";
import { HealthController } from "./health.controller.js";

@Module({
  controllers: [HealthController],
  providers: [DbHealthService],
  exports: [DbHealthService],
})
export class HealthModule {}
