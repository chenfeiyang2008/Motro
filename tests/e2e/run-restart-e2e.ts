// Worker 重启恢复 E2E（工单 04 修复，P1-1 复核）：真实启动 Worker → 让 Worker 实际运行
// → SIGKILL 硬崩溃 → 断言容器变化 → 重启 → 验证 recovery loop 恢复。
//
// 本测试区别于 crash-residue 补充用例：
//  - 不直接插入 running+expired 残留 row（那只证明在线 recovery loop，不能证明重启恢复）；
//  - 真实投递 job → Worker 领取并执行（operation 进入 running）→ 真实 SIGKILL Worker →
//    验证容器 ID/启动时间变化 → 等待 lease 到期 → 重启 Worker → recovery loop 恢复；
//  - 断言原 job 已被消费（不再存在于 graphile_worker 队列，或明确证明恢复不依赖原 job）；
//  - 断言 attempt 时间线 abandoned → succeeded、最终 status=succeeded、claim/lease 清空。
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
const WORKER_SERVICE = "worker-e2e";
/** 容器名（compose 约定：<project>-<service>-<replica>）。 */
const WORKER_CONTAINER = "motro-e2e-import-worker-e2e-1";

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
    const child = spawn(cmd, args, { stdio: "inherit", cwd: resolve(process.cwd()) });
    child.on("error", () => res(false));
    child.on("close", (code) => res(code === 0));
  });
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((res) => {
    const out: Buffer[] = [];
    const child = spawn(cmd, args, { cwd: resolve(process.cwd()) });
    child.stdout.on("data", (d) => out.push(Buffer.from(d)));
    child.stderr.on("data", (d) => out.push(Buffer.from(d)));
    child.on("error", () => res(""));
    child.on("close", () => res(Buffer.concat(out).toString("utf8").trim()));
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

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected)
    throw new Error(`${msg}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function main(): Promise<void> {
  const target = resolveIsolatedE2eTarget();
  console.log("[restart-e2e] 启动隔离栈…");
  // concurrency=2：允许 recovery job 与原 stuck job 并发执行，避免单槽位饥饿。
  process.env.WORKER_CONCURRENCY = "2";
  // lease 大于 crash-recovery fixture 的持锁时长（10s），保证重领后的 attempt 在 lease
  // 内完成（配合心跳续租）；若 lease 过短，10s 持锁在 lease 到期前未完成会反复被重领。
  process.env.WORKER_LEASE_MS = "15000";
  const started = await run("docker", ["compose", "-f", COMPOSE, "up", "-d", "--build"]);
  if (!started) throw new Error("docker compose up 失败");
  await waitFor(`${target.apiUrl}/api/v1/health/live`, "api");
  await waitFor(`${target.apiUrl}/api/v1/health/ready`, "api-ready");
  // 等待 worker 常驻（迁移 one-shot 完成；compose 已保证 api 等待 worker-migrate 完成）。
  await sleep(6000);

  // 记录 Worker 容器初始 ID 与启动时间（重启后 ID 或启动时间必须变化）。
  const workerIdBefore = await exec("docker", ["inspect", "-f", "{{.Id}}", WORKER_CONTAINER]);
  const workerStartedBefore = await exec("docker", [
    "inspect",
    "-f",
    "{{.State.StartedAt}}",
    WORKER_CONTAINER,
  ]);
  console.log(
    `[restart-e2e] worker 初始容器 ID=${workerIdBefore.slice(0, 12)}… started=${workerStartedBefore}`,
  );
  if (!workerIdBefore) throw new Error("无法读取 worker 容器 ID（Worker 未启动）");

  const dbPool = createPool(toDbConfig(target.db));
  try {
    // 1) 种入 crash-recovery operation（queued，不伪造 running+expired），并投递真实 job。
    //    0029：target_id 必须引用真实 import_batch_commit_rows(id)。
    const targetId = await createCommitRowSql(dbPool);
    await dbPool.query(
      `INSERT INTO application_operations
         (operation_type, operation_version, target_type, target_id, input_hash, input_version,
          status, task_identifier, queue_name, max_attempts, retryable)
       VALUES ($1, 1, 'import_batch_commit_row', $2, $3, $4, 'queued', $1, $5, 5, true)`,
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
      ],
    );
    const opRow = await dbPool.query<{ id: string }>(
      "SELECT id FROM application_operations WHERE target_id = $1",
      [targetId],
    );
    const operationId = opRow.rows[0]!.id;
    console.log(`[restart-e2e] seeded queued operation ${operationId}，投递真实 job…`);
    // 真实投递 job（公共 API）。
    const originalJob = await dbPool.query<{ id: string }>(
      `SELECT (graphile_worker.add_job($1, $2::json, $3, NULL, 5, $4, 0, NULL, 'replace')).id AS id`,
      [
        OP_TYPE,
        JSON.stringify({ operationId, inputVersion: CRASH_RECOVERY_IV }),
        QUEUE,
        `motro:op:${operationId}`,
      ],
    );
    const originalJobId = originalJob.rows[0]?.id;
    if (!originalJobId) throw new Error("原 Graphile job 未创建");

    // 2) 等待 Worker 领取并执行（operation 进入 running，claim_token 已写入 → 证明
    //    Worker 真的在运行，并非残留 row）。
    let running = false;
    for (let i = 0; i < 30; i++) {
      const r = await dbPool.query<{
        status: string;
        lease_expires_at: Date | null;
        claim_token: string | null;
      }>("SELECT status, lease_expires_at, claim_token FROM application_operations WHERE id = $1", [
        operationId,
      ]);
      if (r.rows[0]?.status === "running" && r.rows[0]?.claim_token) {
        running = true;
        console.log(
          `[restart-e2e] Worker 已在 running：claim_token=${r.rows[0].claim_token.slice(0, 8)}…, ` +
            `lease_expires_at=${r.rows[0].lease_expires_at}`,
        );
        break;
      }
      await sleep(500);
    }
    if (!running)
      throw new Error("Worker 未能在预期时间内领取 job 进入 running（Worker 未真实运行）");

    // 3) 记录原 job 是否存在（worker 领取后 Graphile 会锁定/消费它）。
    const origJobBefore = await dbPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE key = $1`,
      [`motro:op:${operationId}`],
    );

    // 4) 真实硬崩溃（SIGKILL）：不走优雅 shutdown，不让 handler 写 retry_wait；旧 attempt
    //    必须在 lease 到期后由 recovery 重新领取并标记 abandoned。
    console.log("[restart-e2e] 真实 SIGKILL Worker 容器（模拟硬崩溃）…");
    const killed = await run("docker", ["kill", "--signal=KILL", WORKER_CONTAINER]);
    if (!killed) throw new Error("docker kill worker 失败");
    // 等待容器真正停止。
    let stoppedProc = false;
    for (let i = 0; i < 30; i++) {
      const state = await exec("docker", ["inspect", "-f", "{{.State.Running}}", WORKER_CONTAINER]);
      if (state === "false") {
        stoppedProc = true;
        break;
      }
      await sleep(500);
    }
    if (!stoppedProc) throw new Error("Worker 容器未在预期时间内停止（stop 未生效）");
    console.log("[restart-e2e] Worker 容器已停止");

    // 5) 等待 lease 到期（WORKER_LEASE_MS=15000 + 余量；轮询直到 lease_expires_at 已过去）。
    console.log("[restart-e2e] 等待 lease 到期…");
    let leaseExpired = false;
    for (let i = 0; i < 60; i++) {
      const leaseRow = await dbPool.query<{ lease_expires_at: Date | null }>(
        "SELECT lease_expires_at FROM application_operations WHERE id = $1",
        [operationId],
      );
      if (
        leaseRow.rows[0]!.lease_expires_at === null ||
        new Date(leaseRow.rows[0]!.lease_expires_at) <= new Date()
      ) {
        leaseExpired = true;
        break;
      }
      await sleep(1000);
    }
    if (!leaseExpired) throw new Error("lease 未在预期时间内到期");
    // 原 job 在硬崩溃后仍被旧 worker lock；不强制解锁它，避免原 job 自己触发重领而掩盖
    // recovery loop。新 worker 以 concurrency=2 消费独立 recovery job。
    const origJobAfter = await dbPool.query<{
      id: string;
      locked_at: Date | null;
      locked_by: string | null;
    }>(`SELECT id, locked_at, locked_by FROM graphile_worker.jobs WHERE key = $1`, [
      `motro:op:${operationId}`,
    ]);
    assertEq(Number(origJobBefore.rows[0]!.n), 1, "硬崩溃前原 job 应存在");
    assertEq(origJobAfter.rows[0]?.id, originalJobId, "硬崩溃后原 job 仍应是同一条锁定 job");
    if (!origJobAfter.rows[0]?.locked_at || !origJobAfter.rows[0]?.locked_by) {
      throw new Error("硬崩溃后原 job 未保持 lock，无法证明恢复未依赖原 job");
    }

    // 6) 重启 Worker（docker compose up，重新启动容器；ID 或启动时间必须变化）。
    console.log("[restart-e2e] 重启 Worker 容器…");
    const restarted = await run("docker", ["compose", "-f", COMPOSE, "up", "-d", WORKER_SERVICE]);
    if (!restarted) throw new Error("docker compose up worker 失败");
    const workerIdAfter = await exec("docker", ["inspect", "-f", "{{.Id}}", WORKER_CONTAINER]);
    const workerStartedAfter = await exec("docker", [
      "inspect",
      "-f",
      "{{.State.StartedAt}}",
      WORKER_CONTAINER,
    ]);
    console.log(
      `[restart-e2e] worker 重启后容器 ID=${workerIdAfter.slice(0, 12)}… ` +
        `started=${workerStartedAfter}（before started=${workerStartedBefore}）`,
    );
    if (!workerIdAfter) throw new Error("重启后无法读取 worker 容器 ID");
    if (workerIdAfter === workerIdBefore && workerStartedAfter === workerStartedBefore) {
      throw new Error(
        "worker 容器 ID 与启动时间均未变化——重启未真正重新启动容器，不能证明重启恢复",
      );
    }

    // 7) 验证恢复：新 worker 启动后 recovery loop 扫描过期 running → 投递 recovery job →
    //    消费 → 重新 claim → fixture 持锁 10s → succeeded。
    console.log("[restart-e2e] 等待 recovery loop + 新 worker 执行完成…");
    let finalStatus = "";
    for (let i = 0; i < 240; i++) {
      const r = await dbPool.query<{ status: string }>(
        "SELECT status FROM application_operations WHERE id = $1",
        [operationId],
      );
      finalStatus = r.rows[0]!.status;
      if (finalStatus === "succeeded") break;
      await sleep(1000);
    }
    if (finalStatus !== "succeeded") {
      console.log("[restart-e2e] [诊断] worker 容器日志：");
      await run("docker", ["compose", "-f", COMPOSE, "logs", "--tail", "80", WORKER_SERVICE]);
      // 诊断：operation 的 attempt 数与相关 job 状态。
      const diagOp = await dbPool.query<{
        status: string;
        attempt_count: number;
        claim_token: string | null;
        lease_expires_at: Date | null;
      }>(
        "SELECT status, attempt_count, claim_token, lease_expires_at FROM application_operations WHERE id = $1",
        [operationId],
      );
      console.log(`[restart-e2e] [诊断] op=${JSON.stringify(diagOp.rows[0])}`);
      const diagAtt = await dbPool.query<{ attempt_number: number; outcome: string | null }>(
        "SELECT attempt_number, outcome FROM application_operation_attempts WHERE operation_id = $1 ORDER BY attempt_number",
        [operationId],
      );
      console.log(`[restart-e2e] [诊断] attempts=${JSON.stringify(diagAtt.rows)}`);
      const diagJobs = await dbPool.query<{
        key: string | null;
        attempts: number;
        locked_at: Date | null;
        run_at: Date | null;
      }>(
        `SELECT key, attempts, locked_at, run_at FROM graphile_worker.jobs WHERE key LIKE $1 OR key LIKE $2`,
        [`%${operationId}%`, "motro:ops:recover:%"],
      );
      console.log(`[restart-e2e] [诊断] jobs=${JSON.stringify(diagJobs.rows)}`);
      throw new Error(`重启后 operation 未恢复到 succeeded（当前 ${finalStatus}）`);
    }
    // attempt 时间线：至少 2 个 attempt，第一个 abandoned，最后一个 succeeded。
    const att = await dbPool.query<{ attempt_number: number; outcome: string | null }>(
      "SELECT attempt_number, outcome FROM application_operation_attempts WHERE operation_id = $1 ORDER BY attempt_number",
      [operationId],
    );
    console.log(`[restart-e2e] attempts=${JSON.stringify(att.rows)}`);
    if (att.rows.length < 2)
      throw new Error("重启恢复应产生至少 2 个 attempt（旧 abandoned + 新 succeeded）");
    assertEq(att.rows[0]!.outcome, "abandoned", "旧 attempt 应为 abandoned");
    assertEq(att.rows[att.rows.length - 1]!.outcome, "succeeded", "新 attempt 应为 succeeded");

    // 8) DB 持久化最终状态：succeeded，lease/claim 已清除。
    const dbFinal = await dbPool.query<{
      status: string;
      lease_expires_at: Date | null;
      claim_token: string | null;
      graphile_job_id: string | null;
    }>(
      `SELECT status, lease_expires_at, claim_token, graphile_job_id
       FROM application_operations WHERE id = $1`,
      [operationId],
    );
    assertEq(dbFinal.rows[0]!.status, "succeeded", "DB 最终状态");
    assertEq(dbFinal.rows[0]!.lease_expires_at, null, "lease 应已清除");
    assertEq(dbFinal.rows[0]!.claim_token, null, "claim token 应已清除");
    if (!dbFinal.rows[0]!.graphile_job_id || dbFinal.rows[0]!.graphile_job_id === originalJobId) {
      throw new Error(
        "最终 operation 未保存 recovery job identity，无法证明恢复扫描实际投递了新 job",
      );
    }
    console.log(
      "[restart-e2e] 真实硬崩溃恢复成功：SIGKILL Worker → 原 job 保持锁定 → 新 recovery job 恢复到 succeeded，共享库未受影响。",
    );
  } finally {
    await dbPool.end();
    console.log("[restart-e2e] 清理隔离栈（down -v）…");
    await run("docker", ["compose", "-f", COMPOSE, "down", "-v"]);
  }
}

main().catch((e) => {
  console.error("[restart-e2e] 失败：", e);
  process.exitCode = 1;
});
