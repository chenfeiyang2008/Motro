// Worker lease-expiry 恢复回环 E2E（工单 04 修复）：真实 Docker worker 中，周期性
// recovery loop 自动发现并恢复已过期的 running operation。
//
// 说明：recovery loop 的存在目的，就是挽救【因任何机制】停留在 running 且 lease 已过期
// 的 operation（例如 worker 硬崩溃后原 Graphile job 已被消费、无新的 job 重新领取）。
// 因此本 E2E 直接种入"崩溃后的残余状态"（running + lease 已过期，无 job），启动 worker，
// 验证 recovery loop 在真实容器内：
//   1. 启动后立即扫描，发现已过期的 running operation；
//   2. 通过公共 graphile_worker.add_job 投递 recovery job；
//   3. worker 的 Graphile 消费该 job，重新 claim（旧 attempt 标记 abandoned）；
//   4. crash-recovery fixture 成功，operation → succeeded；
//   5. DB 持久化最终状态，attempt 时间线正确（第一个 abandoned，最后一个 succeeded）。
//
// 全程使用官方公共 API（graphile_worker.add_job / graphile_worker.jobs 只读 view），
// 从不查询 _private_* 表。完成后 down -v 整体销毁，共享库未受影响。
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { createPool } from "@motro/db";
import { operationInputHash } from "@motro/domain";
import { resolveIsolatedE2eTarget, toDbConfig } from "./import-e2e-db.js";
import type { Pool } from "pg";

const COMPOSE = "compose/e2e-import.yml";
const OP_TYPE = "motro-op-fixture";
const QUEUE = "local";
/** crash-recovery fixture 的 input_version（见 fixture-handler）：持锁约 10s 后成功。 */
const CRASH_RECOVERY_IV = 5;

/** 在隔离库构造一个最小合法 import_batch_commit_rows（0029：target_id 必须引用真实行）。 */
async function createCommitRowSql(pool: Pool): Promise<string> {
  const userId = (
    await pool.query<{ id: string }>(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'E2E Commit Row User', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2 RETURNING id`,
      ["e2e-commit-row-user", "not-a-real-hash"],
    )
  ).rows[0]!.id;
  const spelling = `e2e-${randomUUID().slice(0, 8)}`;
  const fileId = (
    await pool.query<{ id: string }>(
      `INSERT INTO stored_files
         (storage_key, original_filename, declared_mime, sniffed_mime, byte_size, sha256_hex, uploaded_by, purpose, format)
       VALUES ($1, $2, 'text/plain', 'text/plain', 4, $3, $4, 'original_import', 'txt') RETURNING id`,
      [
        `test://${spelling}`,
        `${spelling}.txt`,
        createHash("sha256").update(spelling).digest("hex"),
        userId,
      ],
    )
  ).rows[0]!.id;
  const batchId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batches (file_id, uploaded_by, format, source_declaration)
       VALUES ($1, $2, 'txt', $3) RETURNING id`,
      [fileId, userId, `source: ${spelling}`],
    )
  ).rows[0]!.id;
  const importRowId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_rows (batch_id, ordinal, mapping_version, raw_summary, normalized_spelling, status)
       VALUES ($1, 1, 1, $2, $2, 'candidate') RETURNING id`,
      [batchId, spelling],
    )
  ).rows[0]!.id;
  const commitId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batch_commits (batch_id, committed_by, mapping_version, semantic_hash, status)
       VALUES ($1, $2, 1, $3, 'completed') RETURNING id`,
      [batchId, userId, createHash("sha256").update(spelling).digest("hex")],
    )
  ).rows[0]!.id;
  const entryId = (
    await pool.query<{ id: string }>(
      `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
       VALUES ($1, $1, '[]'::jsonb) RETURNING id`,
      [spelling],
    )
  ).rows[0]!.id;
  const sourceId = (
    await pool.query<{ id: string }>(
      `INSERT INTO lexical_sources (lexical_entry_id, source_type, content_hash, created_by)
       VALUES ($1, 'import', $2, $3) RETURNING id`,
      [entryId, createHash("sha256").update(spelling).digest("hex"), userId],
    )
  ).rows[0]!.id;
  const commitRowId = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_batch_commit_rows
         (commit_id, import_row_id, ordinal, normalized_spelling, created_entry_id, lexical_entry_id, lexical_source_id)
       VALUES ($1, $2, 1, $3, $4, $4, $5) RETURNING id`,
      [commitId, importRowId, spelling, entryId, sourceId],
    )
  ).rows[0]!.id;
  return commitRowId;
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      cwd: resolve(process.cwd()),
    });
    child.on("error", () => res(false));
    child.on("close", (code) => res(code === 0));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function waitFor(url: string, what: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await sleep(2000);
  }
  throw new Error(`${what} 未就绪：${url}`);
}

async function main(): Promise<void> {
  const target = resolveIsolatedE2eTarget();
  console.log("[recovery-e2e] 启动隔离栈…");

  // 使用最小 recovery 间隔（500ms=合法下界）以快速验收，同时保持安全低频上限约束。
  process.env.WORKER_RECOVER_INTERVAL_MS = "500";
  process.env.WORKER_RECOVER_BATCH_SIZE = "20";
  process.env.WORKER_LEASE_MS = "3000";

  const started = await run("docker", ["compose", "-f", COMPOSE, "up", "-d", "--build"]);
  if (!started) throw new Error("docker compose up 失败");
  await waitFor(`${target.apiUrl}/api/v1/health/live`, "api");
  await waitFor(`${target.apiUrl}/api/v1/health/ready`, "api-ready");
  // 等待 worker-migrate + worker 常驻启动完成（recovery loop 已注册）。
  await sleep(6000);

  const dbPool = createPool(toDbConfig(target.db));
  try {
    // 1) 种入崩溃后的残余状态：running + lease 已过期，不投递任何 job。
    //    0029：target_id 必须引用真实 import_batch_commit_rows(id)。
    const targetId = await createCommitRowSql(dbPool);
    const cl = await dbPool.connect();
    await cl.query("BEGIN");
    let operationId: string;
    try {
      const res = await cl.query<{ id: string }>(
        `INSERT INTO application_operations
           (operation_type, operation_version, target_type, target_id, input_hash, input_version,
            status, task_identifier, queue_name, max_attempts, retryable, attempt_count,
            claim_token, lease_owner, lease_expires_at, started_at)
         VALUES ($1, 1, 'import_batch_commit_row', $2, $3, $4, 'running', $1, $5, 5, true, 1,
                 $6, 'crashed-worker', now() - interval '1 minute', now())
         RETURNING id`,
        [
          OP_TYPE,
          targetId,
          operationInputHash({
            operationType: OP_TYPE,
            targetType: "import_batch_commit_row",
            targetId,
            inputVersion: CRASH_RECOVERY_IV,
          }),
          CRASH_RECOVERY_IV,
          QUEUE,
          randomUUID(),
        ],
      );
      operationId = res.rows[0]!.id;
      await cl.query("COMMIT");
    } catch (err) {
      await cl.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      cl.release();
    }
    // 制造一个已过期的旧 running attempt（模拟旧 worker 崩溃留下的 attempt）。
    await dbPool.query(
      `INSERT INTO application_operation_attempts (operation_id, attempt_number, worker_job_id, started_at)
       VALUES ($1, 1, 'crashed-job', now() - interval '2 minutes')`,
      [operationId],
    );
    console.log(
      `[recovery-e2e] seeded crash-residue operation ${operationId}（running + 过期 lease）`,
    );

    // 2) 等待 recovery loop（intervalMs=500ms，worker 已启动并注册）发现并恢复。
    //    路径：recovery loop 扫描 → add_job 投递 recovery job → Graphile 消费 →
    //    claimOperation 重领（旧 attempt → abandoned）→ fixture 持锁 10s → succeeded。
    console.log("[recovery-e2e] 等待 recovery loop 恢复 operation…");
    let finalStatus = "";
    for (let i = 0; i < 120; i++) {
      const r = await dbPool.query<{ status: string }>(
        "SELECT status FROM application_operations WHERE id = $1",
        [operationId],
      );
      finalStatus = r.rows[0]!.status;
      if (finalStatus === "succeeded") break;
      await sleep(1000);
    }
    if (finalStatus !== "succeeded") {
      console.log("[recovery-e2e] [诊断] worker 容器日志：");
      await run("docker", ["compose", "-f", COMPOSE, "logs", "--tail", "60", "worker-e2e"]);
      const jobs = await dbPool.query<{
        key: string | null;
        attempts: number;
        locked_at: Date | null;
      }>(
        `SELECT key, attempts, locked_at FROM graphile_worker.jobs WHERE key LIKE $1 OR key LIKE $2`,
        [`%${operationId}%`, "motro:ops:recover:%"],
      );
      console.log(`[recovery-e2e] [诊断] 相关 job=${JSON.stringify(jobs.rows)}`);
      throw new Error(`operation 未由 recovery loop 恢复到 succeeded（当前 ${finalStatus}）`);
    }

    // 3) attempt 时间线：旧 attempt abandoned，新 attempt succeeded。
    const att = await dbPool.query<{ attempt_number: number; outcome: string | null }>(
      "SELECT attempt_number, outcome FROM application_operation_attempts WHERE operation_id = $1 ORDER BY attempt_number",
      [operationId],
    );
    console.log(`[recovery-e2e] attempts=${JSON.stringify(att.rows)}`);
    if (att.rows.length < 2)
      throw new Error("恢复应产生至少 2 个 attempt（旧 abandoned + 新 succeeded）");
    const assertEq = (a: unknown, b: unknown, msg: string): void => {
      if (a !== b) throw new Error(`${msg}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
    };
    assertEq(att.rows[0]!.outcome, "abandoned", "旧 attempt 应为 abandoned");
    assertEq(att.rows[att.rows.length - 1]!.outcome, "succeeded", "新 attempt 应为 succeeded");

    // 4) DB 持久化最终状态：succeeded，lease 已清除。
    const dbFinal = await dbPool.query<{
      status: string;
      attempt_count: number;
      lease_expires_at: Date | null;
      claim_token: string | null;
    }>(
      "SELECT status, attempt_count, lease_expires_at, claim_token FROM application_operations WHERE id = $1",
      [operationId],
    );
    assertEq(dbFinal.rows[0]!.status, "succeeded", "DB 最终状态");
    assertEq(dbFinal.rows[0]!.lease_expires_at, null, "lease 应已清除");
    assertEq(dbFinal.rows[0]!.claim_token, null, "claim token 应已清除");
    console.log(
      `[recovery-e2e] 恢复成功：旧 attempt abandoned，新 attempt succeeded，` +
        `attempt_count=${dbFinal.rows[0]!.attempt_count}，lease/claim 已清除，共享库未受影响。`,
    );
  } finally {
    await dbPool.end();
    console.log("[recovery-e2e] 清理隔离栈（down -v）…");
    await run("docker", ["compose", "-f", COMPOSE, "down", "-v"]);
  }
}

main().catch((e) => {
  console.error("[recovery-e2e] 失败：", e);
  process.exitCode = 1;
});
