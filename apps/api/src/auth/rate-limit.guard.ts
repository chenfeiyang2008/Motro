// 登录限速：进程内滑动窗口，按「IP + 账号」与「IP」双层计数。
// 限制：仅单实例有效；多实例需共享存储（如 Redis）。详见 docs/architecture 限制说明。
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { loadConfig } from "@motro/config";

interface Window {
  count: number;
  resetAt: number;
}

@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, Window>();
  private readonly perAccountPerMinute: number;
  private readonly perIpPerMinute: number;

  constructor() {
    const perMinute = loadConfig().rateLimit.loginPerMinute;
    this.perAccountPerMinute = perMinute;
    this.perIpPerMinute = perMinute * 5;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      ip?: string;
      body?: { username?: string };
    }>();
    const ip = req.ip ?? "unknown";
    const username = (req.body?.username ?? "").trim().toLowerCase();

    this.checkWindow(`ip:${ip}`, this.perIpPerMinute);
    // 账号为空（未知/缺失）时退化为 IP 维度，避免用未知账号绕过。
    if (username.length > 0) {
      this.checkWindow(`ip:${ip}:user:${username}`, this.perAccountPerMinute);
    }
    return true;
  }

  private checkWindow(key: string, cap: number): void {
    const now = Date.now();
    const entry = this.windows.get(key);
    if (!entry || entry.resetAt < now) {
      this.windows.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    entry.count += 1;
    if (entry.count > cap) {
      throw new HttpException("登录尝试过于频繁，请稍后再试", HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
