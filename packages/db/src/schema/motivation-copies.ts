import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const homeMotivationCopies = pgTable(
  "home_motivation_copies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    copyText: text("copy_text").notNull(),
    category: text("category").notNull(),
    attribution: text("attribution"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("home_motivation_copies_enabled_category_idx").on(
      t.isEnabled,
      t.category,
      t.updatedAt,
      t.id,
    ),
    index("home_motivation_copies_updated_idx").on(t.updatedAt, t.id),
    // Stable unique identity so concurrent batch creates cannot duplicate a copy.
    uniqueIndex("home_motivation_copies_text_category_unique").on(t.copyText, t.category),
  ],
);
