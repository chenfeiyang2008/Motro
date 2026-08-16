// Ticket 07: immutable human review facts.  No final content or publication tables.
import {
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
import { enrichmentDrafts } from "./enrichment-drafts.js";
import { users, auditEvents } from "./platform-identity.js";

export const reviewDecisions = pgTable(
  "review_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => enrichmentDrafts.id, { onDelete: "restrict" }),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decisionType: text("decision_type").notNull(),
    reason: text("reason").notNull(),
    decisionHash: text("decision_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    auditEventId: uuid("audit_event_id").references(() => auditEvents.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_decisions_draft_unique").on(t.draftId),
    uniqueIndex("review_decisions_reviewer_key_unique").on(t.reviewerId, t.idempotencyKey),
    index("review_decisions_draft_created_idx").on(t.draftId, t.createdAt),
    index("review_decisions_reviewer_created_idx").on(t.reviewerId, t.createdAt),
  ],
);

export const reviewDecisionIdempotency = pgTable(
  "review_decision_idempotency",
  {
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: jsonb("response_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.reviewerId, t.idempotencyKey] })],
);

export const reviewDecisionSnapshots = pgTable(
  "review_decision_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => reviewDecisions.id, { onDelete: "restrict" }),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => enrichmentDrafts.id, { onDelete: "restrict" }),
    decisionType: text("decision_type").notNull(),
    englishSpelling: text("english_spelling").notNull(),
    partOfSpeech: text("part_of_speech"),
    simplifiedChineseMeaning: text("simplified_chinese_meaning"),
    learningHint: text("learning_hint"),
    sourceFactIdentity: text("source_fact_identity").notNull(),
    sourceName: text("source_name").notNull(),
    sourcePageId: text("source_page_id").notNull(),
    sourceRevisionId: text("source_revision_id").notNull(),
    sourceRevisionTimestamp: timestamp("source_revision_timestamp", {
      withTimezone: true,
    }).notNull(),
    sourceUrl: text("source_url").notNull(),
    licenseName: text("license_name").notNull(),
    licenseVersion: text("license_version"),
    licenseUrl: text("license_url").notNull(),
    attribution: text("attribution").notNull(),
    configuredModelAlias: text("configured_model_alias").notNull(),
    resolvedProviderModel: text("resolved_provider_model"),
    providerFingerprint: text("provider_fingerprint"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    draftSchemaVersion: integer("draft_schema_version").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_decision_snapshots_decision_unique").on(t.decisionId),
    index("review_decision_snapshots_draft_idx").on(t.draftId),
  ],
);

// Append-only manual handling fact: records a resolvable manual_action → draft_ready
// transition.  Only resolvable classes (DRAFT_BUDGET_EXCEEDED, WIKI_AMBIGUOUS) are
// permitted; the DB trigger motro_guard_manual_handling enforces this.
export const manualHandlingFacts = pgTable(
  "manual_handling_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => enrichmentDrafts.id, { onDelete: "restrict" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    handlingKind: text("handling_kind").notNull(),
    reason: text("reason").notNull(),
    previousStatus: text("previous_status").notNull(),
    nextStatus: text("next_status").notNull(),
    targetState: text("target_state").notNull(),
    requestHash: text("request_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    auditEventId: uuid("audit_event_id").references(() => auditEvents.id, { onDelete: "restrict" }),
    supplementSummary: text("supplement_summary"),
    supplementalFields: jsonb("supplemental_fields"),
    errorCode: text("error_code"),
    sourceErrorSummary: text("source_error_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("manual_handling_facts_draft_idx").on(t.draftId, t.createdAt),
    index("manual_handling_facts_actor_idx").on(t.actorId, t.createdAt),
    uniqueIndex("manual_handling_facts_draft_key_unique").on(t.draftId, t.idempotencyKey),
  ],
);
