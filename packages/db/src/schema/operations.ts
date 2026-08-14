// 阶段 6 工单 04：application operation / attempt 事实 schema。
// 与 db/migrations/0025_worker_operations_foundation.sql 保持一致。
//
// 只暴露安全投影需要的字段；不存储完整异常、供应商 payload、路径或密钥。
// graphileJobId 是诊断文本，不建立到 Graphile 私有表的外键（Graphile schema 由官方
// runMigrations() 独立管理，motro 内不复制也不依赖私有表）。
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./platform-identity.js";
import { importBatchCommitRows } from "./imports.js";

export const applicationOperations = pgTable(
  "application_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationType: text("operation_type").notNull(),
    operationVersion: integer("operation_version").notNull().default(1),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id")
      .notNull()
      .references(() => importBatchCommitRows.id, { onDelete: "restrict" }),
    inputHash: text("input_hash").notNull(),
    inputVersion: integer("input_version").notNull().default(1),
    status: text("status").notNull().default("queued"),
    taskIdentifier: text("task_identifier").notNull(),
    queueName: text("queue_name").notNull(),
    graphileJobId: text("graphile_job_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    retryable: boolean("retryable").notNull().default(true),
    lastErrorCode: text("last_error_code"),
    lastErrorSummary: text("last_error_summary"),
    claimToken: text("claim_token"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("application_operations_type_target_input_unique").on(
      t.operationType,
      t.targetType,
      t.targetId,
      t.inputHash,
    ),
    index("application_operations_status_idx").on(t.status),
    index("application_operations_target_idx").on(t.targetType, t.targetId),
    index("application_operations_created_at_idx").on(t.createdAt),
    index("application_operations_updated_at_idx").on(t.updatedAt),
    index("application_operations_lease_expiry_idx")
      .on(t.leaseExpiresAt)
      .where(sql`status = 'running'`),
  ],
);

export const applicationOperationAttempts = pgTable(
  "application_operation_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => applicationOperations.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome"),
    workerJobId: text("worker_job_id"),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
  },
  (t) => [
    uniqueIndex("application_operation_attempts_operation_id_attempt_number_unique").on(
      t.operationId,
      t.attemptNumber,
    ),
    index("application_operation_attempts_operation_id_idx").on(t.operationId, t.attemptNumber),
  ],
);
