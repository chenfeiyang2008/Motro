// 密码哈希单元测试（无数据库）。
import { describe, expect, it } from "vitest";
import { PasswordService } from "./password.service.js";

describe("PasswordService", () => {
  const service = new PasswordService();

  it("Argon2id 哈希可验证匹配的密码", async () => {
    const hashed = await service.hashPassword("correct-horse-1234");
    expect(hashed).not.toContain("correct-horse-1234");
    await expect(service.verifyPassword(hashed, "correct-horse-1234")).resolves.toBe(true);
  });

  it("拒绝不匹配的密码", async () => {
    const hashed = await service.hashPassword("correct-horse-1234");
    await expect(service.verifyPassword(hashed, "wrong-password")).resolves.toBe(false);
  });

  it("相同密码两次哈希不同（随机盐）", async () => {
    const a = await service.hashPassword("same-password-123");
    const b = await service.hashPassword("same-password-123");
    expect(a).not.toBe(b);
  });
});
