// 认证模块。
import { Module } from "@nestjs/common";
import { AdminUsersController } from "./admin-users.controller.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { databaseProvider } from "./database.provider.js";
import { PasswordService } from "./password.service.js";
import { LoginRateLimitGuard } from "./rate-limit.guard.js";
import { RolesGuard } from "./roles.guard.js";
import { SessionGuard } from "./session.guard.js";
import { SessionService } from "./session.service.js";

@Module({
  controllers: [AuthController, AdminUsersController],
  providers: [
    databaseProvider,
    PasswordService,
    SessionService,
    SessionGuard,
    RolesGuard,
    LoginRateLimitGuard,
    AuthService,
  ],
  exports: [SessionService, SessionGuard, RolesGuard, AuthService],
})
export class AuthModule {}
