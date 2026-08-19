// Ticket 20 · membership module.
import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module.js";
import { databaseProvider } from "../../auth/database.provider.js";
import { MembershipController, AdminMembershipController } from "./membership.controller.js";
import { MembershipService } from "./membership.service.js";

@Module({
  imports: [AuthModule],
  controllers: [MembershipController, AdminMembershipController],
  providers: [databaseProvider, MembershipService],
  exports: [MembershipService],
})
export class MembershipModule {}
