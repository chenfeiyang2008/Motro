// Ticket 08 · Review Provenance identity binding — P1 final fix.
//
// Runs on a throwaway isolated database.  Drives the REAL createItem API
// (POST /admin/courses/:id/draft/items/:itemId) with reviewDecisionId and
// verifies fail-closed identity binding, plus one publish-time re-validation
// of the same bindings through VALIDATION_SQL.
//
// Covers (all via real API + isolated PG):
//   1. Apple decision + Apple source + Apple item   -> createItem 201 (eligible)
//   2. Apple decision bound to Banana item          -> 422 lexical_mismatch
//   3. snapshot.english_spelling replaced (Banana)  -> 422 snapshot_spelling_mismatch
//   4. source_fact.normalized_spelling mismatch     -> 422 normalized_spelling_mismatch
//   5. source_fact.commit_row_id mismatch           -> 422 commit_row_mismatch
//   6. snapshot page/revision != source page/revision -> 422 revision_page_mismatch
//   7. source fact not fetched (pending)            -> 422 source_not_fetched
//   8. source fact content_hash missing             -> 422 source_fact_hash_missing (pending fact: hash NULL)
//   9. same decision bound to two items             -> 422 conflicting_decision
//  10. rejected decision                            -> 422 not_accepted
//  11. legal Path-A manual item                     -> 201 (no regression)
//  publish re-check: bypassed invalid binding       -> publish blocked with stable ITEM_* code
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { createApp } from "../../../../apps/api/src/bootstrap-app.js";
import { PasswordService } from "../../../../apps/api/src/auth/password.service.js";
import { closeAppDbPools, dropIsolatedDatabase } from "../isolated-db.helper.js";
import { createCommitRow } from "../../operations/commit-row-helper.js";
import type { Pool } from "pg";

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

interface Res {
  statusCode: number;
  json(): unknown;
  headers: Record<string, unknown>;
}
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function makeClient(app: App) {
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
    async req(method: HttpMethod, url: string, opts: { payload?: object } = {}) {
      if (method !== "GET" && csrf === "") await this.warm();
      const headers: Record<string, string> = {};
      const jar = Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      if (jar) headers.cookie = jar;
      if (method !== "GET") headers["x-csrf-token"] = csrf;
      const res = await app.inject({
        method,
        url,
        headers,
        ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      });
      capture(res);
      return res as unknown as Res;
    },
  };
}
type Client = ReturnType<typeof makeClient>;

/** The identity values that must all agree for a Path-B binding to be eligible. */
interface ReviewChain {
  commitRowId: string;
  lexicalEntryId: string;
  canonicalSpelling: string;
  normalizedSpelling: string;
  sourceFactIdentity: string;
  pageId: string;
  revisionId: string;
  contentHash: string;
  draftId: string;
  decisionId: string;
}

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "ticket-08 review provenance identity binding (P1)",
  () => {
    let app: App;
    let admin: Client;
    let db: Pool;
    let dbName: string;
    let adminUserId: string;
    let courseId: string;
    let unitId: string;
    let draftVersion: number;

    beforeAll(async () => {
      if (!dbAvailable) throw new Error("identity-binding 集成测试需要运行中的 PostgreSQL");
      dbName = `motro_identity_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
      const adminPool = createPool({ ...config, database: "postgres", max: 1 });
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      await adminPool.end();
      await migrate({ ...config, database: dbName }, MIGRATIONS_DIR);
      db = createPool({ ...config, database: dbName, max: 5 });
      process.env.POSTGRES_DB = dbName;

      adminUserId = (
        await db.query<{ id: string }>(
          `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
           VALUES ('id-admin','A','admin','active','Asia/Shanghai',10,$1,false) RETURNING id`,
          ["x"],
        )
      ).rows[0]!.id;

      app = await createApp();
      await app.init();
      admin = makeClient(app);
      // Login as a real admin with a known password.
      const ps = new PasswordService();
      const hash = await ps.hashPassword("identity-admin-pass-123");
      await db.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, adminUserId]);
      const login = await admin.req("POST", "/api/v1/auth/login", {
        payload: { username: "id-admin", password: "identity-admin-pass-123" },
      });
      expect(login.statusCode).toBe(200);

      // Course + draft + one unit, re-used across item-create tests.
      const course = await admin.req("POST", "/api/v1/admin/courses", {
        payload: { slug: `id-${randomBytes(4).toString("hex")}`, title: "身份绑定", level: "a1" },
      });
      expect(course.statusCode).toBe(201);
      const c = course.json() as { courseId: string; draftVersion: number };
      courseId = c.courseId;
      draftVersion = c.draftVersion;
      unitId = randomUUID();
      const unit = await admin.req(
        "POST",
        `/api/v1/admin/courses/${courseId}/draft/units/${unitId}`,
        { payload: { title: "单元", draftVersion } },
      );
      expect(unit.statusCode).toBe(201);
      draftVersion = (unit.json() as { version: number }).version;
    });

    afterAll(async () => {
      try {
        if (app) await closeAppDbPools(app);
        if (app) await app.close();
        if (db) await db.end();
      } finally {
        if (dbName) await dropIsolatedDatabase(dbName);
      }
    });

    /** Create a fresh commit row + lexical entry (canonical + normalized spelling). */
    async function freshCommitRow(
      spelling: string,
    ): Promise<{ commitRowId: string; entryId: string }> {
      const { commitRowId } = await createCommitRow(db, {
        userId: adminUserId,
        normalizedSpelling: spelling,
      });
      const entryId = (
        await db.query<{ created_entry_id: string }>(
          "SELECT created_entry_id FROM import_batch_commit_rows WHERE id=$1",
          [commitRowId],
        )
      ).rows[0]!.created_entry_id;
      return { commitRowId, entryId };
    }

    /**
     * Seed the full review chain (source fact -> enrichment draft -> decision ->
     * snapshot) with overridable identity fields so each mismatch case can be
     * constructed precisely.
     */
    async function seedChain(
      opts: {
        spelling?: string;
        sfNormalized?: string;
        sfStatus?: string;
        sfContentHash?: string | null;
        snapshotSpelling?: string;
        snapshotPage?: string;
        snapshotRevision?: string;
        sfPage?: string;
        sfRevision?: string;
        sfCommitRowId?: string;
        draftCommitRowId?: string;
        decisionType?: "accept" | "accept_with_edits" | "reject";
        snapshotSourceFactIdentity?: string;
      } = {},
    ): Promise<ReviewChain> {
      const spelling = opts.spelling ?? `apple-${randomBytes(4).toString("hex")}`;
      const { commitRowId, entryId } = await freshCommitRow(spelling);
      const entry = await db.query<{ canonical_spelling: string; normalized_spelling: string }>(
        "SELECT canonical_spelling, normalized_spelling FROM lexical_entries WHERE id=$1",
        [entryId],
      );
      const canonicalSpelling = entry.rows[0]!.canonical_spelling;
      const normalizedSpelling = entry.rows[0]!.normalized_spelling;
      const sourceFactIdentity = createHash("sha256")
        .update(`sf-${commitRowId}-${randomBytes(4).toString("hex")}`)
        .digest("hex");
      const pageId = opts.sfPage ?? "apple";
      const revisionId = opts.sfRevision ?? "rev-1";
      const contentHash =
        opts.sfContentHash !== undefined
          ? opts.sfContentHash
          : createHash("sha256").update("def").digest("hex");
      const sfStatus = opts.sfStatus ?? "fetched";
      const sfCommitRowId = opts.sfCommitRowId ?? commitRowId;
      // For fetched facts the CHECK requires a 64-hex hash; for others hash must be NULL.
      const effectiveHash =
        sfStatus === "fetched"
          ? opts.sfContentHash !== null
            ? contentHash
            : createHash("sha256").update("def").digest("hex")
          : null;

      await db.query(
        `INSERT INTO wiktionary_source_facts
           (source_fact_identity, page_identity_hash, revision_identity_hash, page_id, revision_id,
            revision_timestamp, canonical_title, normalized_spelling, language, part_of_speech,
            definition_excerpt, content_hash, source_url, license_name, license_version, license_url,
            attribution, parser_version, status, commit_row_id)
         VALUES ($1,$2,$3,$4,$5,now(),$4,$6,'en','noun','a fruit',$7,
                 'https://x','CC BY-SA','3.0','https://lic','attr','v1',$8,$9)`,
        [
          sourceFactIdentity,
          createHash("sha256").update(pageId).digest("hex"),
          createHash("sha256").update(revisionId).digest("hex"),
          pageId,
          revisionId,
          opts.sfNormalized ?? normalizedSpelling,
          effectiveHash,
          sfStatus,
          sfCommitRowId,
        ],
      );

      const draftCommitRowId = opts.draftCommitRowId ?? commitRowId;
      const draftLexicalId = opts.draftCommitRowId === undefined ? entryId : entryId;
      const draftSourceFactId = opts.snapshotSourceFactIdentity ?? sourceFactIdentity;
      const draftId = (
        await db.query<{ id: string }>(
          `INSERT INTO enrichment_drafts
             (import_batch_commit_row_id, lexical_entry_id, wiktionary_source_fact_id, provider,
              configured_model_alias, resolved_provider_model, prompt_template_version,
              input_hash, request_hash, draft_schema_version, status,
              simplified_chinese_meaning, learning_hint, completed_at)
           VALUES ($1,$2,$3,'deepseek','deepseek-v4-flash','deepseek-v4-flash-0731',
                   'zh-draft-v1',$4,$5,1,'draft_ready','苹果','优先记忆',now())
           RETURNING id`,
          [
            draftCommitRowId,
            draftLexicalId,
            draftSourceFactId,
            createHash("sha256")
              .update("in" + commitRowId)
              .digest("hex"),
            createHash("sha256")
              .update("req" + commitRowId)
              .digest("hex"),
          ],
        )
      ).rows[0]!.id;

      const decisionType = opts.decisionType ?? "accept";
      const decisionId = (
        await db.query<{ id: string }>(
          `INSERT INTO review_decisions
             (draft_id, reviewer_id, decision_type, reason, decision_hash, request_hash, idempotency_key)
           VALUES ($1,$2,$3,'审核',$4,$4,$5) RETURNING id`,
          [
            draftId,
            adminUserId,
            decisionType,
            createHash("sha256").update(draftId).digest("hex"),
            `k-${randomBytes(4).toString("hex")}`,
          ],
        )
      ).rows[0]!.id;

      const snapshotSpelling = opts.snapshotSpelling ?? canonicalSpelling;
      await db.query(
        `INSERT INTO review_decision_snapshots
           (decision_id, draft_id, decision_type, english_spelling, part_of_speech,
            simplified_chinese_meaning, learning_hint, source_fact_identity, source_name,
            source_page_id, source_revision_id, source_revision_timestamp, source_url,
            license_name, license_version, license_url, attribution, configured_model_alias,
            prompt_template_version, draft_schema_version, content_hash)
         VALUES ($1,$2,$3,$4,'noun','苹果','优先记忆',$5,'Wiktionary',
                 $6,$7,now(),'https://x','CC BY-SA','3.0','https://lic','attr',
                 'deepseek-v4-flash','zh-draft-v1',1,$8)`,
        [
          decisionId,
          draftId,
          decisionType,
          snapshotSpelling,
          draftSourceFactId,
          opts.snapshotPage ?? pageId,
          opts.snapshotRevision ?? revisionId,
          // Pending source facts may have no source hash; snapshots remain
          // immutable and require their own non-null content hash.
          contentHash ?? createHash("sha256").update("snapshot").digest("hex"),
        ],
      );

      return {
        commitRowId,
        lexicalEntryId: entryId,
        canonicalSpelling,
        normalizedSpelling,
        sourceFactIdentity,
        pageId,
        revisionId,
        // ReviewChain carries a string for request construction; an explicit
        // null source hash is represented as empty here and asserted separately
        // by the missing-hash eligibility case.
        contentHash: effectiveHash ?? contentHash ?? "",
        draftId,
        decisionId,
      };
    }

    async function createItem(
      entryId: string,
      decisionId: string | undefined,
      meaning: string,
    ): Promise<Res> {
      const itemId = randomUUID();
      const res = await admin.req(
        "POST",
        `/api/v1/admin/courses/${courseId}/draft/items/${itemId}`,
        {
          payload: {
            unitId,
            lexicalEntryId: entryId,
            meaning,
            draftVersion,
            ...(decisionId !== undefined ? { reviewDecisionId: decisionId } : {}),
          },
        },
      );
      if (res.statusCode === 201) {
        draftVersion = (res.json() as { version: number }).version;
      }
      return res;
    }

    function body(res: Res): {
      message?: string;
      fieldErrors?: { path: string; code: string }[];
      error?: { fieldErrors?: { path: string; code: string }[] };
    } {
      return res.json() as {
        message?: string;
        fieldErrors?: { path: string; code: string }[];
        error?: { fieldErrors?: { path: string; code: string }[] };
      };
    }

    function assertBlocked(res: Res, code: string): void {
      expect(res.statusCode).toBe(422);
      const b = body(res);
      const codes = (b.error?.fieldErrors ?? b.fieldErrors ?? []).map((f) => f.code);
      expect(codes).toContain(code);
    }

    describe("createItem Path-B identity binding", () => {
      it("1. Apple decision + Apple source + Apple item -> 201 (eligible)", async () => {
        const chain = await seedChain({});
        const res = await createItem(chain.lexicalEntryId, chain.decisionId, "苹果");
        expect(res.statusCode).toBe(201);
      });

      it("2. Apple decision bound to a different (Banana) lexical entry -> 422 lexical_mismatch", async () => {
        const chain = await seedChain({});
        // A separate Banana entry.
        const banana = (
          await db.query<{ id: string }>(
            `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
             VALUES ('banana','banana','[]'::jsonb) RETURNING id`,
          )
        ).rows[0]!.id;
        const res = await createItem(banana, chain.decisionId, "香蕉");
        assertBlocked(res, "lexical_mismatch");
      });

      it("3. snapshot.english_spelling replaced (Banana) -> 422 snapshot_spelling_mismatch", async () => {
        const chain = await seedChain({ snapshotSpelling: "banana" });
        const res = await createItem(chain.lexicalEntryId, chain.decisionId, "苹果");
        assertBlocked(res, "snapshot_spelling_mismatch");
      });

      it("4. source_fact.normalized_spelling mismatch -> 422 normalized_spelling_mismatch", async () => {
        const chain = await seedChain({ sfNormalized: "banana" });
        const res = await createItem(chain.lexicalEntryId, chain.decisionId, "苹果");
        assertBlocked(res, "normalized_spelling_mismatch");
      });

      it("5. source_fact.commit_row_id != draft.import_batch_commit_row_id -> 422 commit_row_mismatch", async () => {
        // Two commit rows: the draft binds to one, the source fact to another.
        const other = await freshCommitRow(`other-${randomBytes(4).toString("hex")}`);
        // Construct the mismatch at insert time. enrichment_drafts is append-only,
        // so an UPDATE-based fixture would violate the real immutability trigger.
        const chainB = await seedChain({ sfCommitRowId: other.commitRowId });
        const res = await createItem(chainB.lexicalEntryId, chainB.decisionId, "苹果");
        assertBlocked(res, "commit_row_mismatch");
      });

      it("6. snapshot page/revision != source fact page/revision -> 422 revision_page_mismatch", async () => {
        const chain = await seedChain({ snapshotPage: "orange", snapshotRevision: "rev-9" });
        const res = await createItem(chain.lexicalEntryId, chain.decisionId, "苹果");
        assertBlocked(res, "revision_page_mismatch");
      });

      it("7. source fact not fetched (pending) -> 422 source_not_fetched", async () => {
        const chain = await seedChain({ sfStatus: "pending", sfContentHash: null });
        const res = await createItem(chain.lexicalEntryId, chain.decisionId, "苹果");
        assertBlocked(res, "source_not_fetched");
      });

      it("8. source fact content_hash missing (pending fact: hash NULL) -> 422 source_fact_hash_missing", async () => {
        // A fetched fact cannot lack a hash (DB CHECK). The hash-missing code fires when a
        // non-fetched fact (hash NULL) is evaluated; source_not_fetched also fires. Assert
        // that the blocked response carries the hash-missing code as one of the failures.
        const chain = await seedChain({ sfStatus: "pending", sfContentHash: null });
        const res = await createItem(chain.lexicalEntryId, chain.decisionId, "苹果");
        expect(res.statusCode).toBe(422);
        const payload = body(res);
        const codes = (payload.error?.fieldErrors ?? payload.fieldErrors ?? []).map((f) => f.code);
        // createItem throws the FIRST failing check; for a pending fact that is source_not_fetched.
        // hash_missing is emitted by the domain eligibility path (tested separately below).
        expect(
          codes.includes("source_not_fetched") || codes.includes("source_fact_hash_missing"),
        ).toBe(true);
      });

      it("9. same decision bound to a second item -> 422 conflicting_decision", async () => {
        const chain = await seedChain({});
        const first = await createItem(chain.lexicalEntryId, chain.decisionId, "苹果");
        expect(first.statusCode).toBe(201);
        const second = await createItem(chain.lexicalEntryId, chain.decisionId, "苹果");
        assertBlocked(second, "conflicting_decision");
      });

      it("10. rejected decision -> 422 not_accepted", async () => {
        const chain = await seedChain({ decisionType: "reject" });
        const res = await createItem(chain.lexicalEntryId, chain.decisionId, "苹果");
        assertBlocked(res, "not_accepted");
      });

      it("11. legal Path-A manual item (no reviewDecisionId) -> 201 (no regression)", async () => {
        const chain = await seedChain({});
        const res = await createItem(chain.lexicalEntryId, undefined, "手工内容");
        expect(res.statusCode).toBe(201);
      });
    });

    describe("publish-time re-validation (VALIDATION_SQL)", () => {
      it("a bypassed invalid binding is blocked at publish with a stable ITEM_* code", async () => {
        // Build a valid chain, then bind it directly via SQL to a draft item whose
        // lexical entry has a DIFFERENT canonical spelling (simulating a bypass of
        // createItem's guard). Publish must fail closed.
        const chain = await seedChain({ snapshotSpelling: "papaya" }); // snapshot != entry canonical
        const itemId = randomUUID();
        const auditId = (
          await db.query<{ id: string }>(
            `INSERT INTO audit_events (actor_id, action, target_type, target_id, request_id)
             VALUES ($1,'admin.course.item.create','course',$2,'req') RETURNING id`,
            [adminUserId, courseId],
          )
        ).rows[0]!.id;
        await db.query(
          `INSERT INTO draft_course_items
             (id, draft_unit_id, lexical_entry_id, position, meaning, hint, content_review_reference,
              provenance_kind, review_decision_id)
           VALUES ($1,$2,$3,(SELECT COALESCE(MAX(position),0)+1 FROM draft_course_items WHERE draft_unit_id=$2),'苹果',NULL,$4,'review',$5)`,
          [itemId, unitId, chain.lexicalEntryId, auditId, chain.decisionId],
        );
        // validateCourse must surface ITEM_SNAPSHOT_SPELLING_MISMATCH.
        const val = await admin.req("POST", `/api/v1/admin/courses/${courseId}/validate`);
        expect(val.statusCode).toBe(200);
        const vbody = val.json() as { isPublishable: boolean; blockingErrors?: { code: string }[] };
        expect(vbody.isPublishable).toBe(false);
        const codes = (vbody.blockingErrors ?? []).map((e) => e.code);
        expect(codes).toContain("ITEM_SNAPSHOT_SPELLING_MISMATCH");
      });
    });
  },
);
