-- 0044_challenge_choice_options
-- Freeze visible choices with each challenge item. Nullable preserves old
-- attempts; newly created choice items always carry their option snapshot.
ALTER TABLE challenge_attempt_items
  ADD COLUMN IF NOT EXISTS choice_options text[];
