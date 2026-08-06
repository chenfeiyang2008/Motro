// 平台身份/会话基础结构。
// 与 db/migrations/0001_platform_identity.sql 保持一致；不含任何业务领域表。
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull().default("learner"),
    status: text("status").notNull().default("active"),
    timezone: text("timezone").notNull(),
    dailyBudgetMinutes: integer("daily_budget_minutes").notNull().default(10),
    passwordHash: text("password_hash").notNull(),
    passwordVersion: integer("password_version").notNull().default(1),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    otpConsumed: boolean("otp_consumed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_username_unique").on(t.username)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenDigest: text("token_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    clientSummary: jsonb("client_summary"),
  },
  (t) => [
    uniqueIndex("auth_sessions_token_digest_unique").on(t.tokenDigest),
    index("auth_sessions_user_id_idx").on(t.userId),
    index("auth_sessions_expiry_idx").on(t.absoluteExpiresAt),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull().default(""),
    responseJson: jsonb("response_json").notNull(),
    // 可关联的资源 ID（如发布生成的 release_id），供同 key 恢复唯一匹配；可空。
    resourceId: text("resource_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 复合主键 (scope, key)，与 0002 SQL 一致。
    primaryKey({ columns: [t.scope, t.key] }),
    index("idempotency_keys_created_at_idx").on(t.createdAt),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    beforeSummary: jsonb("before_summary"),
    afterSummary: jsonb("after_summary"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_actor_id_idx").on(t.actorId),
    index("audit_events_created_at_idx").on(t.createdAt),
  ],
);
