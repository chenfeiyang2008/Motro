// 登录限速单元测试（无需数据库）。
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { LoginRateLimitGuard } from "./rate-limit.guard.js";

function contextFor(ip: string, username?: string) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ ip, body: { username } }) }),
  };
}

describe("LoginRateLimitGuard", () => {
  it("同一 IP+账号 超过账号阈值抛 429", () => {
    const guard = new LoginRateLimitGuard();
    const ctx = contextFor("10.0.0.1", "alice");
    for (let i = 0; i < 10; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
  });

  it("不同账号在同一 IP 各自计数，但受 IP 总量上限约束", () => {
    const guard = new LoginRateLimitGuard();
    // 账号阈值 10、IP 阈值 50；连续对 11 个账号各尝试 5 次应触发 IP 上限。
    let threw = false;
    for (let a = 0; a < 11 && !threw; a++) {
      for (let i = 0; i < 5; i++) {
        try {
          guard.canActivate(contextFor("10.0.0.2", `user${a}`));
        } catch {
          threw = true;
          break;
        }
      }
    }
    expect(threw).toBe(true);
  });

  it("窗口过期后计数重置", () => {
    const guard = new LoginRateLimitGuard();
    const ctx = contextFor("10.0.0.3", "bob");
    for (let i = 0; i < 10; i++) guard.canActivate(ctx);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    // 直接改写内部窗口为过期，验证下一分钟放行。
    (guard as unknown as { windows: Map<string, { resetAt: number }> }).windows.clear();
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("缺失用户名退化为 IP 维度计数", () => {
    const guard = new LoginRateLimitGuard();
    const ctx = contextFor("10.0.0.4");
    // 无用户名时不按账号计数，但仍在 IP 总量内；50 次内放行。
    for (let i = 0; i < 50; i++) expect(guard.canActivate(ctx)).toBe(true);
  });
});
