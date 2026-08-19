// 阶段 6 工单 05：Wiktionary source fact 内网零网络基础集成验收（真实 PostgreSQL）。
//
// 覆盖（每项都在一次性隔离库上进行，完成后销毁数据库，绝不动共享开发库）：
//   1. 空库 migration 0001–0031 + Graphile 就绪；wiktionary_source_facts 表存在；
//   2. fake success：operation → succeeded，写入一条 fetched 事实（append-only）；
//   3. same revision 重复执行：并发/重放只产生一条事实（identity 幂等 no-op）；
//   4. new revision：新增事实，旧 revision 保留；
//   5. UPDATE / DELETE 被 immutable trigger 拒绝；
//   6. license / attribution incomplete：operation → manual_action，不写错误事实；
//   7. malformed / oversized：operation → failed，rollback 不写事实；
//   8. page missing → manual_action；revision missing → manual_action；
//   9. ambiguous → manual_action；
//  10. WIKI permanent / retryable 分支路由到 failed / retry_wait；
//  11. 管理员 retry（manual_action → queued → 成功）后写事实，不重复；
//  12. 单个 operation 失败不影响另一个（batch/row independence）；
//  13. 真实 FK：删除被 source fact 引用的 commit row 被拒绝；
//  14. target_type 变体不落库；operation target 仍为真实 import_batch_commit_row。
//
// 本套件完全零网络：Fake Provider 不发 HTTP，不访问 DNS，不读 key。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { runMigrations } from "graphile-worker";
import { executeOperation } from "../../../apps/worker/src/operation-executor.js";
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

describe("wiktionary source fact foundation", () => {
  let pool: ReturnType<typeof createPool>;
  let workerPool: ReturnType<typeof createPool>;
  let registry: ReturnType<typeof buildWiktionaryFakeHandler>;
  let isolatedDbName: string | undefined;
  let tempImportRoot: string;
  let fixtureUserId: string;

  async function createWikOp(opts: {
    inputVersion: number;
    maxAttempts?: number;
    commitRowId?: string;
  }): Promise<{ operationId: string; commitRowId: string }> {
    const commitRowId =
      opts.commitRowId ?? (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
    const inputVersion = opts.inputVersion;
    await pool.query(
      `INSERT INTO application_operations
         (operation_type, operation_version, target_type, target_id, input_hash, input_version,
          status, task_identifier, queue_name, max_attempts, requested_by)
       VALUES ($1, 1, 'import_batch_commit_row', $2, $3, $4, 'queued', $1, $5, $6, $7)
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
        opts.maxAttempts ?? 5,
        fixtureUserId,
      ],
    );
    const op = await pool.query<{ id: string }>(
      "SELECT id FROM application_operations WHERE target_id = $1 AND input_version = $2 ORDER BY created_at DESC LIMIT 1",
      [commitRowId, inputVersion],
    );
    return { operationId: op.rows[0]!.id, commitRowId };
  }

  async function factCount(identity?: string): Promise<number> {
    if (identity) {
      const r = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM wiktionary_source_facts WHERE source_fact_identity = $1",
        [identity],
      );
      return Number(r.rows[0]?.n ?? 0);
    }
    const r = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM wiktionary_source_facts",
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async function totalRowCount(): Promise<number> {
    const r = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM wiktionary_source_facts",
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async function opStatus(id: string): Promise<string> {
    const r = await pool.query<{ status: string }>(
      "SELECT status FROM application_operations WHERE id = $1",
      [id],
    );
    return r.rows[0]!.status;
  }

  beforeAll(async () => {
    if (!dbAvailable) {
      throw new Error(
        "wiktionary-source-facts 需要运行中的 PostgreSQL。启动后重跑；本套件不会静默跳过。",
      );
    }
    isolatedDbName = `motro_wikifact_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const adminPool = createPool({ ...config, database: "postgres", max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await adminPool.end();
    }
    const isolatedConfig = { ...config, database: isolatedDbName };
    await migrate(isolatedConfig, MIGRATIONS_DIR);
    await runMigrations({ connectionString: pgConn(isolatedConfig), schema: "graphile_worker" });

    tempImportRoot = mkdtempSync(join(tmpdir(), "motro-wikifact-"));
    process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
    process.env.POSTGRES_DB = isolatedDbName;

    pool = createPool({ ...isolatedConfig, max: 2 });
    workerPool = createPool({ ...isolatedConfig, max: 2 });
    registry = buildWiktionaryFakeHandler(workerPool);
    const ps = new PasswordService();
    await pool.query(
      `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
       VALUES ($1, 'Wiki Fact User', 'admin', 'active', 'Asia/Shanghai', 10, $2, false)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
      ["wikifact-user", await ps.hashPassword("fixture-pass-123")],
    );
    fixtureUserId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
        "wikifact-user",
      ])
    ).rows[0]!.id;
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

  afterEach(async () => {
    // 严格重置：清空 source facts 与 operations（及级联 attempts），让每个测试在干净基线上运行。
    // 不触碰 import_batch_commit_rows（每个测试用唯一 commit row；TRUNCATE 只清理本测试生成的
    // 事实与操作行）。wiktionary_source_facts 在 application_operations 之前列出（自身无外键依赖）。
    await pool.query("TRUNCATE wiktionary_source_facts, application_operations CASCADE");
  });

  describe("1. migration 就绪", () => {
    it("0001–0032 已应用，wiktionary_source_facts 表存在，无需退回", async () => {
      const versions = await pool.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(versions.rows.map((r) => r.version)).toContain(31);
      expect(versions.rows.map((r) => r.version)).toContain(32);
      expect(versions.rows.map((r) => r.version)).toContain(33);
      const max = Math.max(...versions.rows.map((r) => r.version));
      expect(max).toBe(42);
      const tbl = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name = 'wiktionary_source_facts'`,
      );
      expect(Number(tbl.rows[0]?.n ?? 0)).toBe(1);
      // immutable trigger 存在且启用。
      const triggers = await pool.query<{ tgname: string; tgenabled: string }>(
        `SELECT tgname, tgenabled FROM pg_trigger
         WHERE tgrelid = 'wiktionary_source_facts'::regclass AND NOT tgisinternal
         ORDER BY tgname`,
      );
      expect(triggers.rows.map((r) => r.tgname)).toEqual([
        "wiktionary_source_facts_no_delete",
        "wiktionary_source_facts_no_update",
      ]);
      for (const t of triggers.rows) expect(t.tgenabled).toBe("O");
    });

    it("ambiguity_candidates / content_hash 列存在；CHECK / FK / UNIQUE 约束实际就位", async () => {
      // information_schema: 列存在
      const cols = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'wiktionary_source_facts'
         ORDER BY ordinal_position`,
      );
      const colNames = cols.rows.map((r) => r.column_name);
      expect(colNames).toContain("ambiguity_candidates");
      expect(colNames).toContain("ambiguity_note");
      expect(colNames).toContain("content_hash");
      expect(colNames).toContain("commit_row_id");
      expect(colNames).toContain("status");
      expect(colNames).toContain("input_version_used");
      // content_hash 可空（与 Drizzle nullable 一致）。
      expect(cols.rows.find((r) => r.column_name === "content_hash")!.is_nullable).toBe("YES");
      // ambiguity_candidates 可空（仅 ambiguous 状态携带，由 CHECK 保证）。
      expect(cols.rows.find((r) => r.column_name === "ambiguity_candidates")!.is_nullable).toBe(
        "YES",
      );

      // pg_constraint: CHECK 约束存在（按名称前缀或关键词查找）
      const constraints = await pool.query<{ conname: string; contype: string }>(
        `SELECT conname, contype::text AS contype FROM pg_constraint
         WHERE conrelid = 'wiktionary_source_facts'::regclass AND contype IN ('c','u','f')
         ORDER BY conname`,
      );
      const checkDefs = (
        await pool.query<{ conname: string; def: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid = 'wiktionary_source_facts'::regclass AND contype = 'c'`,
        )
      ).rows;
      const checkText = checkDefs.map((r) => r.def).join("\n");
      // content_hash 状态不变量；status；hex 格式；ambiguity_candidates 不变量。
      expect(checkText).toMatch(/status\s*=\s*'fetched'/i);
      expect(checkText).toMatch(/0-9a-f/i);
      expect(checkText).toMatch(/ambiguity_candidates/i);
      expect(checkText).toMatch(/status/i);
      // FK：commit_row_id 引用 import_batch_commit_rows。
      const fkNames = constraints.rows.filter((r) => r.contype === "f").map((r) => r.conname);
      expect(fkNames).toHaveLength(1);
      expect(fkNames[0]).toMatch(/commit_row/i);

      // UNIQUE index 存在。
      const uniqueIdx = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'wiktionary_source_facts' AND indexdef LIKE '%UNIQUE%'`,
      );
      expect(uniqueIdx.rows.map((r) => r.indexname)).toContainEqual(
        "wiktionary_source_facts_identity_unique",
      );
    });

    it("0031 与 0032 migration 内容哈希均与本地文件一致（无迁移文件漂移）", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const { createHash } = await import("node:crypto");
      for (const version of [31, 32]) {
        const fileName =
          version === 31
            ? "0031_wiktionary_source_facts.sql"
            : "0032_wiktionary_source_fact_integrity.sql";
        const filePath = resolve(process.cwd(), "db/migrations", fileName);
        const fileHash = createHash("sha256").update(readFileSync(filePath, "utf8")).digest("hex");
        const dbRow = await pool.query<{ content_hash: string }>(
          "SELECT content_hash FROM schema_migrations WHERE version = $1",
          [version],
        );
        expect(dbRow.rows[0]!.content_hash, `version ${version} hash should match file`).toBe(
          fileHash,
        );
      }
    });
  });

  describe("2. fake success 写入 fetched 事实", () => {
    it("成功：operation → succeeded，写入一条 fetched 事实", async () => {
      const { operationId } = await createWikOp({ inputVersion: 1 });
      const outcome = await executeOperation(workerPool, registry, operationId, "wk-1");
      expect(outcome).toBe("succeeded");
      expect(await opStatus(operationId)).toBe("succeeded");
      const facts = await pool.query<{
        status: string;
        content_hash: string | null;
        definition_excerpt: string;
        commit_row_id: string | null;
        input_version_used: number | null;
      }>(
        "SELECT status, content_hash, definition_excerpt, commit_row_id, input_version_used FROM wiktionary_source_facts",
      );
      expect(facts.rows).toHaveLength(1);
      expect(facts.rows[0]!.status).toBe("fetched");
      expect(facts.rows[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(facts.rows[0]!.input_version_used).toBe(1);
      // 事实绑定真实 commit row（不伪造 target）。
      expect(facts.rows[0]!.commit_row_id).toBeTruthy();
      // 不含 raw wikitext / provider payload / 例句 / 媒体。
      const raw = JSON.stringify(facts.rows[0]);
      expect(raw).not.toMatch(/raw|wikitext|payload|example|image|audio|pronunciation/i);
    });
  });

  describe("3. same revision 幂等", () => {
    it("并发两个 worker 执行同 identity → 恰好一条事实", async () => {
      const commitRowId = (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
      // 同一 commit row，但不同 input_version（IV_FETCH=1 与 IV_SAME_REVISION=2）：
      // 两个不同 input_hash 的【两个 operation】，fake provider 却产出同 pageId/revisionId
      // → 同 source_fact_identity → 并发只生成一条事实。
      const a = await createWikOp({ inputVersion: 1, commitRowId });
      const b = await createWikOp({ inputVersion: 2, commitRowId });
      const [oa, ob] = await Promise.all([
        executeOperation(workerPool, registry, a.operationId, "wk-c1"),
        executeOperation(workerPool, registry, b.operationId, "wk-c2"),
      ]);
      expect(oa).toBe("succeeded");
      expect(ob).toBe("succeeded");
      expect(await totalRowCount()).toBe(1);
    });

    it("同 fact identity 第二次重放 no-op，不新增第二条事实", async () => {
      const { operationId } = await createWikOp({ inputVersion: 1 });
      await executeOperation(workerPool, registry, operationId, "wk-dedup-1");
      const identity = (
        await pool.query<{ source_fact_identity: string }>(
          "SELECT source_fact_identity FROM wiktionary_source_facts LIMIT 1",
        )
      ).rows[0]!.source_fact_identity;
      expect(await factCount(identity)).toBe(1);
      // 同一 commit row 上第二个 operation（IV_SAME_REVISION=2 → 不同 input_hash），
      // fake provider 同 revision → 同 source_fact_identity → 重放 no-op。
      const commitRowId = (
        await pool.query<{ commit_row_id: string | null }>(
          "SELECT commit_row_id FROM wiktionary_source_facts LIMIT 1",
        )
      ).rows[0]!.commit_row_id!;
      const again = await createWikOp({ inputVersion: 2, commitRowId });
      await executeOperation(workerPool, registry, again.operationId, "wk-dedup-2");
      expect(await factCount(identity)).toBe(1);
      expect(await totalRowCount()).toBe(1);
    });
  });

  describe("4. new revision 新增事实，旧 revision 保留", () => {
    it("input_version 前进为新 revision → 新事实，旧事实仍在", async () => {
      const commitRowId = (await createCommitRow(pool, { userId: fixtureUserId })).commitRowId;
      const firstOp = await createWikOp({ inputVersion: 1, commitRowId });
      await executeOperation(workerPool, registry, firstOp.operationId, "wk-newrev-1");
      const identity1 = (
        await pool.query<{ source_fact_identity: string }>(
          "SELECT source_fact_identity FROM wiktionary_source_facts LIMIT 1",
        )
      ).rows[0]!.source_fact_identity;
      // 同一 target，但 revision 前进（fake provider IV_NEW_REVISION=3 → 新 source_fact_identity）。
      const secondOp = await createWikOp({ inputVersion: 3, commitRowId });
      await executeOperation(workerPool, registry, secondOp.operationId, "wk-newrev-2");
      expect(await totalRowCount()).toBe(2);
      const rows = await pool.query<{ source_fact_identity: string; revision_id: string }>(
        "SELECT source_fact_identity, revision_id FROM wiktionary_source_facts ORDER BY created_at",
      );
      expect(rows.rows.map((r) => r.source_fact_identity)).toContain(identity1);
      expect(rows.rows[0]!.revision_id).not.toBe(rows.rows[1]!.revision_id);
    });
  });

  describe("5. immutable: UPDATE / DELETE 被拒绝", () => {
    it("append-only：UPDATE 与 DELETE 都被触发拒绝", async () => {
      const { operationId } = await createWikOp({ inputVersion: 1 });
      await executeOperation(workerPool, registry, operationId, "wk-imm");
      const fact = (
        await pool.query<{ id: string }>("SELECT id FROM wiktionary_source_facts LIMIT 1")
      ).rows[0]!;
      let updRejected = false;
      try {
        await pool.query(
          "UPDATE wiktionary_source_facts SET definition_excerpt='x' WHERE id = $1",
          [fact.id],
        );
      } catch (err) {
        updRejected = true;
        expect(String((err as Error).message)).toMatch(/immutable/);
      }
      expect(updRejected).toBe(true);
      let delRejected = false;
      try {
        await pool.query("DELETE FROM wiktionary_source_facts WHERE id = $1", [fact.id]);
      } catch (err) {
        delRejected = true;
        expect(String((err as Error).message)).toMatch(/immutable/);
      }
      expect(delRejected).toBe(true);
      expect(await totalRowCount()).toBe(1);
    });
  });

  describe("6. license / attribution incomplete → manual_action", () => {
    it("license incomplete: operation → manual_action，不写错误事实，可被管理员解决后重试写成功事实", async () => {
      const { operationId, commitRowId } = await createWikOp({ inputVersion: 8 });
      const outcome = await executeOperation(workerPool, registry, operationId, "wk-lic");
      expect(outcome).toBe("manual_action");
      expect(await opStatus(operationId)).toBe("manual_action");
      expect(await totalRowCount()).toBe(0); // 未写错误事实（等人工解决）
      const op = await pool.query<{ last_error_code: string | null; retryable: boolean }>(
        "SELECT last_error_code, retryable FROM application_operations WHERE id = $1",
        [operationId],
      );
      expect(op.rows[0]!.last_error_code).toBe("WIKI_LICENSE_INCOMPLETE");
      expect(op.rows[0]!.retryable).toBe(false);
      void commitRowId;
    });

    it("attribution incomplete: operation → manual_action", async () => {
      const { operationId } = await createWikOp({ inputVersion: 9 });
      const outcome = await executeOperation(workerPool, registry, operationId, "wk-attr");
      expect(outcome).toBe("manual_action");
      expect(await opStatus(operationId)).toBe("manual_action");
      expect(await totalRowCount()).toBe(0);
    });

    it("license incomplete → 管理员解决后重试（input_version 改为成功）→ 成功写事实，不重复", async () => {
      const { operationId } = await createWikOp({ inputVersion: 8 });
      await executeOperation(workerPool, registry, operationId, "wk-lic2");
      expect(await opStatus(operationId)).toBe("manual_action");
      // 管理员修正 input_version=1（模拟许可已补齐），执行重试成功。
      await pool.query(
        "UPDATE application_operations SET status='queued', input_version=1 WHERE id = $1",
        [operationId],
      );
      const out = await executeOperation(workerPool, registry, operationId, "wk-lic3");
      expect(out).toBe("succeeded");
      expect(await totalRowCount()).toBe(1);
    });
  });

  describe("7. malformed / oversized rollback（不写事实）", () => {
    it("malformed → failed，不写事实（rollback）", async () => {
      const { operationId } = await createWikOp({ inputVersion: 6 });
      const outcome = await executeOperation(workerPool, registry, operationId, "wk-mal");
      expect(outcome).toBe("failed");
      expect(await opStatus(operationId)).toBe("failed");
      expect(await totalRowCount()).toBe(0);
    });

    it("oversized → failed，不写事实", async () => {
      const { operationId } = await createWikOp({ inputVersion: 7 });
      const outcome = await executeOperation(workerPool, registry, operationId, "wk-ovs");
      expect(outcome).toBe("failed");
      expect(await totalRowCount()).toBe(0);
    });
  });

  describe("8. page / revision missing → manual_action", () => {
    it("page missing → manual_action（WIKI_PAGE_NOT_FOUND），不写事实", async () => {
      const { operationId } = await createWikOp({ inputVersion: 4 });
      const outcome = await executeOperation(workerPool, registry, operationId, "wk-pm");
      expect(outcome).toBe("manual_action");
      expect(await opStatus(operationId)).toBe("manual_action");
      const op = await pool.query<{ last_error_code: string | null }>(
        "SELECT last_error_code FROM application_operations WHERE id = $1",
        [operationId],
      );
      expect(op.rows[0]!.last_error_code).toBe("WIKI_PAGE_NOT_FOUND");
    });

    it("revision missing → manual_action（WIKI_REVISION_NOT_FOUND）", async () => {
      const { operationId } = await createWikOp({ inputVersion: 5 });
      const outcome = await executeOperation(workerPool, registry, operationId, "wk-rm");
      expect(outcome).toBe("manual_action");
      expect(await opStatus(operationId)).toBe("manual_action");
    });
  });

  describe("9. ambiguous → manual_action（D5 歧义候选保留）", () => {
    it("ambiguous spelling → manual_action（WIKI_AMBIGUOUS）+ 写入一条 ambiguous 候选事实", async () => {
      const { operationId } = await createWikOp({ inputVersion: 10 });
      const outcome = await executeOperation(workerPool, registry, operationId, "wk-amb");
      expect(outcome).toBe("manual_action");
      expect(await opStatus(operationId)).toBe("manual_action");
      const op = await pool.query<{ last_error_code: string | null }>(
        "SELECT last_error_code FROM application_operations WHERE id = $1",
        [operationId],
      );
      expect(op.rows[0]!.last_error_code).toBe("WIKI_AMBIGUOUS");
      // D5：写一条 ambiguous 事实（含候选数组），供 Ticket 07 人工选择；绝不含 definition 内容。
      const facts = await pool.query<{
        status: string;
        content_hash: string | null;
        ambiguity_candidates: unknown;
      }>("SELECT status, content_hash, ambiguity_candidates FROM wiktionary_source_facts");
      expect(facts.rows).toHaveLength(1);
      expect(facts.rows[0]!.status).toBe("ambiguous");
      expect(facts.rows[0]!.content_hash).toBeNull();
      const candidates = facts.rows[0]!.ambiguity_candidates as Array<{ candidateIndex: number }>;
      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates.length).toBeGreaterThanOrEqual(1);
      // 候选只含结构化字段，不含 provider 原文/正文/例句/媒体。
      const raw = JSON.stringify(facts.rows[0]!);
      expect(raw).not.toMatch(/raw|wikitext|payload|example|image|audio/i);
    });

    it("ambiguous → 人工解决后重试（input_version 改为成功）→ 写 fetched 事实，不冲突不重复", async () => {
      const { operationId } = await createWikOp({ inputVersion: 10 });
      await executeOperation(workerPool, registry, operationId, "wk-amb2");
      expect(await opStatus(operationId)).toBe("manual_action");
      expect(await totalRowCount()).toBe(1); // ambiguous 事实
      // 人工确认候选后，把 input_version 改为成功（1），重试 → 写入 fetched 事实。
      await pool.query(
        "UPDATE application_operations SET status='queued', input_version=1 WHERE id = $1",
        [operationId],
      );
      const out = await executeOperation(workerPool, registry, operationId, "wk-amb3");
      expect(out).toBe("succeeded");
      // fetched 事实以【无歧义后缀的】identity 写入，与 ambiguous 事实（带后缀 identity）互不冲突。
      const statuses = await pool.query<{ status: string; content_hash: string | null }>(
        "SELECT status, content_hash FROM wiktionary_source_facts ORDER BY created_at",
      );
      expect(statuses.rows.map((r) => r.status).sort()).toEqual(["ambiguous", "fetched"].sort());
      expect(statuses.rows.find((r) => r.status === "fetched")!.content_hash).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });
  });

  describe("10. permanent / retryable 分支", () => {
    it("permanent (provider contract) → failed", async () => {
      const { operationId } = await createWikOp({ inputVersion: 11 });
      const outcome = await executeOperation(workerPool, registry, operationId, "wk-pc");
      expect(outcome).toBe("failed");
      expect(await opStatus(operationId)).toBe("failed");
    });

    it("retryable (transient) → retry_wait", async () => {
      const { operationId } = await createWikOp({ inputVersion: 12, maxAttempts: 5 });
      await expect(executeOperation(workerPool, registry, operationId, "wk-tr")).rejects.toThrow(
        /临时失败/,
      );
      expect(await opStatus(operationId)).toBe("retry_wait");
      expect(await totalRowCount()).toBe(0);
    });
  });

  describe("11. 单条失败不阻塞其它 operation", () => {
    it("一个 manual_action + 一个 success 各自独立推进", async () => {
      const bad = await createWikOp({ inputVersion: 8 });
      const good = await createWikOp({ inputVersion: 1 });
      const bOut = await executeOperation(workerPool, registry, bad.operationId, "wk-bad");
      const gOut = await executeOperation(workerPool, registry, good.operationId, "wk-good");
      expect(bOut).toBe("manual_action");
      expect(gOut).toBe("succeeded");
      expect(await opStatus(bad.operationId)).toBe("manual_action");
      expect(await opStatus(good.operationId)).toBe("succeeded");
      expect(await totalRowCount()).toBe(1); // 只有 good 写事实
    });
  });

  describe("12. 真实 FK / 负例", () => {
    it("删除被 source fact 引用的 commit row 被拒绝（RESTRICT）", async () => {
      const { operationId, commitRowId } = await createWikOp({ inputVersion: 1 });
      // 执行 operation → 写入一条 source fact（fact.commit_row_id → commit_row_id FK RESTRICT）。
      await executeOperation(workerPool, registry, operationId, "wk-fksrc");
      expect(await totalRowCount()).toBe(1);
      // 无论 source_fact RESTRICT 还是 application_operations RESTRICT，删除都应被拒。
      let rejected = false;
      try {
        await pool.query("DELETE FROM import_batch_commit_rows WHERE id = $1", [commitRowId]);
      } catch (err) {
        rejected = true;
        expect(
          /application_operations_target_id_fkey|wiktionary_source_facts_commit_row_id_fkey|commit facts are immutable|immutable/i.test(
            String((err as Error).message),
          ),
        ).toBe(true);
      }
      expect(rejected).toBe(true);
    });

    it("operation target 仍是真实 commit row：fluency 的 target_type=import_batch_commit_row", async () => {
      const { operationId } = await createWikOp({ inputVersion: 1 });
      const op = await pool.query<{ target_type: string }>(
        "SELECT target_type FROM application_operations WHERE id = $1",
        [operationId],
      );
      expect(op.rows[0]!.target_type).toBe("import_batch_commit_row");
    });
  });

  describe("13. 数据库级约束负例（真实 PostgreSQL CHECK / trigger / FK / rollback）", () => {
    const VALID_64_HEX = "a".repeat(64);
    // 每个 insertFact 调用分配唯一 64-hex identity，避免重复插入撞唯一约束。
    let factIdentityCounter = 0;

    // 构造一条最小合法 source fact。status/content_hash 由参数控制，其余 NOT NULL 列填合法值。
    async function insertFact(overrides: {
      status?: string;
      contentHash?: string | null;
      sourceFactIdentity?: string | null;
      pageIdentityHash?: string | null;
      revisionIdentityHash?: string | null;
      ambiguityCandidates?: string | null;
    }): Promise<{ id: string; rejected: string }> {
      // 每次调用生成唯一 64-hex identity（base-16，避免重复插入撞唯一约束）。
      const identity =
        overrides.sourceFactIdentity ??
        `a${factIdentityCounter.toString(16).padStart(63, "0")}`.slice(-64);
      factIdentityCounter += 1;
      const pageHash = overrides.pageIdentityHash ?? VALID_64_HEX;
      const revHash = overrides.revisionIdentityHash ?? VALID_64_HEX;
      const status = overrides.status ?? "pending";
      const contentHash = overrides.contentHash;
      const ambiguityCandidates = overrides.ambiguityCandidates ?? null;
      try {
        const r = await pool.query<{ id: string }>(
          `INSERT INTO wiktionary_source_facts
             (source_fact_identity, page_identity_hash, revision_identity_hash,
              page_id, revision_id, canonical_title, normalized_spelling, language,
              definition_excerpt, content_hash, source_url, parser_version, status,
              ambiguity_candidates)
           VALUES ($1, $2, $3, 'p1', 'r1', 'run', 'run', 'en', 'to move', $4, 'https://example.invalid/run', 'fake-parser-1', $5, $6)
           RETURNING id`,
          [identity, pageHash, revHash, contentHash, status, ambiguityCandidates],
        );
        return { id: r.rows[0]!.id, rejected: "" };
      } catch (err) {
        return { id: "", rejected: String((err as Error).message) };
      }
    }

    it("p1-1: fetched + 合法 64-hex content_hash → 落库成功", async () => {
      const r = await insertFact({ status: "fetched", contentHash: VALID_64_HEX });
      expect(r.rejected).toBe("");
      expect(r.id).toBeTruthy();
    });

    it("p1-1: fetched + NULL content_hash → 被 CHECK 拒绝", async () => {
      const r = await insertFact({ status: "fetched", contentHash: null });
      expect(r.rejected).not.toBe("");
      expect(r.rejected).toMatch(/wiktionary_source_facts|check/i);
    });

    it("p1-1: fetched + 非 hex content_hash → 被 CHECK 拒绝", async () => {
      for (const bad of [
        VALID_64_HEX.replace(/a/, "g"), // 非 hex 字符
        VALID_64_HEX.replace(/a/, "A"), // 大写（不允许，只允许小写）
        "z".repeat(64), // 完全非 hex
        VALID_64_HEX.slice(0, 63), // 长度 63
        VALID_64_HEX + "a", // 长度 65
        "", // 空字符串
      ]) {
        const r = await insertFact({ status: "fetched", contentHash: bad });
        expect(r.rejected, `应拒绝 content_hash=${bad.slice(0, 8)}…`).not.toBe("");
      }
    });

    it("p1-1: pending/error/ambiguous/superseded + NULL content_hash → 落库成功", async () => {
      for (const status of ["pending", "error", "ambiguous", "superseded"]) {
        // ambiguous 状态需携带候选数组（D5 CHECK），否则该状态本身的约束会拒绝插入，
        // 与本测试想验证的 content_hash NULL 语义无关。给 ambiguous 提供候选以隔离变量。
        const r = await insertFact({
          status,
          contentHash: null,
          ambiguityCandidates:
            status === "ambiguous" ? JSON.stringify([{ candidateIndex: 1 }]) : null,
        });
        expect(r.rejected, `应允许 ${status} + NULL hash`).toBe("");
      }
    });

    it("p1-1: pending/error/ambiguous/superseded + 携带 content_hash → 被 CHECK 拒绝", async () => {
      for (const status of ["pending", "error", "ambiguous", "superseded"]) {
        const r = await insertFact({
          status,
          contentHash: VALID_64_HEX,
          ambiguityCandidates:
            status === "ambiguous" ? JSON.stringify([{ candidateIndex: 1 }]) : null,
        });
        expect(r.rejected, `应拒绝 ${status} + hash`).not.toBe("");
      }
    });

    it("p1-2: source_fact_identity 非 64 位 hex → 被 CHECK 拒绝", async () => {
      const bads = [
        "short",
        "g".repeat(64), // 非 hex
        "A".repeat(64), // 大写
        VALID_64_HEX.slice(0, 63),
        "",
      ];
      for (const bad of bads) {
        const r = await insertFact({ sourceFactIdentity: bad });
        expect(r.rejected, `应拒绝 identity=${bad.slice(0, 8)}…`).not.toBe("");
      }
    });

    it("p1-2: page_identity_hash 非 64 位 hex → 被 CHECK 拒绝", async () => {
      const r = await insertFact({ pageIdentityHash: "g".repeat(64) });
      expect(r.rejected).not.toBe("");
    });

    it("p1-2: revision_identity_hash 非 64 位 hex → 被 CHECK 拒绝", async () => {
      const r = await insertFact({ revisionIdentityHash: "A".repeat(64) });
      expect(r.rejected).not.toBe("");
    });

    it("p1-2: 合法 64 位小写 hex 的 identity/hash 全部落库成功", async () => {
      const r = await insertFact({ status: "fetched", contentHash: VALID_64_HEX });
      expect(r.rejected).toBe("");
    });

    it("p1-4: UPDATE 任意 source fact 字段均被 immutable trigger 拒绝", async () => {
      const fact = await insertFact({ status: "fetched", contentHash: VALID_64_HEX });
      expect(fact.rejected).toBe("");
      const id = fact.id;
      let upd = false;
      try {
        await pool.query(
          "UPDATE wiktionary_source_facts SET canonical_title='other' WHERE id = $1",
          [id],
        );
      } catch (err) {
        upd = true;
        expect(String((err as Error).message)).toMatch(/immutable/);
      }
      expect(upd).toBe(true);
      // 尝试改写 content_hash 同样被拒。
      let updHash = false;
      try {
        await pool.query("UPDATE wiktionary_source_facts SET content_hash=$2 WHERE id = $1", [
          id,
          "b".repeat(64),
        ]);
      } catch (err) {
        updHash = true;
        expect(String((err as Error).message)).toMatch(/immutable/);
      }
      expect(updHash).toBe(true);
    });

    it("p1-4: DELETE 任意 source fact 均被 immutable trigger 拒绝", async () => {
      const fact = await insertFact({ status: "fetched", contentHash: VALID_64_HEX });
      expect(fact.rejected).toBe("");
      let del = false;
      try {
        await pool.query("DELETE FROM wiktionary_source_facts WHERE id = $1", [fact.id]);
      } catch (err) {
        del = true;
        expect(String((err as Error).message)).toMatch(/immutable/);
      }
      expect(del).toBe(true);
      // 行仍在。
      const n = await totalRowCount();
      expect(n).toBe(1);
    });

    it("p1-4: trigger 存在且 enabled=O；不使用 DISABLE TRIGGER / session_replication_role", async () => {
      const triggers = await pool.query<{ tgname: string; tgenabled: string }>(
        `SELECT tgname, tgenabled FROM pg_trigger
         WHERE tgrelid = 'wiktionary_source_facts'::regclass AND NOT tgisinternal
         ORDER BY tgname`,
      );
      expect(triggers.rows.map((r) => r.tgname)).toContain("wiktionary_source_facts_no_update");
      expect(triggers.rows.map((r) => r.tgname)).toContain("wiktionary_source_facts_no_delete");
      for (const t of triggers.rows) expect(t.tgenabled).toBe("O");
    });

    it("p1-5: 不存在的 commit_row_id → 被 FK 拒绝", async () => {
      const { randomUUID } = await import("node:crypto");
      const ghost = randomUUID();
      let rejected = false;
      try {
        await pool.query(
          `INSERT INTO wiktionary_source_facts
             (source_fact_identity, page_identity_hash, revision_identity_hash,
              page_id, revision_id, canonical_title, normalized_spelling, language,
              definition_excerpt, content_hash, source_url, parser_version, status, commit_row_id)
           VALUES ($1, $2, $3, 'p', 'r', 'run', 'run', 'en', 'x', $4, 'https://example.invalid', 'fake-parser-1', 'fetched', $5)`,
          [VALID_64_HEX, VALID_64_HEX, VALID_64_HEX, VALID_64_HEX, ghost],
        );
      } catch (err) {
        rejected = true;
        expect(String((err as Error).message)).toMatch(/foreign key|commit_row_id_fkey/i);
      }
      expect(rejected).toBe(true);
    });

    it("p1-5: source fact 删除不得绕过 immutable trigger（无 ON DELETE CASCADE 旁路表）", async () => {
      // 验证：本表没有任何引用它的 ON DELETE CASCADE FK（若未来有父表级联删除会绕过 append-only）。
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'wiktionary_source_facts'`,
      );
      // 至少存在 CHECK/UNIQUE/FK/PK 约束；但没有 CASCADE 删除语义的约束。
      const cascades = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'wiktionary_source_facts'
           AND c.contype IN ('f', 'o')
           AND c.confdeltype = 'c'`,
      );
      expect(Number(cascades.rows[0]?.n ?? 0)).toBe(0);
      expect(Number(r.rows[0]?.n ?? 0)).toBeGreaterThan(0);
    });

    it("p1-5 / append-only: 事务失败不留下半条 source fact（rollback 原子性）", async () => {
      const before = await totalRowCount();
      let failed = false;
      try {
        await pool.query("BEGIN");
        await pool.query(
          `INSERT INTO wiktionary_source_facts
             (source_fact_identity, page_identity_hash, revision_identity_hash,
              page_id, revision_id, canonical_title, normalized_spelling, language,
              definition_excerpt, content_hash, source_url, parser_version, status)
           VALUES ($1, $2, $3, 'p', 'r', 'run', 'run', 'en', 'x', $4, 'https://example.invalid', 'fake-parser-1', 'fetched')`,
          [VALID_64_HEX, VALID_64_HEX, VALID_64_HEX, VALID_64_HEX],
        );
        // 第二条非法行（fetched + 非 hex hash）导致整个事务失败。
        await pool.query(
          `INSERT INTO wiktionary_source_facts
             (source_fact_identity, page_identity_hash, revision_identity_hash,
              page_id, revision_id, canonical_title, normalized_spelling, language,
              definition_excerpt, content_hash, source_url, parser_version, status)
           VALUES ($1, $2, $3, 'p2', 'r2', 'run', 'run', 'en', 'x', $4, 'https://example.invalid', 'fake-parser-1', 'fetched')`,
          [VALID_64_HEX, VALID_64_HEX, VALID_64_HEX, "g".repeat(64)],
        );
        await pool.query("COMMIT");
      } catch (err) {
        failed = true;
        expect(String((err as Error).message)).toMatch(/check|constraint|invalid/i);
        try {
          await pool.query("ROLLBACK");
        } catch {
          /* already aborted */
        }
      }
      expect(failed).toBe(true);
      expect(await totalRowCount()).toBe(before); // 第一条随事务一起回滚
    });

    it("p1-3: fetched 事实具备 definition_excerpt / content_hash / source_url / revision identity", async () => {
      const fact = await insertFact({ status: "fetched", contentHash: VALID_64_HEX });
      expect(fact.rejected).toBe("");
      const row = await pool.query<{
        definition_excerpt: string | null;
        content_hash: string | null;
        source_url: string | null;
        revision_identity_hash: string | null;
        status: string;
      }>(
        "SELECT definition_excerpt, content_hash, source_url, revision_identity_hash, status FROM wiktionary_source_facts WHERE id = $1",
        [fact.id],
      );
      expect(row.rows[0]!.status).toBe("fetched");
      expect(row.rows[0]!.definition_excerpt).toBe("to move");
      expect(row.rows[0]!.content_hash).toBe(VALID_64_HEX);
      expect(row.rows[0]!.source_url).toBeTruthy();
      expect(row.rows[0]!.revision_identity_hash).toBe(VALID_64_HEX);
    });
  });

  describe("13b. ambiguity_candidates 状态不变量（真实 PostgreSQL CHECK）", () => {
    const VALID_64_HEX = "a".repeat(64);
    let ambiguousCounter = 0;

    // 写入一条指定 status / candidates / content_hash 的 source fact；返回是否被 CHECK 拒绝。
    async function insertAmbiguousFact(opts: {
      candidates?: string | null;
      contentHash?: string | null;
      status?: string;
    }): Promise<{ rejected: string }> {
      ambiguousCounter += 1;
      const identity = `b${ambiguousCounter.toString(16).padStart(63, "0")}`.slice(-64);
      const hex = VALID_64_HEX;
      const contentHash = opts.contentHash ?? null;
      const status = opts.status ?? "ambiguous";
      const candidates = opts.candidates ?? null;
      try {
        await pool.query(
          `INSERT INTO wiktionary_source_facts
             (source_fact_identity, page_identity_hash, revision_identity_hash,
              page_id, revision_id, canonical_title, normalized_spelling, language,
              definition_excerpt, content_hash, source_url, parser_version, status,
              ambiguity_candidates)
           VALUES ($1, $2, $3, 'p1', 'r1', 'run', 'run', 'en', 'to move', $4, 'https://example.invalid/run', 'fake-parser-1', $5, $6)`,
          [identity, hex, hex, contentHash, status, candidates],
        );
        return { rejected: "" };
      } catch (err) {
        return { rejected: String((err as Error).message) };
      }
    }

    it("ambiguous + 合法 ambiguity_candidates + NULL content_hash → 落库成功", async () => {
      const r = await insertAmbiguousFact({
        candidates: JSON.stringify([{ candidateIndex: 1 }, { candidateIndex: 2 }]),
      });
      expect(r.rejected).toBe("");
    });

    it("ambiguous + NULL ambiguity_candidates → 被 CHECK 拒绝", async () => {
      const r = await insertAmbiguousFact({ candidates: null, contentHash: null });
      expect(r.rejected).not.toBe("");
      expect(r.rejected).toMatch(/ambiguity_candidates|check/i);
    });

    it("ambiguous + content_hash 非 NULL → 被 content hash CHECK 拒绝", async () => {
      const r = await insertAmbiguousFact({
        candidates: JSON.stringify([{ candidateIndex: 1 }]),
        contentHash: VALID_64_HEX,
      });
      expect(r.rejected).not.toBe("");
      expect(r.rejected).toMatch(/wiktionary_source_facts|check/i);
    });

    it("pending/error/superseded + ambiguity_candidates → 被 CHECK 拒绝", async () => {
      for (const status of ["pending", "error", "superseded"]) {
        const r = await insertAmbiguousFact({
          status,
          candidates: JSON.stringify([{ candidateIndex: 1 }]),
        });
        expect(r.rejected, `应拒绝 ${status} + candidates`).not.toBe("");
      }
    });

    it("非 ambiguous 状态 + NULL candidates → 落库成功", async () => {
      const r = await insertAmbiguousFact({ status: "pending", candidates: null });
      expect(r.rejected).toBe("");
    });

    it("迁移后可直接 SELECT ambiguity_candidates 列（列存在，非旧表结构残留）", async () => {
      const r = await pool.query(
        `SELECT ambiguity_candidates, content_hash FROM wiktionary_source_facts WHERE id IS NULL`,
      );
      expect(r.fields.map((f) => f.name)).toContain("ambiguity_candidates");
      expect(r.fields.map((f) => f.name)).toContain("content_hash");
    });
  });

  describe("14. 共享数据库不被清空", () => {
    it("本套件使用一次性隔离数据库，不触碰共享开发库（建表前缀为 motro_wikifact_）", async () => {
      expect(isolatedDbName).toMatch(/^motro_wikifact_/);
    });
  });

  describe("15. 源码/网络守卫", () => {
    it("wiktionary 实现不引用外部 URL / key / DNS / 真实 provider", () => {
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
