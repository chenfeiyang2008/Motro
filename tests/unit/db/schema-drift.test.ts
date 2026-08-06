// schema/migration 一致性（drift）守卫：Drizzle schema 必须与显式 SQL migration 同步声明关键结构。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const schema = readFileSync(resolve(ROOT, "packages/db/src/schema/platform-identity.ts"), "utf8");

describe("schema / migration 一致性", () => {
  it("0003 的 otp_consumed 与 request_hash 在 schema 中同步声明", () => {
    const sql = readFileSync(resolve(ROOT, "db/migrations/0003_auth_hardening.sql"), "utf8");
    expect(sql).toContain("otp_consumed");
    expect(sql).toContain("request_hash");
    expect(schema).toContain("otpConsumed");
    expect(schema).toContain("requestHash");
  });

  it("idempotency_keys 复合主键在 SQL 与 Drizzle 中一致", () => {
    const sql = readFileSync(resolve(ROOT, "db/migrations/0002_auth_idempotency.sql"), "utf8");
    expect(sql).toMatch(/PRIMARY KEY \(scope, key\)/);
    expect(schema).toContain("primaryKey({ columns: [t.scope, t.key] })");
  });
});
