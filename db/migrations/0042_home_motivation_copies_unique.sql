-- 0042_home_motivation_copies_unique
-- Ticket · motivation backend concurrent-dedup closeout.
--
-- Adds a stable UNIQUE constraint on (copy_text, category) so that concurrent
-- batch creations of the same copy cannot produce duplicate rows. The app layer
-- uses INSERT ... ON CONFLICT (copy_text, category) DO NOTHING to make the
-- existence check atomic; the previous SELECT-then-INSERT pattern allowed two
-- concurrent requests to both pass the pre-check and insert a duplicate.
--
-- This is append-only: it does not modify seed data, does not delete history,
-- does not weaken auth/CSRF, and does not rewrite any earlier migration.
--
-- Note: for a fresh DB (0041 seed rows are pairwise-distinct on
-- (copy_text, category)) this index applies cleanly. If a pre-existing shared
-- DB already contains duplicate rows from the race, this index would fail to
-- create — but that is a pre-existing-data condition outside this ticket's
-- boundary (we do not clean shared DBs or delete history here).
CREATE UNIQUE INDEX home_motivation_copies_text_category_unique
  ON home_motivation_copies (copy_text, category);
