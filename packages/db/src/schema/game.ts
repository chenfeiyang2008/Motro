// Ticket 09 motivation ledgers: personal XP, Challenge Points, weekly leaderboard projection.
// These are immutable/derived facts — daily study XP is SEPARATE from Challenge Points
// (ADR-0007); the leaderboard is a rebuildable read model over Challenge Points only.
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { reviewEvents } from "./courses.js";
import { users } from "./platform-identity.js";

export const gameRuleSets = pgTable(
  "game_rule_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleVersion: integer("rule_version").notNull(),
    label: text("label").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("active"),
    configuration: jsonb("configuration").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("game_rule_sets_rule_version_unique").on(t.ruleVersion)],
);

export const xpEntries = pgTable(
  "xp_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewEventId: uuid("review_event_id")
      .notNull()
      .references(() => reviewEvents.id, { onDelete: "restrict" }),
    ruleVersion: integer("rule_version")
      .notNull()
      .references(() => gameRuleSets.ruleVersion, { onDelete: "restrict" }),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    referencesXpEntry: uuid("references_xp_entry").references((): AnyPgColumn => xpEntries.id, {
      onDelete: "restrict",
    }),
    sourceEventId: text("source_event_id").notNull(),
    earnedAt: timestamp("earned_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NOTE: SQL migration 0035 declares the dedup as a PARTIAL unique index:
    //   (review_event_id, rule_version) WHERE references_xp_entry IS NULL.
    // Drizzle cannot express the partial predicate, so we intentionally DO NOT
    // declare it here — a plain uniqueIndex would emit a wrong non-partial UNIQUE
    // that contradicts the authoritative SQL.  The real constraint lives in SQL
    // 0035 and is verified by the pg_catalog integration assertion.
    index("xp_entries_user_created_idx").on(t.userId, t.createdAt),
    index("xp_entries_review_event_idx").on(t.reviewEventId),
    index("xp_entries_user_earned_idx").on(t.userId, t.earnedAt),
  ],
);

export const levelAwards = pgTable(
  "level_awards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    level: integer("level").notNull(),
    titleKey: text("title_key").notNull(),
    ruleVersion: integer("rule_version")
      .notNull()
      .references(() => gameRuleSets.ruleVersion, { onDelete: "restrict" }),
    qualifiedXp: integer("qualified_xp").notNull(),
    reason: text("reason").notNull(),
    awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("level_awards_user_level_unique").on(t.userId, t.level),
    index("level_awards_user_level_idx").on(t.userId, t.level),
  ],
);

export const challengePointEntries = pgTable(
  "challenge_point_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    challengeWeek: text("challenge_week").notNull(),
    sourceAttemptId: uuid("source_attempt_id").notNull(),
    // FK to challenge_attempts added by migration 0037 (Drizzle cannot express ADD CONSTRAINT).
    ruleVersion: integer("rule_version")
      .notNull()
      .references(() => gameRuleSets.ruleVersion, { onDelete: "restrict" }),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    referencesPointEntry: uuid("references_point_entry").references(
      (): AnyPgColumn => challengePointEntries.id,
      { onDelete: "restrict" },
    ),
    // Ticket 14: word-direction dedup columns (migration 0037).
    lexicalEntryId: uuid("lexical_entry_id"),
    direction: text("direction"),
    awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Ticket 09: per-attempt dedup (SQL 0035).
    uniqueIndex("challenge_point_entries_unique").on(t.sourceAttemptId, t.ruleVersion),
    // Ticket 14: ADR-0007 cross-course word-direction dedup (partial; see SQL 0037).
    // Drizzle cannot express WHERE predicates, so this is declared in SQL only.
    index("challenge_point_entries_user_week_idx").on(t.userId, t.challengeWeek),
    index("challenge_point_entries_week_idx").on(t.challengeWeek, t.awardedAt),
    index("challenge_point_entries_user_week_word_idx").on(
      t.userId,
      t.challengeWeek,
      t.lexicalEntryId,
      t.direction,
    ),
  ],
);

export const leaderboardPreferences = pgTable("leaderboard_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "restrict" }),
  isPublic: boolean("is_public").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const weeklyLeaderboardProjection = pgTable(
  "weekly_leaderboard_projection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeWeek: text("challenge_week").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    totalChallengePoints: integer("total_challenge_points").notNull(),
    firstReachedAt: timestamp("first_reached_at", { withTimezone: true }),
    rank: integer("rank").notNull(),
    isPublic: boolean("is_public").notNull().default(true),
    rebuiltAt: timestamp("rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("weekly_leaderboard_projection_week_user_unique").on(t.challengeWeek, t.userId),
    index("weekly_leaderboard_projection_week_rank_idx").on(t.challengeWeek, t.rank),
    index("weekly_leaderboard_projection_week_points_idx").on(
      t.challengeWeek,
      t.totalChallengePoints,
    ),
  ],
);

// ===========================================================================
// Ticket 14: server-graded Challenge Quiz scoring tables.
// All INSERT-only (append-only triggers in migration 0037).
// ===========================================================================

export const challengeAttempts = pgTable(
  "challenge_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    challengeWeek: text("challenge_week").notNull(),
    totalItems: integer("total_items").notNull(),
    status: text("status").notNull().default("in_progress"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    pointsEarned: integer("points_earned").notNull().default(0),
    maxPoints: integer("max_points").notNull().default(0),
  },
  (t) => [
    index("challenge_attempts_user_week_idx").on(t.userId, t.challengeWeek),
    index("challenge_attempts_week_status_idx").on(t.challengeWeek, t.status),
  ],
);

export const challengeAttemptItems = pgTable(
  "challenge_attempt_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => challengeAttempts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    direction: text("direction").notNull(),
    questionType: text("question_type").notNull(),
    lexicalEntryId: uuid("lexical_entry_id").notNull(),
    englishSpelling: text("english_spelling").notNull(),
    meaning: text("meaning").notNull(),
    serverAnswer: text("server_answer").notNull(),
    scoreEligible: boolean("score_eligible").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("challenge_attempt_items_attempt_position_unique").on(t.attemptId, t.position),
    index("challenge_attempt_items_attempt_idx").on(t.attemptId),
  ],
);

export const challengeAnswers = pgTable(
  "challenge_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => challengeAttempts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    clientEventId: text("client_event_id").notNull(),
    clientAnswer: text("client_answer").notNull(),
    isCorrect: boolean("is_correct").notNull(),
    pointsAwarded: integer("points_awarded").notNull().default(0),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("challenge_answers_attempt_position_unique").on(t.attemptId, t.position),
    index("challenge_answers_attempt_idx").on(t.attemptId),
  ],
);
