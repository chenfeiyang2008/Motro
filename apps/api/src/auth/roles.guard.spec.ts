// 角色守卫单元测试（无需数据库）。
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { ROLES_KEY, RolesGuard } from "./roles.guard.js";

function contextFor(handler: () => void, user?: { role: string }) {
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  };
}

describe("RolesGuard", () => {
  it("未声明角色要求时放行", () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(contextFor(() => {}, undefined))).toBe(true);
  });

  it("管理员通过", () => {
    const handler = (): void => {};
    Reflect.defineMetadata(ROLES_KEY, ["admin"], handler);
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(contextFor(handler, { role: "admin" }))).toBe(true);
  });

  it("学习者被拒绝", () => {
    const handler = (): void => {};
    Reflect.defineMetadata(ROLES_KEY, ["admin"], handler);
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(contextFor(handler, { role: "learner" }))).toThrow(
      ForbiddenException,
    );
  });
});
