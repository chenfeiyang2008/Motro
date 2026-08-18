import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module.js";
import { databaseProvider } from "../../auth/database.provider.js";
import { MotivationController } from "./motivation.controller.js";
import { MotivationService } from "./motivation.service.js";

@Module({
  imports: [AuthModule],
  controllers: [MotivationController],
  providers: [databaseProvider, MotivationService],
})
export class MotivationModule {}
