# Weekly Challenge Board

**Responsibility:** show the current all-user weekly challenge ranking and provide the sole entry action for an objective vocabulary quiz.

**Primary action:** “开始测验”. It is available after 10 distinct exposed lexical entries; the nearby explanation states the prerequisite or the Sunday 23:55 Beijing start cutoff. It does not appear on the home page.

**Required content:**

- title “周挑战榜”, fixed Beijing week range and countdown; explain that it ranks challenge points, not daily-learning XP or English ability;
- viewer's public rank (or opt-out state), challenge points, distinct currently score-eligible words, estimated weekly growth XP `floor(points/10)` capped at 200, and a link to public-participation settings;
- public rows containing rank, display name and challenge points only; ties resolve by first reaching the current score then user ID;
- a concise explanation that a first correct answer for a global word direction earns 5 points once per week, while review questions may earn 0;
- clear states for fewer than 10 words, Sunday cutoff, no public participants, adjustment notice and retryable loading failure.

**Exclude:** routine XP ranking, lifetime analytics, direct messaging, follow/friend controls, public profiles, betting-like movement, urgency copy, more than one primary action or a quiz embedded in the ranking page.
