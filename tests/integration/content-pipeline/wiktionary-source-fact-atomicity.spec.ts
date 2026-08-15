// 阶段 6 工单 05：source fact 与 operation 原子性集成验收（真实 PostgreSQL）。
//
// 目标：证明「不可变 source fact 的写入与 operation completion 在同一事务提交」，
// 任何失败（stale claim / heartbeat 丢失 / completeAttempt 失败 / 非成功结果）都必须整体
// rollback，绝不留「operation 未成功但 fetched fact 已落库」的孤儿事实。
//
// 每项都在一次性隔离库上进行，完成后销毁，绝不动共享开发库。完全零网络。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { runMigrations } from "graphile-worker";
import { claimOperation, executeOperation } from "../../../apps/worker/src/operation-executor.js";
import { buildWiktionaryFakeHandler } from "../../../apps/worker/src/wiktionary-fake-handler.js";
import { operationInputHash } from "@motro/domain";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
import { createCommitRow } from "../operations/commit-row-helper.js";

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const previousImportFileRootDir = process.env.IMPORT_FILE_ROOT_DIR;
const previousPostgresDb = process.env.POSTGRES_DB;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function pgConn(cfg: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): string {
  const host = cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host;
  return `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${host}:${cfg.port}/${encodeURIComponent(cfg.database)}`;
}

async function canConnect(): Promise<boolean> {
  const probe = createPool({ ...config, max: 1 });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}
const dbAvailable = await canConnect();

const WIK_OP = "motro-wiktionary-fake";
const QUEUE = "local";
const IV_FETCH = 1;
const IV_PAGE_MISSING = 4;
const IV_AMBIGUOUS = 10;
const IV_MALFORMED = 6;
const IV_RETRYABLE = 12;

describe("wiktionary source-fact / operation atomicity", () => {
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let registry: ReturnType<typeof buildWiktionaryFakeHandler>;
  let isolatedDbName: string | undefined;
  let tempImportRoot: string;
  let fixtureUserId: string;

  async function createWikOp(opts: {
    inputVersion: number;
    commitRowId?: string;
  }): Promise<{ operationId: string; commitRowId: string }> {
    const commitRowId =
      opts.commitRowId ?? (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
    const inputVersion = opts.inputVersion;
    await pool.query(
      `INSERT INTO application_operations
         (operation_type, operation_version, target_type, target_id, input_hash, input_version,
          status, task_identifier, queue_name, max_attempts, requested_by)
       VALUES ($1, 1, 'import_batch_commit_row', $2, $3, $4, 'queued', $1, $5, 5, $6)
       RETURNING id`,
      [
        WIK_OP,
        commitRowId,
        operationInputHash({
          operationType: WIK_OP,
          targetType: "import_batch_commit_row",
          targetId: commitRowId,
          inputVersion,
        }),
        inputVersion,
        QUEUE,
        fixtureUserId,
      ],
    );
    const op = await pool.query<{ id: string }>(
      "SELECT id FROM application_operations WHERE target_id = $1 AND input_version = $2 ORDER BY created_at DESC LIMIT 1",
      [commitRowId, inputVersion],
    );
    return { operationId: op.rows[0]!.id, commitRowId };
  }

  async function factRows(): Promise<Array<Record<string, unknown>>> {
    const r = await pool.query("SELECT * FROM wiktionary_source_facts ORDER BY created_at");
    return r.rows as Array<Record<string, unknown>>;
  }

  async function factCount(): Promise<number> {
    const r = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM wiktionary_source_facts",
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async function opRow(id: string): Promise<Record<string, unknown>> {
    const r = await pool.query("SELECT * FROM application_operations WHERE id = $1", [id]);
    return r.rows[0]! as Record<string, unknown>;
  }

  async function attemptRows(id: string): Promise<Array<Record<string, unknown>>> {
    const r = await pool.query(
      "SELECT * FROM application_operation_attempts WHERE operation_id = $1 ORDER BY attempt_number",
      [id],
    );
    return r.rows as Array<Record<string, unknown>>;
  }

  beforeAll(async () => {
    if (!dbAvailable) throw new Error("atomicity 需要运行中的 PostgreSQL");
    isolatedDbName = `motro_wikiatomic_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolatedConfig = { ...config, database: isolatedDbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);
    await runMigrations({ connectionString: pgConn(isolatedConfig), schema: "graphile_worker" });

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-wikiatomic-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.POSTGRES_DB = isolatedDbName;

    pool = createPool({ ...isolatedConfig, max: 2 });
    workerPool = createPool({ ...isolatedConfig, max: 2 });
    registry = buildWiktionaryFakeHandler(workerPool);
    const ps = new PasswordService();
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'Atomic User', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
      ["atomic-user", await ps.hashPassword("fixture-pass-123")],
    );
    fixtureUserId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", ["atomic-user"])
    ).rows[0]!.id;
  });

  afterEach(async () => {
    await pool.query("TRUNCATE wiktionary_source_facts, application_operations CASCADE");
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
      if (workerPool) await workerPool.end();
      if (isolatedDbName) {
        const dropPool = createPool({ ...config, database: "postgres", max: 1 });
        try {
          await dropPool.query(`DROP DATABASE IF EXISTS "${isolatedDbName}"`);
        } finally {
          await dropPool.end();
        }
      }
    } finally {
      try {
        rmSync(tempImportRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      restoreEnv("IMPORT_FILE_ROOT_DIR", previousImportFileRootDir);
      restoreEnv("POSTGRES_DB", previousPostgresDb);
    }
  });

  describe("1. 正常成功原子提交", () => {
    it("fetched fact + completeAttempt 同事务 → operation=succeeded，恰好一条 fetched fact", async () => {
      const { operationId } = await createWikOp({ inputVersion: IV_FETCH });
      const outcome = await executeOperation(workerPool, registry, operationId, "at-success");
      expect(outcome).toBe("succeeded");
      const op = await opRow(operationId);
      expect(op.status).toBe("succeeded");
      expect(op.claim_token).toBeNull();
      expect(op.lease_expires_at).toBeNull();
      expect(op.completed_at).not.toBeNull();
      const facts = await factRows();
      expect(facts).toHaveLength(1);
      expect(facts[0]!.status).toBe("fetched");
      const att = await attemptRows(operationId);
      expect(att).toHaveLength(1);
      expect(att[0]!.outcome).toBe("succeeded");
    });
  });

  describe("2. stale claim 回滚", () => {
    it("completeAttempt 对已失效 claim 返回 stale_claim，且事务内已写事实被回滚（无孤儿 fetched）", async () => {
      const { completeAttemptInTx, writeDeferredFactsInTx } =
        await import("../../../apps/worker/src/operation-executor.js");
      const { contentHash, pageIdentity, revisionIdentity, sourceFactIdentity } =
        await import("@motro/domain");
      const { operationId, commitRowId } = await createWikOp({ inputVersion: IV_FETCH });
      const claimed = await claimOperation(workerPool, operationId, { leaseMs: 60_000 });
      expect(claimed.kind).toBe("claimed");
      const c = claimed as Extract<typeof claimed, { kind: "claimed" }>;
      const pageId = "p-atomic";
      const revisionId = "r-1";
      const fact = {
        sourceFactIdentity: sourceFactIdentity({
          pageId,
          revisionId,
          parserVersion: "fake-parser-1",
        }),
        pageIdentityHash: pageIdentity({ pageId, language: "en" }),
        revisionIdentityHash: revisionIdentity({ pageId, revisionId }),
        pageId,
        revisionId,
        revisionTimestamp: new Date(1_700_000_000_000),
        canonicalTitle: "run",
        normalizedSpelling: "run",
        language: "en",
        partOfSpeech: "noun",
        definitionExcerpt: "to move quickly",
        sourceUrl: "urn:fake:wiktionary:page",
        contentHash: contentHash({
          canonicalTitle: "run",
          normalizedSpelling: "run",
          language: "en",
          partOfSpeech: "noun",
          definitionExcerpt: "to move quickly",
          sourceUrl: "urn:fake:wiktionary:page",
        }),
        licenseName: "CC BY-SA 4.0",
        licenseVersion: "4.0",
        licenseUrl: "urn:fake:license:cc-by-sa-4.0",
        attribution: "Wiktionary contributors",
        parserVersion: "fake-parser-1",
        status: "fetched" as const,
        ambiguityNote: null,
        ambiguityCandidates: null,
        commitRowId,
        inputVersionUsed: IV_FETCH,
      };
      const conn = await workerPool.connect();
      try {
        await conn.query("BEGIN");
        await writeDeferredFactsInTx(conn, [fact]);
        const completed = await completeAttemptInTx(conn, {
          operationId,
          attemptNumber: c.attemptNumber,
          claimToken: "WRONG-TOKEN", // 伪造的 claim → stale_claim
          graphileJobId: "job-x",
          succeeded: true,
        });
        expect(completed).toBe("stale_claim");
        await conn.query("ROLLBACK");
      } finally {
        conn.release();
      }
      // 回滚后：无孤儿 fetched fact（同 identity 的事务写被回滚）。
      expect(await factCount()).toBe(0);
    });

    it("real executeOperation：claim 被接管后旧 worker 的执行返回 stale_claim，不写事实", async () => {
      const { operationId } = await createWikOp({ inputVersion: IV_FETCH });
      // worker A 领取并执行一个长跑 handler；随后 worker B 在未来时钟重领（A claim 失效）。
      const longRegistry = new Map(registry);
      longRegistry.set(WIK_OP, {
        taskIdentifier: WIK_OP,
        async run(_opId, signal) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
              reject(new Error("aborted after lost claim"));
            };
            const t = setTimeout(() => resolve(), 3000);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                onAbort();
              },
              { once: true },
            );
          });
          return { outcome: "succeeded", summary: "unreachable" };
        },
      });
      const execPromise = executeOperation(
        workerPool,
        longRegistry,
        operationId,
        "stale-job",
        undefined,
        {
          leaseMs: 250,
          leaseOwner: "stale-A",
        },
      );
      await new Promise((r) => setTimeout(r, 300));
      const claimedB = await claimOperation(workerPool, operationId, {
        leaseMs: 60_000,
        leaseOwner: "taker-B",
        now: new Date(Date.now() + 2_000),
      });
      expect(claimedB.kind).toBe("claimed");
      const outcome = await execPromise;
      expect(outcome).toBe("stale_claim");
      expect(await factCount()).toBe(0); // 旧 worker 未写 fetched fact
    });
  });

  describe("3. completeAttempt 失败回滚", () => {
    it("fact INSERT 成功但 completeAttempt 抛错 → 事务回滚，无半条事实", async () => {
      const { completeAttemptInTx, writeDeferredFactsInTx } =
        await import("../../../apps/worker/src/operation-executor.js");
      const { contentHash, pageIdentity, revisionIdentity, sourceFactIdentity } =
        await import("@motro/domain");
      const { operationId, commitRowId } = await createWikOp({ inputVersion: IV_FETCH });
      const claimed = await claimOperation(workerPool, operationId, { leaseMs: 60_000 });
      expect(claimed.kind).toBe("claimed");
      const pageId = "p-fail";
      const revisionId = "r-1";
      const fact = {
        sourceFactIdentity: sourceFactIdentity({
          pageId,
          revisionId,
          parserVersion: "fake-parser-1",
        }),
        pageIdentityHash: pageIdentity({ pageId, language: "en" }),
        revisionIdentityHash: revisionIdentity({ pageId, revisionId }),
        pageId,
        revisionId,
        revisionTimestamp: new Date(1_700_000_000_000),
        canonicalTitle: "run",
        normalizedSpelling: "run",
        language: "en",
        partOfSpeech: "noun",
        definitionExcerpt: "to move quickly",
        sourceUrl: "urn:fake:wiktionary:page",
        contentHash: contentHash({
          canonicalTitle: "run",
          normalizedSpelling: "run",
          language: "en",
          partOfSpeech: "noun",
          definitionExcerpt: "to move quickly",
          sourceUrl: "urn:fake:wiktionary:page",
        }),
        licenseName: "CC BY-SA 4.0",
        licenseVersion: "4.0",
        licenseUrl: "urn:fake:license:cc-by-sa-4.0",
        attribution: "Wiktionary contributors",
        parserVersion: "fake-parser-1",
        status: "fetched" as const,
        ambiguityNote: null,
        ambiguityCandidates: null,
        commitRowId,
        inputVersionUsed: IV_FETCH,
      };
      const conn = await workerPool.connect();
      let threw = false;
      try {
        await conn.query("BEGIN");
        await writeDeferredFactsInTx(conn, [fact]);
        // 强制 completeAttemptInTx 抛错：operation 不存在 → SELECT FOR UPDATE 无行 → throw。
        await expect(
          completeAttemptInTx(conn, {
            operationId: "00000000-0000-4000-8000-0000000000ee", // 不存在
            attemptNumber: 1,
            claimToken: "any",
            graphileJobId: "job-x",
            succeeded: true,
          }),
        ).rejects.toThrow();
        threw = true;
        await conn.query("ROLLBACK");
      } finally {
        if (!threw) {
          try {
            await conn.query("ROLLBACK");
          } catch {
            /* already aborted */
          }
        }
        conn.release();
      }
      // 回滚后：无孤儿 fetched fact。
      expect(await factCount()).toBe(0);
    });
  });

  describe("4. heartbeat 丢失回滚", () => {
    it("handler 执行中 heartbeat 失败 → AbortSignal → 不提交 fetched fact，operation 不 succeeded", async () => {
      const { operationId } = await createWikOp({ inputVersion: IV_FETCH });
      // 构造一个长跑 handler（超过 lease）且 heartbeat 会失败（claim 被接管）。
      const longRegistry = new Map(registry);
      longRegistry.set(WIK_OP, {
        taskIdentifier: WIK_OP,
        async run(_opId, signal) {
          // 等待 abort（heartbeat 丢失后 executor abort）。
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
              reject(new Error("aborted after lost claim"));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            // 若 3s 未 abort 则超时（不应发生）。
            const t = setTimeout(() => resolve(), 3000);
            signal?.addEventListener("abort", () => clearTimeout(t), { once: true });
          });
          // 不该到这里（abort 会 reject）。
          return { outcome: "succeeded", summary: "unreachable" };
        },
      });
      const execPromise = executeOperation(
        workerPool,
        longRegistry,
        operationId,
        "hb-job",
        undefined,
        {
          leaseMs: 250,
          leaseOwner: "hb-worker",
        },
      );
      // 稍后由另一 worker 在未来时钟重领（旧 heartbeat 会失败）。
      await new Promise((r) => setTimeout(r, 300));
      const claimedB = await claimOperation(workerPool, operationId, {
        leaseMs: 60_000,
        leaseOwner: "hb-taker",
        now: new Date(Date.now() + 2_000),
      });
      expect(claimedB.kind).toBe("claimed");
      const outcome = await execPromise;
      expect(outcome).toBe("stale_claim");
      // 旧 worker 未写 fetched fact。
      const facts = await factRows();
      expect(facts.filter((f) => f.status === "fetched")).toHaveLength(0);
    });
  });

  describe("5. 非成功结果原子性", () => {
    it("manual_action（page missing）不写 fetched fact，operation=manual_action", async () => {
      const { operationId } = await createWikOp({ inputVersion: IV_PAGE_MISSING });
      const outcome = await executeOperation(workerPool, registry, operationId, "ma-pm");
      expect(outcome).toBe("manual_action");
      const op = await opRow(operationId);
      expect(op.status).toBe("manual_action");
      expect(await factCount()).toBe(0);
    });

    it("malformed（permanent）不写 fetched fact，operation=failed", async () => {
      const { operationId } = await createWikOp({ inputVersion: IV_MALFORMED });
      const outcome = await executeOperation(workerPool, registry, operationId, "ma-mal");
      expect(outcome).toBe("failed");
      const op = await opRow(operationId);
      expect(op.status).toBe("failed");
      expect(await factCount()).toBe(0);
    });

    it("ambiguous 原子提交：ambiguous fact 与 manual_action 同事务", async () => {
      const { operationId } = await createWikOp({ inputVersion: IV_AMBIGUOUS });
      const outcome = await executeOperation(workerPool, registry, operationId, "ma-amb");
      expect(outcome).toBe("manual_action");
      const op = await opRow(operationId);
      expect(op.status).toBe("manual_action");
      // ambiguous fact 随 manual_action 一起提交（不是孤儿）。
      const facts = await factRows();
      expect(facts).toHaveLength(1);
      expect(facts[0]!.status).toBe("ambiguous");
      expect(facts[0]!.ambiguity_candidates).not.toBeNull();
    });

    it("retryable 不写 fetched fact，operation=retry_wait；后续成功只产生一条事实", async () => {
      const { operationId } = await createWikOp({ inputVersion: IV_RETRYABLE });
      await expect(executeOperation(workerPool, registry, operationId, "ma-retry")).rejects.toThrow(
        /临时失败/,
      );
      const op = await opRow(operationId);
      expect(op.status).toBe("retry_wait");
      expect(await factCount()).toBe(0);
    });
  });

  describe("6. 重复 job / replay 幂等", () => {
    it("同一 operation 重复投递 → 不重复副作用，同 identity 只一条事实", async () => {
      const { operationId } = await createWikOp({ inputVersion: IV_FETCH });
      const o1 = await executeOperation(workerPool, registry, operationId, "replay-1");
      expect(o1).toBe("succeeded");
      const o2 = await executeOperation(workerPool, registry, operationId, "replay-2");
      expect(o2).toBe("already_done");
      const facts = await factRows();
      expect(facts).toHaveLength(1);
      const attempts = await attemptRows(operationId);
      expect(attempts).toHaveLength(1);
    });
  });

  describe("7. 同 source_fact_identity 幂等", () => {
    it("同一 identity 二次写入 → ON CONFLICT 忽略，数据库最多一条 fact", async () => {
      const { writeDeferredFactsInTx } =
        await import("../../../apps/worker/src/operation-executor.js");
      const { contentHash, pageIdentity, revisionIdentity, sourceFactIdentity } =
        await import("@motro/domain");
      const { operationId, commitRowId } = await createWikOp({ inputVersion: IV_FETCH });
      const pageId = "p-idem";
      const revisionId = "r-1";
      const makeFact = () => ({
        sourceFactIdentity: sourceFactIdentity({
          pageId,
          revisionId,
          parserVersion: "fake-parser-1",
        }),
        pageIdentityHash: pageIdentity({ pageId, language: "en" }),
        revisionIdentityHash: revisionIdentity({ pageId, revisionId }),
        pageId,
        revisionId,
        revisionTimestamp: new Date(1_700_000_000_000),
        canonicalTitle: "run",
        normalizedSpelling: "run",
        language: "en",
        partOfSpeech: "noun",
        definitionExcerpt: "to move quickly",
        sourceUrl: "urn:fake:wiktionary:page",
        contentHash: contentHash({
          canonicalTitle: "run",
          normalizedSpelling: "run",
          language: "en",
          partOfSpeech: "noun",
          definitionExcerpt: "to move quickly",
          sourceUrl: "urn:fake:wiktionary:page",
        }),
        licenseName: "CC BY-SA 4.0",
        licenseVersion: "4.0",
        licenseUrl: "urn:fake:license:cc-by-sa-4.0",
        attribution: "Wiktionary contributors",
        parserVersion: "fake-parser-1",
        status: "fetched" as const,
        ambiguityNote: null,
        ambiguityCandidates: null,
        commitRowId,
        inputVersionUsed: IV_FETCH,
      });
      const conn = await workerPool.connect();
      try {
        await conn.query("BEGIN");
        const first = await writeDeferredFactsInTx(conn, [makeFact()]);
        expect(first.inserted).toBe(1);
        // 同 identity 第二次写 → replayed（不新增）。
        const second = await writeDeferredFactsInTx(conn, [makeFact()]);
        expect(second.replayed).toBe(1);
        expect(second.inserted).toBe(0);
        await conn.query("COMMIT");
      } finally {
        conn.release();
      }
      const facts = await factRows();
      expect(facts).toHaveLength(1); // 幂等：最多一条 fact
      void operationId;
    });
  });

  describe("8. 源码/网络守卫", () => {
    it("wiktionary 实现无外部 URL / key / 真实 provider；不查询 _private_*", () => {
      const dirs = [
        resolve(process.cwd(), "packages/domain/src/wiktionary"),
        resolve(process.cwd(), "apps/worker/src"),
      ];
      const banned = [
        /wiktionary\.org|www\.mediawiki|api\.deepseek|deepseek\.com|\/v1\/chat\/completions/i,
        /(sk-|api[_-]?key|secret|access[_-]?token)=[a-zA-Z0-9]{16,}/,
      ];
      const files: string[] = [];
      const collect = (d: string): void => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d)) {
          const p = join(d, e);
          if (statSync(p).isDirectory()) collect(p);
          else if (/\.ts$/.test(e) && !/\.spec|\.test|\.d\.ts$/.test(e)) files.push(p);
        }
      };
      for (const d of dirs) collect(d);
      for (const f of files) {
        const content = readFileSync(f, "utf8");
        for (const re of banned) expect(content, f).not.toMatch(re);
        expect(content, f).not.toMatch(/graphile_worker\._private/);
      }
    });
  });
});
