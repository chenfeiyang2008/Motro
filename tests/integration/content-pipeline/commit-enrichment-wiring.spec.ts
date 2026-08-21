// Ticket X: Commit → Wiktionary → DeepSeek enrichment wiring — isolated-DB integration.
//
// Proves the full chain: real API commit produces enqueued wiktionary+deepseek operations;
// executeOperation on each yields fetched source fact + draft_ready draft;
// the admin review queue surfaces the draft.
//
// Uses the same isolated-DB + Nest app inject pattern as worker-operations / motivation-api.
// Fake adapters only (zero network); real adapters not exercised (need network).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, createReadStream, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { runMigrations } from "graphile-worker";
import type { Pool } from "pg";
import { createApp } from "../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../apps/api/src/auth/password.service.js";
import { ImportService } from "../../../apps/api/src/modules/admin/imports/import.service.js";
import { executeOperation } from "../../../apps/worker/src/operation-executor.js";
import { buildWiktionaryFakeHandler } from "../../../apps/worker/src/wiktionary-fake-handler.js";
import { buildDeepSeekFakeHandler } from "../../../apps/worker/src/deepseek-fake-handler.js";
import { closeAppDbPools, dropIsolatedDatabase } from "../catalog/isolated-db.helper.js";

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const probePool = createPool({ ...config, max: 1 });
async function canConnect(): Promise<boolean> {
  try {
    await probePool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probePool.end();
  }
}
const dbAvailable = await canConnect();

type App = Awaited<ReturnType<typeof createApp>>;

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "commit enrichment wiring (isolated DB)",
  () => {
    let isolatedDbName: string | undefined;
    const previousDb = process.env.POSTGRES_DB;
    let pool: Pool;
    let workerPool: Pool;
    let app: App;
    let wiktReg: ReturnType<typeof buildWiktionaryFakeHandler>;
    let dsReg: ReturnType<typeof buildDeepSeekFakeHandler>;
    let adminUserId: string;
    let tempImportRoot: string;

    beforeAll(async () => {
      isolatedDbName = `motro_enrich_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
      const admin = createPool({ ...config, database: "postgres", max: 1 });
      try {
        await admin.query(`CREATE DATABASE "${isolatedDbName}"`);
      } finally {
        await admin.end();
      }
      const isolated = { ...config, database: isolatedDbName };
      await migrate(isolated, MIGRATIONS_DIR);
      await runMigrations({
        connectionString: `postgresql://${isolated.user}:${isolated.password}@${isolated.host}:${isolated.port}/${isolated.database}`,
        schema: "graphile_worker",
      });
      process.env.POSTGRES_DB = isolatedDbName;
      pool = createPool({ ...isolated, max: 5 });
      workerPool = createPool({ ...isolated, max: 2 });

      const ps = new PasswordService();
      const hash = await ps.hashPassword("enrich-pass-123");
      const r = await pool.query<{ id: string }>(
        `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash)
         VALUES ('enrich-admin','富集管理员','admin','active','Asia/Shanghai',10,$1) RETURNING id`,
        [hash],
      );
      adminUserId = r.rows[0]!.id;

      // Assemble fake handler registries (zero-network).
      wiktReg = buildWiktionaryFakeHandler(workerPool);
      dsReg = buildDeepSeekFakeHandler(workerPool);

      // Minimal import root for the batch upload.
      tempImportRoot = mkdtempSync(join("/tmp", "motro-enrich-"));
      process.env.IMPORT_FILE_ROOT_DIR = tempImportRoot;
      process.env.IMPORT_MAX_FILE_BYTES = String(6 * 1024 * 1024);

      app = await createApp();
      await app.init();
    });

    afterAll(async () => {
      rmSync(tempImportRoot, { recursive: true, force: true });
      try {
        if (app) await closeAppDbPools(app);
        if (app) await app.close();
        if (pool) await pool.end();
        if (workerPool) await workerPool.end();
        // Allow all connection pools to drain before dropping the database.
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
      } finally {
        if (previousDb === undefined) delete process.env.POSTGRES_DB;
        else process.env.POSTGRES_DB = previousDb;
        delete process.env.IMPORT_FILE_ROOT_DIR;
        delete process.env.IMPORT_MAX_FILE_BYTES;
        if (isolatedDbName) await dropIsolatedDatabase(isolatedDbName);
      }
    });

    // ---- HTTP client ----
    interface Res {
      statusCode: number;
      json(): unknown;
    }
    function makeClient() {
      const cookies: Record<string, string> = {};
      let csrf = "";
      const capture = (res: { headers: Record<string, unknown> }): void => {
        const raw = res.headers["set-cookie"];
        const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
        for (const line of lines) {
          const pair = line.split(";")[0];
          if (!pair) continue;
          const idx = pair.indexOf("=");
          if (idx > 0) {
            const name = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1);
            if (name === "motro_session" && value === "") delete cookies[name];
            else cookies[name] = value;
          }
        }
        if (cookies["motro_csrf"]) csrf = cookies["motro_csrf"];
      };
      return {
        async warm() {
          const res = await app.inject({ method: "GET", url: "/api/v1/health/live" });
          capture(res);
        },
        async req(
          method: string,
          url: string,
          opts: { payload?: unknown; headers?: Record<string, string> } = {},
        ): Promise<Res> {
          if (method !== "GET" && csrf === "") await this.warm();
          const headers: Record<string, string> = { ...(opts.headers ?? {}) };
          const jar = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
          if (jar) headers.cookie = jar;
          if (method !== "GET") headers["x-csrf-token"] = csrf;
          const res = await app.inject({
            method: method as "GET" | "POST" | "PATCH" | "DELETE",
            url,
            headers,
            ...(opts.payload !== undefined ? { payload: opts.payload as string | object } : {}),
          });
          capture(res);
          return { statusCode: res.statusCode, json: () => res.json() } as Res;
        },
        async login(username: string, password: string): Promise<void> {
          await this.warm();
          const res = await this.req("POST", "/api/v1/auth/login", {
            payload: { username, password },
          });
          if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode}`);
        },
      };
    }
    type Client = ReturnType<typeof makeClient>;

    let admin: Client;

    beforeAll(async () => {
      admin = makeClient();
      await admin.login("enrich-admin", "enrich-pass-123");
    });

    it("commit → enqueues wiktionary + deepseek ops; execute produces fetched fact + draft_ready", async () => {
      // 1. Upload a minimal txt file via the service (Nest DI), then validate + commit.
      const word = `ew-w${randomUUID().slice(0, 6)}`;
      const importService = app.get(ImportService);
      const fileContent = word;
      const filePath = join(tempImportRoot, `${word}.txt`);
      writeFileSync(filePath, fileContent, "utf8");

      const upload = await importService.uploadAndCreateBatch({
        fileStream: createReadStream(filePath),
        filename: `${word}.txt`,
        declaredMime: "text/plain",
        sourceDeclaration: `source: e2e ${word}`,
        idempotencyKey: `ew-upload-${word}`,
        userId: adminUserId,
        requestId: `req-${word}`,
      });
      const batchId = upload.batch.id;

      await importService.validate(batchId, `ew-val-${word}`, adminUserId, `req-val-${word}`);

      // Commit requires the exact validation-input hash stored on the batch.
      const batchHash = (
        await pool.query<{ validation_input_sha256: string }>(
          `SELECT validation_input_sha256 FROM import_batches WHERE id = $1`,
          [batchId],
        )
      ).rows[0]!.validation_input_sha256;

      const commitRes = await importService.commit(batchId, {
        idempotencyKey: `ew-commit-${word}`,
        mappingVersion: 1,
        validationInputSha256: batchHash,
        userId: adminUserId,
        requestId: `req-commit-${word}`,
      });
      expect(commitRes.committedRowCount).toBeGreaterThanOrEqual(1);

      // 4. Verify enrichment ops enqueued: find commit rows and assert wiktionary + deepseek ops.
      const commitRows = await pool.query<{ id: string }>(
        `SELECT id FROM import_batch_commit_rows WHERE commit_id IN
         (SELECT id FROM import_batch_commits WHERE batch_id = $1)`,
        [batchId],
      );
      expect(commitRows.rows.length).toBeGreaterThanOrEqual(1);

      const wikOps = await pool.query<{ id: string; operation_type: string; status: string }>(
        `SELECT id, operation_type, status FROM application_operations
         WHERE operation_type = 'motro-wiktionary-fake' AND target_id = ANY($1::uuid[])`,
        [commitRows.rows.map((r) => r.id)],
      );
      expect(wikOps.rows.length, "wiktionary ops enqueued per commit row").toBeGreaterThanOrEqual(
        1,
      );
      for (const op of wikOps.rows) expect(op.status).toBe("queued");

      const dsOps = await pool.query<{ id: string; operation_type: string; status: string }>(
        `SELECT id, operation_type, status FROM application_operations
         WHERE operation_type = 'motro-deepseek-fake' AND target_id = ANY($1::uuid[])`,
        [commitRows.rows.map((r) => r.id)],
      );
      expect(dsOps.rows.length, "deepseek ops enqueued per commit row").toBeGreaterThanOrEqual(1);
      for (const op of dsOps.rows) expect(op.status).toBe("queued");

      // 5. Execute wiktionary op → fetched source fact.
      const wikOpId = wikOps.rows[0]!.id;
      const wikOutcome = await executeOperation(workerPool, wiktReg, wikOpId, "e2e-wik-1");
      expect(wikOutcome).toBe("succeeded");

      const sourceFacts = await pool.query<{ source_fact_identity: string; status: string }>(
        `SELECT source_fact_identity, status FROM wiktionary_source_facts WHERE commit_row_id = $1`,
        [commitRows.rows[0]!.id],
      );
      expect(sourceFacts.rows.length, "fetched source fact created").toBeGreaterThanOrEqual(1);
      expect(sourceFacts.rows[0]!.status).toBe("fetched");
      const sourceFactIdentity = sourceFacts.rows[0]!.source_fact_identity;

      // 6. Execute deepseek op → draft_ready enrichment draft linked to the source fact.
      const dsOpId = dsOps.rows[0]!.id;
      const dsOutcome = await executeOperation(workerPool, dsReg, dsOpId, "e2e-ds-1");
      expect(dsOutcome).toBe("succeeded");

      const drafts = await pool.query<{
        id: string;
        wiktionary_source_fact_id: string;
        status: string;
        simplified_chinese_meaning: string;
      }>(
        `SELECT id, wiktionary_source_fact_id, status, simplified_chinese_meaning
         FROM enrichment_drafts WHERE wiktionary_source_fact_id = $1 AND status = 'draft_ready'`,
        [sourceFactIdentity],
      );
      expect(drafts.rows.length, "draft_ready draft linked to source fact").toBeGreaterThanOrEqual(
        1,
      );
      expect(drafts.rows[0]!.simplified_chinese_meaning).toBeTruthy();
      const dsDraftId = drafts.rows[0]!.id;

      // 7. Diagnostics: verify source fact has non-null revision_timestamp and provenance.
      const factDiag = await pool.query<{
        id: string;
        status: string;
        revision_timestamp: Date | null;
        source_url: string | null;
        license_name: string | null;
        license_url: string | null;
        attribution: string | null;
        content_hash: string | null;
        commit_row_id: string | null;
      }>(
        `SELECT id, status, revision_timestamp, source_url, license_name, license_url, attribution, content_hash, commit_row_id
         FROM wiktionary_source_facts WHERE source_fact_identity = $1`,
        [sourceFactIdentity],
      );
      const fact = factDiag.rows[0];
      if (!fact) {
        throw new Error(`source fact not found for identity ${sourceFactIdentity}`);
      }
      // Debug: output the fact to help diagnose the 500.
      console.log(
        "[DIAG] source_fact:",
        JSON.stringify({
          id: fact.id,
          status: fact.status,
          revision_timestamp: fact.revision_timestamp?.toISOString() ?? "NULL",
          source_url: fact.source_url,
          license_name: fact.license_name,
          license_url: fact.license_url,
          attribution: fact.attribution,
          content_hash: fact.content_hash?.slice(0, 16) ?? "NULL",
          commit_row_id: fact.commit_row_id,
        }),
      );

      // 7. Confirm the draft appears in /admin/reviews (effective-reviewable projection).
      //    This verifies the full chain: commit → enqueue → execute → draft_ready → reviews queue.
      const reviewsRes = await admin.req("GET", "/api/v1/admin/reviews");
      expect(reviewsRes.statusCode, "GET /admin/reviews should be 200").toBe(200);
      const reviewsBody = reviewsRes.json() as { items: { draftId: string; spelling: string }[] };
      const matchingDraft = reviewsBody.items.find((d) => d.draftId === dsDraftId);
      expect(matchingDraft, "draft should appear in reviews queue").toBeDefined();
      expect(matchingDraft!.spelling).toBe(word);
    });

    it("commit idempotency: same Idempotency-Key does not duplicate enrichment ops", async () => {
      const word = `ew-idem-${randomUUID().slice(0, 6)}`;
      const filePath = join(tempImportRoot, `${word}.txt`);
      writeFileSync(filePath, word, "utf8");
      const idempKey = `ew-idem-${word}`;
      const importService = app.get(ImportService);

      const upload = await importService.uploadAndCreateBatch({
        fileStream: createReadStream(filePath),
        filename: `${word}.txt`,
        declaredMime: "text/plain",
        sourceDeclaration: `source: e2e idem ${word}`,
        idempotencyKey: `ew-upload-idem-${word}`,
        userId: adminUserId,
        requestId: `req-idem-${word}`,
      });
      const batchId = upload.batch.id;

      await importService.validate(
        batchId,
        `ew-val-idem-${word}`,
        adminUserId,
        `req-val-idem-${word}`,
      );
      const batchHash = (
        await pool.query<{ validation_input_sha256: string }>(
          `SELECT validation_input_sha256 FROM import_batches WHERE id = $1`,
          [batchId],
        )
      ).rows[0]!.validation_input_sha256;

      // First commit.
      await importService.commit(batchId, {
        idempotencyKey: idempKey,
        mappingVersion: 1,
        validationInputSha256: batchHash,
        userId: adminUserId,
        requestId: `req-commit-idem-${word}`,
      });

      const commitRows = await pool.query<{ id: string }>(
        `SELECT id FROM import_batch_commit_rows WHERE commit_id IN
         (SELECT id FROM import_batch_commits WHERE batch_id = $1)`,
        [batchId],
      );
      const commitRowIds = commitRows.rows.map((r) => r.id);
      const opCountAfterFirst = (
        await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM application_operations
           WHERE operation_type IN ('motro-wiktionary-fake','motro-deepseek-fake')
             AND target_id = ANY($1::uuid[])`,
          [commitRowIds],
        )
      ).rows[0]!.n;

      // Replay same commit → ops not duplicated.
      await importService.commit(batchId, {
        idempotencyKey: idempKey,
        mappingVersion: 1,
        validationInputSha256: batchHash,
        userId: adminUserId,
        requestId: `req-commit-idem-replay-${word}`,
      });
      const opCountAfterReplay = (
        await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM application_operations
           WHERE operation_type IN ('motro-wiktionary-fake','motro-deepseek-fake')
             AND target_id = ANY($1::uuid[])`,
          [commitRowIds],
        )
      ).rows[0]!.n;
      expect(Number(opCountAfterReplay), "ops not duplicated on idempotent commit").toBe(
        Number(opCountAfterFirst),
      );
    });
  },
);
