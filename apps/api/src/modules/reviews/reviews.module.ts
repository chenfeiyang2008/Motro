import { Module } from "@nestjs/common";
import { databaseProvider } from "../../auth/database.provider.js";
import { AuthModule } from "../../auth/auth.module.js";
import { ReviewsController } from "./reviews.controller.js";
import { ReviewsService } from "./reviews.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ReviewsController],
  providers: [databaseProvider, ReviewsService],
})
export class ReviewsModule {}
