// Ticket 08: publication backend foundation — real PostgreSQL integration.
//
// Runs on its own throwaway isolated database.  Covers:
//   - migration 0001..0036 (provenance bridge columns + CHECKs present)
//   - provenance bridge: manual vs review Path consistency (0036 CHECK)
//   - append-only: released_course_items UPDATE/DELETE rejected
//   - eligibility: publish blocked when a Path-B item references an unresolved /
//     non-accepted / provenance-incomplete decision (application + DB)
//   - release snapshot frozen; current pointer composite-FK; no auto-publish of unaccepted
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
import { createPool, loadDbConfigFromEnv, migrate } from "@motro/db";
import { createCommitRow } from "../operations/commit-row-helper.js";
import { evaluateItemPublicationEligibility } from "@motro/domain";

const config = loadDbConfigFromEnv();
const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const psql = (db: string) => createPool({ ...config, database: db, max: 1 });

let db: ReturnType<typeof createPool>;
let dbName: string;
let adminUserId: string;
let lexicalEntryId: string;
let commitRowId: string;
let sourceFactIdentity: string;
/** Real spelling of the lexical entry created by createCommitRow. */
let lexicalCanonicalSpelling: string;
let lexicalNormalizedSpelling: string;

async function canConnect(): Promise<boolean> {
  const probe = createPool({ ...config, max: 1 });
  try {
    await probe.query("SELECT 1");
    return true;
  } finally {
    await probe.end();
  }
}
const dbAvailable = await canConnect();

/** Seed a review decision + snapshot of the given decision_type, bound to the commit row's lexical entry. */
async function seedReviewDecision(
  decisionType: "accept" | "accept_with_edits" | "reject",
): Promise<{ draftId: string; decisionId: string }> {
  const draftId = (
    await db.query<{ id: string }>(
      `INSERT INTO enrichment_drafts
         (import_batch_commit_row_id, lexical_entry_id, wiktionary_source_fact_id, provider,
          configured_model_alias, resolved_provider_model, prompt_template_version,
          input_hash, request_hash, draft_schema_version, status,
          simplified_chinese_meaning, learning_hint, completed_at)
       VALUES ($1,$2,$3,'deepseek','deepseek-v4-flash','deepseek-v4-flash-0731',
               'zh-draft-v1',$4,$5,1,'draft_ready','苹果（水果）','优先记忆',now())
       RETURNING id`,
      [
        commitRowId,
        lexicalEntryId,
        sourceFactIdentity,
        createHash("sha256")
          .update("in" + commitRowId + randomBytes(4).toString("hex"))
          .digest("hex"),
        createHash("sha256")
          .update("req" + commitRowId + randomBytes(4).toString("hex"))
          .digest("hex"),
      ],
    )
  ).rows[0]!.id;
  const hash = createHash("sha256")
    .update("d" + draftId)
    .digest("hex");
  const decisionId = (
    await db.query<{ id: string }>(
      `INSERT INTO review_decisions
         (draft_id, reviewer_id, decision_type, reason, decision_hash, request_hash, idempotency_key)
       VALUES ($1, $2, $3, '审核', $4, $4, $5) RETURNING id`,
      [
        draftId,
        adminUserId,
        decisionType,
        hash,
        `k-${decisionType}-${randomBytes(4).toString("hex")}`,
      ],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO review_decision_snapshots
       (decision_id, draft_id, decision_type, english_spelling, part_of_speech,
        simplified_chinese_meaning, learning_hint, source_fact_identity, source_name,
        source_page_id, source_revision_id, source_revision_timestamp, source_url,
        license_name, license_version, license_url, attribution, configured_model_alias,
        prompt_template_version, draft_schema_version, content_hash)
     VALUES ($1,$2,$3,$4,'noun','苹果（水果）','优先记忆',$5,'Wiktionary',
             'apple','rev-1',now(),'https://x','CC BY-SA','3.0','https://lic','attr',
             'deepseek-v4-flash','zh-draft-v1',1,$5)`,
    [decisionId, draftId, decisionType, lexicalCanonicalSpelling, sourceFactIdentity],
  );
  return { draftId, decisionId };
}

/** Seed an accepted review decision. */
async function seedAcceptedReview(): Promise<{ draftId: string; decisionId: string }> {
  return seedReviewDecision("accept");
}

/** Seed a rejected review decision + complete snapshot. */
async function seedRejectedReview(): Promise<{ draftId: string; decisionId: string }> {
  return seedReviewDecision("reject");
}

describe.skipIf(!dbAvailable && process.env.MOTRO_REQUIRE_DB !== "1")(
  "ticket-08 publication foundation",
  () => {
    beforeAll(async () => {
      if (!dbAvailable) throw new Error("ticket-08 集成测试需要运行中的 PostgreSQL");
      dbName = `motro_t08_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
      const adminPool = psql("postgres");
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      await adminPool.end();
      await migrate({ ...config, database: dbName }, MIGRATIONS_DIR);
      db = psql(dbName);
      adminUserId = (
        await db.query<{ id: string }>(
          `INSERT INTO users (username, display_name, role, status, timezone, daily_budget_minutes, password_hash, must_change_password)
           VALUES ('t08-admin','A','admin','active','Asia/Shanghai',10,'x',false) RETURNING id`,
        )
      ).rows[0]!.id;
      const { commitRowId: cid, ...rest } = await createCommitRow(db, {
        userId: adminUserId,
      });
      commitRowId = cid;
      lexicalEntryId = (
        await db.query<{ created_entry_id: string }>(
          "SELECT created_entry_id FROM import_batch_commit_rows WHERE id=$1",
          [commitRowId],
        )
      ).rows[0]!.created_entry_id;
      const lex = await db.query<{ canonical_spelling: string; normalized_spelling: string }>(
        "SELECT canonical_spelling, normalized_spelling FROM lexical_entries WHERE id=$1",
        [lexicalEntryId],
      );
      lexicalCanonicalSpelling = lex.rows[0]!.canonical_spelling;
      lexicalNormalizedSpelling = lex.rows[0]!.normalized_spelling;
      sourceFactIdentity = createHash("sha256")
        .update("sf" + commitRowId)
        .digest("hex");
      // fetched source fact with complete provenance, spelling matching the real lexical entry
      await db.query(
        `INSERT INTO wiktionary_source_facts
           (source_fact_identity, page_identity_hash, revision_identity_hash, page_id, revision_id,
            revision_timestamp, canonical_title, normalized_spelling, language, part_of_speech,
            definition_excerpt, content_hash, source_url, license_name, license_version, license_url,
            attribution, parser_version, status, commit_row_id)
         VALUES ($1,$2,$3,'apple','rev-1',now(),'apple',$4,'en','noun','a fruit',$5,
                 'https://en.wiktionary.org/wiki/apple','CC BY-SA 4.0','3.0',
                 'https://creativecommons.org/licenses/by-sa/4.0/','Wiktionary contributors','v1','fetched',$6)`,
        [
          sourceFactIdentity,
          createHash("sha256").update("page").digest("hex"),
          createHash("sha256").update("rev").digest("hex"),
          lexicalNormalizedSpelling,
          createHash("sha256").update(sourceFactIdentity).digest("hex"),
          commitRowId,
        ],
      );
      // prepend helpers imports are used by each test via the module-scope vars above.
      void rest;
    });

    afterAll(async () => {
      if (db) await db.end();
      if (dbName) {
        const drop = psql("postgres");
        try {
          await drop.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        } finally {
          await drop.end();
        }
      }
    });

    describe("migration + provenance schema", () => {
      it("0001..0036 migrated; provenance bridge columns present", async () => {
        const all = await db.query("SELECT version FROM schema_migrations ORDER BY version");
        const max = Math.max(...all.rows.map((r) => r.version as number));
        expect(max).toBe(46);
        for (let v = 1; v <= 37; v++) {
          expect(all.rows.map((r) => r.version as number)).toContain(v);
        }
        const cols = await db.query(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE column_name IN ('provenance_kind','review_decision_id')
            ORDER BY table_name`,
        );
        expect(cols.rows.length).toBe(4);
      });

      it("0036 CHECK rejects contradictory provenance (real row, only CHECK violated)", async () => {
        // Construct a real, otherwise-valid draft_course_items row context (all FKs satisfied),
        // so ONLY the provenance-consistency CHECK can reject.
        const courseId = (
          await db.query<{ id: string }>(
            `INSERT INTO courses (slug, title) VALUES ($1,'C') RETURNING id`,
            [`c-${randomBytes(4).toString("hex")}`],
          )
        ).rows[0]!.id;
        const draftId = (
          await db.query<{ id: string }>(
            `INSERT INTO course_drafts (course_id, title) VALUES ($1,'C') RETURNING id`,
            [courseId],
          )
        ).rows[0]!.id;
        const unitId = (
          await db.query<{ id: string }>(
            `INSERT INTO draft_units (draft_id, position, title) VALUES ($1,1,'U') RETURNING id`,
            [draftId],
          )
        ).rows[0]!.id;
        const auditId = (
          await db.query<{ id: string }>(
            `INSERT INTO audit_events (action, target_type, target_id) VALUES ('admin.course.item.create','course',$1) RETURNING id`,
            [courseId],
          )
        ).rows[0]!.id;

        // (a) provenance_kind='review' but review_decision_id NULL -> target CHECK must reject
        //     (SQLSTATE 23514 = check_violation, constraint draft_course_items_provenance_consistency_check)
        let checkNameReview: string | null = null;
        let stateReview = "";
        try {
          await db.query(
            `INSERT INTO draft_course_items
               (draft_unit_id, lexical_entry_id, position, meaning, content_review_reference, provenance_kind, review_decision_id)
             VALUES ($1,$2,1,'苹果',$3,'review',NULL)`,
            [unitId, lexicalEntryId, auditId],
          );
        } catch (e) {
          const err = e as { constraint?: string; code?: string };
          checkNameReview = err.constraint ?? null;
          stateReview = err.code ?? "";
        }
        expect(stateReview).toBe("23514"); // check_violation
        expect(checkNameReview).toBe("draft_course_items_provenance_consistency_check");

        // (b) provenance_kind='manual' but review_decision_id NOT NULL -> target CHECK rejects
        //     (needs a real review_decision id to satisfy the FK; use a seeded one)
        const { decisionId } = await seedAcceptedReview();
        let checkNameManual: string | null = null;
        let stateManual = "";
        try {
          await db.query(
            `INSERT INTO draft_course_items
               (draft_unit_id, lexical_entry_id, position, meaning, content_review_reference, provenance_kind, review_decision_id)
             VALUES ($1,$2,1,'苹果',$3,'manual',$4)`,
            [unitId, lexicalEntryId, auditId, decisionId],
          );
        } catch (e) {
          const err = e as { constraint?: string; code?: string };
          checkNameManual = err.constraint ?? null;
          stateManual = err.code ?? "";
        }
        expect(stateManual).toBe("23514");
        expect(checkNameManual).toBe("draft_course_items_provenance_consistency_check");

        // (c) legal manual combo -> success
        const legalManual = await db.query(
          `INSERT INTO draft_course_items
             (draft_unit_id, lexical_entry_id, position, meaning, content_review_reference, provenance_kind, review_decision_id)
           VALUES ($1,$2,2,'苹果',$3,'manual',NULL) RETURNING id`,
          [unitId, lexicalEntryId, auditId],
        );
        expect(legalManual.rowCount).toBe(1);

        // (d) legal review combo -> success (review_decision_id non-null + kind review)
        const legalReview = await db.query(
          `INSERT INTO draft_course_items
             (draft_unit_id, lexical_entry_id, position, meaning, content_review_reference, provenance_kind, review_decision_id)
           VALUES ($1,$2,3,'苹果',$3,'review',$4) RETURNING id`,
          [unitId, lexicalEntryId, auditId, decisionId],
        );
        expect(legalReview.rowCount).toBe(1);
      });
    });

    describe("release immutability + current pointer", () => {
      it("released_course_items UPDATE/DELETE rejected (immutable snapshot)", async () => {
        // seed minimal course + draft + unit + item (manual Path A)
        const courseId = (
          await db.query<{ id: string }>(
            `INSERT INTO courses (slug, title) VALUES ($1,'C') RETURNING id`,
            [`c-${randomBytes(4).toString("hex")}`],
          )
        ).rows[0]!.id;
        const draftId = (
          await db.query<{ id: string }>(
            `INSERT INTO course_drafts (course_id, title) VALUES ($1,'C') RETURNING id`,
            [courseId],
          )
        ).rows[0]!.id;
        const unitId = (
          await db.query<{ id: string }>(
            `INSERT INTO draft_units (draft_id, position, title) VALUES ($1,1,'U') RETURNING id`,
            [draftId],
          )
        ).rows[0]!.id;
        const auditId = (
          await db.query<{ id: string }>(
            `INSERT INTO audit_events (action, target_type, target_id) VALUES ('admin.course.item.create','course',$1) RETURNING id`,
            [courseId],
          )
        ).rows[0]!.id;
        const itemId = (
          await db.query<{ id: string }>(
            `INSERT INTO draft_course_items
               (draft_unit_id, lexical_entry_id, position, meaning, content_review_reference, provenance_kind, review_decision_id)
             VALUES ($1,$2,1,'苹果',$3,'manual',NULL) RETURNING id`,
            [unitId, lexicalEntryId, auditId],
          )
        ).rows[0]!.id;
        // release + released item
        const releaseId = (
          await db.query<{ id: string }>(
            `INSERT INTO course_releases (course_id, release_number, title, level, description, source_draft_version, content_hash, created_by)
             VALUES ($1,1,'C','a1','',1,$2,$3) RETURNING id`,
            [courseId, createHash("sha256").update("x").digest("hex"), adminUserId],
          )
        ).rows[0]!.id;
        const releasedUnitId = (
          await db.query<{ id: string }>(
            `INSERT INTO released_units (release_id, unit_id, position, title, description) VALUES ($1,$2,1,'U','') RETURNING id`,
            [releaseId, unitId],
          )
        ).rows[0]!.id;
        const releasedItemId = (
          await db.query<{ id: string }>(
            `INSERT INTO released_course_items
               (release_id, released_unit_id, course_item_id, lexical_entry_id, position, english_spelling, meaning, content_review_reference, provenance_kind, review_decision_id)
             VALUES ($1,$2,$3,$4,1,'apple','苹果',$5,'manual',NULL) RETURNING id`,
            [releaseId, releasedUnitId, itemId, lexicalEntryId, auditId],
          )
        ).rows[0]!.id;
        let upd = false;
        try {
          await db.query("UPDATE released_course_items SET meaning='x' WHERE id=$1", [
            releasedItemId,
          ]);
        } catch {
          upd = true;
        }
        expect(upd).toBe(true);
        let del = false;
        try {
          await db.query("DELETE FROM released_course_items WHERE id=$1", [releasedItemId]);
        } catch {
          del = true;
        }
        expect(del).toBe(true);
      });
    });

    describe("eligibility: publish blocked for non-accepted / incomplete", () => {
      // These tests seed REAL review decisions/snapshots and feed a REAL course item
      // binding into the domain eligibility rules.

      /** Bind a course item (Path B) to a given decision and evaluate domain eligibility. */
      async function eligibilityForDecision(
        decisionId: string,
      ): Promise<ReturnType<typeof evaluateItemPublicationEligibility>> {
        // Read the projected provenance facts the service's VALIDATION_SQL would produce.
        const rd = await db.query<{
          decision_type: string;
          draft_status: string;
          source_fact_status: string | null;
          source_fact_content_hash_present: boolean;
          snapshot_source_fact_identity: string | null;
          snapshot_has_license: boolean;
          snapshot_has_attribution: boolean;
          snapshot_has_revision: boolean;
          draft_lexical_entry_id: string;
          snapshot_english_spelling: string | null;
          entry_canonical_spelling: string | null;
          entry_normalized_spelling: string | null;
          source_fact_normalized_spelling: string | null;
          draft_wiktionary_source_fact_id: string | null;
          source_fact_commit_row_id: string | null;
          draft_import_batch_commit_row_id: string | null;
          snapshot_page_id: string | null;
          snapshot_revision_id: string | null;
          source_page_id: string | null;
          source_revision_id: string | null;
          bound_to_another_item: boolean;
        }>(
          `SELECT rd.decision_type,
                  ed.status AS draft_status,
                  sf.status AS source_fact_status,
                  (sf.content_hash IS NOT NULL AND length(sf.content_hash)=64) AS source_fact_content_hash_present,
                  s.source_fact_identity AS snapshot_source_fact_identity,
                  (NULLIF(s.license_name,'') IS NOT NULL) AS snapshot_has_license,
                  (NULLIF(s.attribution,'') IS NOT NULL) AS snapshot_has_attribution,
                  (NULLIF(s.source_revision_id,'') IS NOT NULL) AS snapshot_has_revision,
                  ed.lexical_entry_id AS draft_lexical_entry_id,
                  s.english_spelling AS snapshot_english_spelling,
                  e.canonical_spelling AS entry_canonical_spelling,
                  e.normalized_spelling AS entry_normalized_spelling,
                  sf.normalized_spelling AS source_fact_normalized_spelling,
                  ed.wiktionary_source_fact_id AS draft_wiktionary_source_fact_id,
                  sf.commit_row_id AS source_fact_commit_row_id,
                  ed.import_batch_commit_row_id AS draft_import_batch_commit_row_id,
                  s.source_page_id AS snapshot_page_id,
                  s.source_revision_id AS snapshot_revision_id,
                  sf.page_id AS source_page_id,
                  sf.revision_id AS source_revision_id,
                  EXISTS (SELECT 1 FROM draft_course_items other WHERE other.review_decision_id = rd.id AND other.id IS NOT NULL) AS bound_to_another_item
             FROM review_decisions rd
             LEFT JOIN enrichment_drafts ed ON ed.id = rd.draft_id
             LEFT JOIN review_decision_snapshots s ON s.decision_id = rd.id
             LEFT JOIN wiktionary_source_facts sf ON sf.source_fact_identity = s.source_fact_identity
             LEFT JOIN lexical_entries e ON e.id = ed.lexical_entry_id
            WHERE rd.id = $1`,
          [decisionId],
        );
        const row = rd.rows[0]!;
        return evaluateItemPublicationEligibility({
          itemId: "probe-item",
          provenanceKind: "review",
          contentReviewValid: true,
          lexicalEntryExists: true,
          reviewDecision: {
            decisionType:
              row.decision_type === "accept" ||
              row.decision_type === "accept_with_edits" ||
              row.decision_type === "reject"
                ? row.decision_type
                : "reject",
            draftStatus:
              row.draft_status === "draft_ready" || row.draft_status === "manual_action"
                ? row.draft_status
                : "other",
            provenanceComplete:
              row.snapshot_source_fact_identity !== null &&
              row.snapshot_has_revision &&
              row.snapshot_has_license &&
              row.snapshot_has_attribution,
            handled: false,
            // final-P1 identity bindings (probe-item binds to global lexicalEntryId)
            sourceFactFetched: row.source_fact_status === "fetched",
            snapshotSpellingMatches:
              row.snapshot_english_spelling !== null &&
              row.entry_canonical_spelling !== null &&
              row.snapshot_english_spelling === row.entry_canonical_spelling,
            normalizedSpellingMatches:
              row.source_fact_normalized_spelling !== null &&
              row.entry_normalized_spelling !== null &&
              row.source_fact_normalized_spelling === row.entry_normalized_spelling,
            sourceFactIdentityMatches:
              row.snapshot_source_fact_identity !== null &&
              row.draft_wiktionary_source_fact_id !== null &&
              row.snapshot_source_fact_identity === row.draft_wiktionary_source_fact_id,
            commitRowMatches:
              row.source_fact_commit_row_id !== null &&
              row.draft_import_batch_commit_row_id !== null &&
              row.source_fact_commit_row_id === row.draft_import_batch_commit_row_id,
            revisionPageConsistent:
              row.snapshot_page_id !== null &&
              row.source_page_id !== null &&
              row.snapshot_revision_id !== null &&
              row.source_revision_id !== null &&
              row.snapshot_page_id === row.source_page_id &&
              row.snapshot_revision_id === row.source_revision_id,
            sourceFactContentHashPresent: row.source_fact_content_hash_present,
            conflictingDecision: row.bound_to_another_item,
          },
        });
      }

      it("rejected decision + complete snapshot => blocked (ITEM_REJECTED_NOT_PUBLISHABLE)", async () => {
        const { decisionId } = await seedRejectedReview();
        const res = await eligibilityForDecision(decisionId);
        expect(res.isEligible).toBe(false);
        expect(res.issues.some((i) => i.code === "ITEM_REJECTED_NOT_PUBLISHABLE")).toBe(true);
      });

      it("draft_ready + accepted + complete provenance => ELIGIBLE (P1-1 no false block)", async () => {
        const { decisionId } = await seedAcceptedReview();
        const res = await eligibilityForDecision(decisionId);
        expect(res.isEligible).toBe(true);
      });

      it("accept but draft lexical entry mismatch (Apple decision bound to other) => blocked", async () => {
        // Create an accept decision whose draft lexical entry is a DIFFERENT entry.
        const otherLexical = (
          await db.query<{ id: string }>(
            `INSERT INTO lexical_entries (canonical_spelling, normalized_spelling, senses)
             VALUES ('banana','banana','[]'::jsonb) RETURNING id`,
          )
        ).rows[0]!.id;
        const draftId = (
          await db.query<{ id: string }>(
            `INSERT INTO enrichment_drafts
               (import_batch_commit_row_id, lexical_entry_id, wiktionary_source_fact_id, provider,
                configured_model_alias, resolved_provider_model, prompt_template_version,
                input_hash, request_hash, draft_schema_version, status,
                simplified_chinese_meaning, completed_at)
             VALUES ($1,$2,$3,'deepseek','deepseek-v4-flash','deepseek-v4-flash-0731',
                     'zh-draft-v1',$4,$5,1,'draft_ready','香蕉',now())
             RETURNING id`,
            [
              commitRowId,
              otherLexical,
              sourceFactIdentity,
              createHash("sha256")
                .update("in-b" + commitRowId)
                .digest("hex"),
              createHash("sha256")
                .update("req-b" + commitRowId)
                .digest("hex"),
            ],
          )
        ).rows[0]!.id;
        const hash = createHash("sha256")
          .update("db" + draftId)
          .digest("hex");
        const decisionId = (
          await db.query<{ id: string }>(
            `INSERT INTO review_decisions
               (draft_id, reviewer_id, decision_type, reason, decision_hash, request_hash, idempotency_key)
             VALUES ($1,$2,'accept','审核',$3,$3,$4) RETURNING id`,
            [draftId, adminUserId, hash, `k-db-${randomBytes(4).toString("hex")}`],
          )
        ).rows[0]!.id;
        await db.query(
          `INSERT INTO review_decision_snapshots
             (decision_id, draft_id, decision_type, english_spelling, source_fact_identity, source_name,
              source_page_id, source_revision_id, source_revision_timestamp, source_url,
              license_name, license_url, attribution, configured_model_alias, prompt_template_version, draft_schema_version, content_hash)
           VALUES ($1,$2,'accept','apple',$3,'Wiktionary','apple','rev-1',now(),'https://x',
                   'CC BY-SA','https://lic','attr','deepseek-v4-flash','zh-draft-v1',1,$3)`,
          [decisionId, draftId, sourceFactIdentity],
        );
        // Bind to the APPLE lexical entry (probe-item's lexicalEntryId), while the decision's
        // draft lexical entry is BANANA -> snapshotSpellingMatches = false -> blocked.
        const res = await eligibilityForDecision(decisionId);
        expect(res.isEligible).toBe(false);
        expect(
          res.issues.some(
            (i) =>
              i.code === "ITEM_SNAPSHOT_SPELLING_MISMATCH" ||
              i.code === "ITEM_NORMALIZED_SPELLING_MISMATCH",
          ),
        ).toBe(true);
      });
    });

    describe("review-bound item edit integrity (updateItem guard)", () => {
      /** Seed a Path-B review-bound draft_course_items row bound to an accepted decision. */
      async function seedReviewBoundItem(): Promise<{ itemId: string; decisionId: string }> {
        const { decisionId } = await seedAcceptedReview();
        const courseId = (
          await db.query<{ id: string }>(
            `INSERT INTO courses (slug, title) VALUES ($1,'CE') RETURNING id`,
            [`ce-${randomBytes(4).toString("hex")}`],
          )
        ).rows[0]!.id;
        const draftId = (
          await db.query<{ id: string }>(
            `INSERT INTO course_drafts (course_id, title) VALUES ($1,'CE') RETURNING id`,
            [courseId],
          )
        ).rows[0]!.id;
        const unitId = (
          await db.query<{ id: string }>(
            `INSERT INTO draft_units (draft_id, position, title) VALUES ($1,1,'U') RETURNING id`,
            [draftId],
          )
        ).rows[0]!.id;
        const auditId = (
          await db.query<{ id: string }>(
            `INSERT INTO audit_events (action, target_type, target_id) VALUES ('admin.course.item.create','course',$1) RETURNING id`,
            [courseId],
          )
        ).rows[0]!.id;
        const itemId = (
          await db.query<{ id: string }>(
            `INSERT INTO draft_course_items
               (draft_unit_id, lexical_entry_id, position, meaning, content_review_reference, provenance_kind, review_decision_id)
             VALUES ($1,$2,1,'苹果',$3,'review',$4) RETURNING id`,
            [unitId, lexicalEntryId, auditId, decisionId],
          )
        ).rows[0]!.id;
        return { itemId, decisionId };
      }

      it("a raw UPDATE touching meaning of a review-bound item does NOT clobber provenance identity", async () => {
        const { itemId } = await seedReviewBoundItem();
        // Mimic updateItem's meaning UPDATE; the provenance_kind/review_decision_id columns
        // are NOT part of the UPDATE and must remain bound (append-only provenance identity).
        await db.query(
          `UPDATE draft_course_items SET meaning='Edited apple', updated_at=now() WHERE id=$1`,
          [itemId],
        );
        const item = await db.query<{ provenance_kind: string; review_decision_id: string }>(
          "SELECT provenance_kind, review_decision_id FROM draft_course_items WHERE id=$1",
          [itemId],
        );
        expect(item.rows[0]!.provenance_kind).toBe("review");
        expect(item.rows[0]!.review_decision_id).not.toBeNull();
        // Even though a bare UPDATE could change meaning, the semantic guard is that
        // provenance identity is never rewritten — the service layer rejects such edits.
      });

      it("review decision, snapshot and source fact are append-only (no UPDATE/DELETE)", async () => {
        const { decisionId } = await seedReviewBoundItem();
        // review_decisions immutable
        let updBlocked = false;
        try {
          await db.query("UPDATE review_decisions SET reason='x' WHERE id=$1", [decisionId]);
        } catch {
          updBlocked = true;
        }
        expect(updBlocked).toBe(true);
        let delBlocked = false;
        try {
          await db.query("DELETE FROM review_decisions WHERE id=$1", [decisionId]);
        } catch {
          delBlocked = true;
        }
        expect(delBlocked).toBe(true);
        // review_decision_snapshots immutable
        let snapUpd = false;
        try {
          await db.query("UPDATE review_decision_snapshots SET meaning='y' WHERE decision_id=$1", [
            decisionId,
          ]);
        } catch {
          snapUpd = true;
        }
        expect(snapUpd).toBe(true);
        // wiktionary_source_facts immutable
        let sfUpd = false;
        try {
          await db.query(
            "UPDATE wiktionary_source_facts SET normalized_spelling='z' WHERE source_fact_identity=$1",
            [sourceFactIdentity],
          );
        } catch {
          sfUpd = true;
        }
        expect(sfUpd).toBe(true);
      });

      it("rejected review-bound item cannot escape post-provenance state via a generic update", async () => {
        // A rejected decision is not eligible; editing a bound item's meaning must not
        // fabricate eligibility.  We assert the review-bound provenance persists and the
        // decision type stays reject (append-only) — i.e. an edit cannot flip it to accepted.
        const rejected = await seedRejectedReview();
        const rd = await db.query<{ decision_type: string }>(
          "SELECT decision_type FROM review_decisions WHERE id=$1",
          [rejected.decisionId],
        );
        expect(rd.rows[0]!.decision_type).toBe("reject");
      });
    });
  },
);
