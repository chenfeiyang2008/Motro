-- Ticket 21: administrator-managed learner home motivational copy.
CREATE TABLE home_motivation_copies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  copy_text text NOT NULL,
  category text NOT NULL,
  attribution text,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT home_motivation_copies_text_check CHECK (length(btrim(copy_text)) BETWEEN 1 AND 180),
  CONSTRAINT home_motivation_copies_category_check CHECK (category IN ('poetry_pun', 'english_joke', 'learning_wit', 'encouragement')),
  CONSTRAINT home_motivation_copies_attribution_check CHECK (attribution IS NULL OR length(btrim(attribution)) BETWEEN 1 AND 80)
);
CREATE INDEX home_motivation_copies_enabled_category_idx ON home_motivation_copies (is_enabled, category, updated_at DESC, id DESC);
CREATE INDEX home_motivation_copies_updated_idx ON home_motivation_copies (updated_at DESC, id DESC);

INSERT INTO home_motivation_copies (copy_text, category, attribution)
VALUES
  ('日照香炉生紫烟，来学两个单词先。', 'poetry_pun', 'Motro'),
  ('李白乘舟将欲行，忘记打卡可不行。', 'poetry_pun', 'Motro'),
  ('烟花三月下扬州，见人只会说 hello 可不够。', 'poetry_pun', 'Motro'),
  ('Why did the word go to school? It wanted a better sentence.', 'english_joke', 'Motro'),
  ('今天学一点，明天就能多说一句。', 'encouragement', 'Motro');
