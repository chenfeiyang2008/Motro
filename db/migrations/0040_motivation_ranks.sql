-- 0040_motivation_ranks
-- Versioned rank configuration and append-only personal rank achievements.
-- Rank achievements are derived from personal XP, never from Challenge Points.

INSERT INTO game_rule_sets (rule_version, label, effective_at, status, configuration)
VALUES (
  2,
  'motro-v2-ranks',
  now(),
  'active',
  '{"xpPerEligibleReviewEvent":5,"xpReveal":0,"dailyXpCap":null,"levelThresholds":[0,50,150,350,700,1200,2000,3000],"levelTitles":["初学黑铁","开口青铜","熟手白银","进阶黄金","资深铂金","英语钻石","跨洋王者","至尊词王"]}'::jsonb
)
ON CONFLICT (rule_version) DO NOTHING;

CREATE TABLE level_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  level integer NOT NULL CHECK (level BETWEEN 1 AND 8),
  title_key text NOT NULL CHECK (length(title_key) BETWEEN 1 AND 80),
  rule_version integer NOT NULL REFERENCES game_rule_sets (rule_version) ON DELETE RESTRICT,
  qualified_xp integer NOT NULL CHECK (qualified_xp >= 0),
  reason text NOT NULL CHECK (reason IN ('xp_progression', 'legacy_backfill')),
  awarded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT level_awards_user_level_unique UNIQUE (user_id, level)
);

CREATE INDEX level_awards_user_level_idx ON level_awards (user_id, level DESC);

CREATE TRIGGER level_awards_no_update
  BEFORE UPDATE ON level_awards
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();
CREATE TRIGGER level_awards_no_delete
  BEFORE DELETE ON level_awards
  FOR EACH ROW EXECUTE FUNCTION motro_reject_ledger_mutation();
