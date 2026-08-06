// 会话守卫：从 HttpOnly cookie 校验会话，附加 user/session。
// 同时强制首次改密门禁：must_change_password 用户只能访问必要的认证端点。
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { SESSION_COOKIE } from "./cookies.js";
import { SessionService, type SessionRecord, type UserRecord } from "./session.service.js";

export interface AuthenticatedRequest extends FastifyRequest {
  user: UserRecord;
  session: SessionRecord;
}

/** must_change_password 用户仍允许访问的必要认证端点（前缀匹配）。 */
const PENDING_CHANGE_ALLOWED_PREFIXES = [
  "/api/v1/auth/me",
  "/api/v1/auth/change-password",
  "/api/v1/auth/logout",
  "/api/v1/auth/sessions",
];

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessionService: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException("未登录");
    const valid = await this.sessionService.validate(token);
    if (!valid) throw new UnauthorizedException("会话无效或已过期");

    req.user = valid.user;
    req.session = valid.session;

    if (valid.user.must_change_password && !this.isAllowedPendingPath(req.url)) {
      // 服务端强制：一次性密码登录后必须先改密，才能访问受保护端点。
      throw new ForbiddenException("请先修改初始密码");
    }
    return true;
  }

  private isAllowedPendingPath(url: string): boolean {
    const path = (url ?? "").split("?")[0] ?? "";
    return PENDING_CHANGE_ALLOWED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  }
}
