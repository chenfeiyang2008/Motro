// /auth 端点：登录、登出、me、改密、自有会话管理。
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { loadConfig } from "@motro/config";
import { AuthService } from "./auth.service.js";
import { ChangePasswordDto, LoginDto } from "./dto.js";
import { LoginRateLimitGuard } from "./rate-limit.guard.js";
import { SESSION_COOKIE, sessionCookieOptions } from "./cookies.js";
import { SessionGuard, type AuthenticatedRequest } from "./session.guard.js";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  private readonly config = loadConfig();

  constructor(private readonly authService: AuthService) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @UseGuards(LoginRateLimitGuard)
  @ApiOperation({ summary: "登录并建立会话 cookie" })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.authService.login(dto.username, dto.password);
    this.setSessionCookie(reply, result.sessionToken);
    return result.user;
  }

  @Get("me")
  @UseGuards(SessionGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: "当前账号" })
  me(@Req() req: AuthenticatedRequest) {
    return this.authService.me(req.user.id);
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: "撤销当前会话并清除 cookie" })
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.authService.logout(req.session.id, req.user.id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }

  @Post("change-password")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: "修改当前/首次密码并撤销其他会话" })
  async changePassword(@Req() req: AuthenticatedRequest, @Body() dto: ChangePasswordDto) {
    await this.authService.changePassword(
      req.user.id,
      dto.currentPassword,
      dto.newPassword,
      req.session.id,
    );
    return { ok: true };
  }

  @Get("sessions")
  @UseGuards(SessionGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: "列出当前用户会话摘要" })
  sessions(@Req() req: AuthenticatedRequest) {
    return this.authService.listOwnSessions(req.user.id);
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: "撤销一条自有会话" })
  async revokeSession(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    await this.authService.revokeOwnSession(req.user.id, id);
    return { ok: true };
  }

  private setSessionCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(this.config.cookie, this.config.cookie.absoluteHours * 3600),
    );
  }
}
