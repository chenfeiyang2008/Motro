# 0007: Separate objective weekly challenge points from routine XP

- Status: Accepted
- Date: 2026-08-06

## Context

Routine flashcard ratings are learner-reported and serve FSRS scheduling. They are appropriate for growth XP, but ranking them publicly would not be comparable objective answer activity.

## Decision

Daily-study XP never feeds a rank. The public board is **周挑战榜** and ranks only server-graded challenge points in fixed `Asia/Shanghai` weeks. A first correct answer to each `(user, week, global lexical entry, direction)` appends a 5-point event; a uniqueness constraint de-duplicates the same word across courses. Later correct answers can be review but award zero.

Each attempt has 10 distinct lexical entries, five English→Chinese choices and five Chinese→English exact-spelling questions, within five minutes. Eligibility starts after the learning face is viewed. Assembly targets seven score-eligible questions and three review questions, with disclosed fallback/max points. It prioritizes the primary course and freezes a concrete course-item/approved-meaning snapshot.

The week starts Monday 00:00 Beijing; no new attempt begins after Sunday 23:55 and no attempt crosses Monday 00:00. Ties resolve by first reaching the current score, then user ID. Users may opt out publicly without losing personal points or rewards. Settlement appends `floor(points / 10)` growth XP, capped at 200.

Responses, score events, adjustments and rewards are append-only. Administrators append an audited void or compensation with actor, reason and time; they cannot edit a total.

## Consequences

- The board measures weekly scored answer activity, not comprehensive language ability; FSRS stability remains the memory signal.
- Implementation needs snapshots, idempotency, score-event uniqueness, Beijing-clock tests and adjustment read models.
- No league ladder, speed bonus, XP multiplier, difficulty normalization, AI grading, proctoring or offline quiz in v1.
