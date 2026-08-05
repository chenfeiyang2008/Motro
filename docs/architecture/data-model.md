# Data Model

## 1. Conventions

- Primary IDs are application-generated UUIDs. Human order uses explicit integer positions, never creation time.
- Timestamps are UTC `timestamptz`; user timezone is an IANA identifier.
- Mutable aggregates have `created_at`, `updated_at` and, where concurrency matters, an integer `version` for optimistic locking.
- Immutable facts (`ReviewEvent`, `XpEntry`, releases, audit records) have no update path. Corrections append a compensating record.
- Soft disable is used for users/courses referenced by history. Hard delete is allowed only for unreferenced drafts and expired operational artifacts under an explicit retention job.

## 2. Identity

### `users`

`id`, unique `username`, `display_name`, `role` (`learner|admin`), `status` (`active|disabled`), `timezone`, `daily_budget_minutes`, `password_hash`, `must_change_password`, timestamps.

Constraints: budget 1–120; valid supported timezone at application boundary; normalized username unique. Password plaintext is never persisted.

### `auth_sessions`

`id`, `user_id`, unique hashed `token_digest`, `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at`, client summary.

### `audit_events`

Immutable `id`, actor, action, target type/ID, redacted before/after summary, request ID, timestamp. Supplier secrets, passwords and session tokens are prohibited payload fields.

## 3. Lexicon and source data

### `lexical_entries`

`id`, `canonical_spelling`, `normalized_spelling`, optional pronunciation/part-of-speech/sense data as structured versioned fields, status, timestamps.

Normalization assists lookup but does not collapse homographs blindly. A duplicate-resolution command decides merges and preserves aliases/provenance.

### `lexical_sources`

`id`, `lexical_entry_id`, `source_type` (`manual|wiktionary|import`), source locator/revision, license/attribution, retrieved time, content hash and structured excerpt. Unique on source identity + revision + content hash.

### `enrichment_drafts` and `review_decisions`

Draft: entry/batch-row link, Wiktionary snapshot, DeepSeek request template/version, response hash, generated Chinese fields, status and timestamps.  
Decision: immutable draft, reviewer, outcome (`accepted|accepted_with_edits|rejected`), accepted content snapshot, reason and time.

Only the latest accepted decision can be applied through an audited lexical-entry command. Supplier output alone has no publish authority.

## 4. Courses and releases

### Mutable authoring tables

- `courses`: stable course identity, slug, title, level, visibility, `current_release_id`, status.
- `course_drafts`: one active draft per course, metadata, optimistic `version`, based-on release.
- `draft_units`: draft, stable `unit_id`, position, title, description.
- `draft_course_items`: draft unit, stable `course_item_id`, lexical entry, position, course-specific Chinese meaning/hint and content-review reference.

Stable `unit_id` and `course_item_id` persist when an author carries an item into the next draft. Duplicating/replacing creates a new stable ID.

### Immutable release tables

- `course_releases`: course, monotonically increasing `release_number`, release note, creator/time, source draft version and content hash.
- `released_units`: release, stable unit ID, position and presentation snapshot.
- `released_course_items`: release/unit, stable course-item ID, lexical-entry reference, position and complete bilingual presentation snapshot.

Unique `(course_id, release_number)`, `(release_id, position)` and per-unit item position. Database permissions/triggers or repository guards reject update/delete of release rows after commit.

### `course_enrollments`

`user_id`, `course_id`, joined time, active status, current release policy/pin if later required. A partial unique index ensures one active `is_primary=true` enrollment per user.

## 5. Learning

### `learning_cards`

One row per `(user_id, course_item_id, direction)`: `id`, course/enrollment reference, direction, state (`new|learning|review`), FSRS stability/difficulty, scheduled days, elapsed days, reps, lapses, last review, due time, scheduler version, state version.

Unique user + stable course item + direction. Removal from current release marks planning eligibility false but preserves the row.

### `study_sessions`

`id`, user, primary course/release, status (`active|completed|abandoned`), budget, planned/started/completed timestamps, cursor and aggregate counters. Only one resumable active session per user unless explicitly abandoned.

### `study_session_items`

Session, position, card, item kind (`new_learning|initial_review|due_review`), plan reason, state (`pending|shown|completed|skipped_by_server`) and optional accepted review event. This is the resumable plan snapshot, not the source of scheduling truth.

### `review_events`

Immutable `id`, `user_id`, `card_id`, `session_id`, unique `(user_id, client_event_id)`, rating, scheduler version/parameters reference, state-before hash/snapshot, state-after snapshot, reviewed-at server time, client timing metadata and created time.

If an existing idempotency key is submitted with a different card/rating, return `409 IDEMPOTENCY_CONFLICT`. Do not create an event for reveal-only actions.

### Derived progress

- Initial-review completion is derived from existence of each direction’s first valid event.
- Item stability is derived from both card intervals being at least 21 days.
- Unit unlock is derived from all prior/current required items having both initial reviews; an optional read model may cache it and must be rebuildable.

## 6. Game

### `game_rule_sets`

Immutable version, effective time, status and validated JSON configuration for XP, level thresholds, tasks, streak protection, badges and leaderboard boundaries.

### `xp_entries`

Immutable ledger: user, amount, reason, unique eligible `review_event_id`, rule-set version and occurred time. Amount is 5 for v1 eligible events. Corrections use a separate compensating entry referencing the original.

### Streak, quest and badge facts

- `streak_days`: unique user + local date, timezone used, qualifying event and protected/earned state.
- `streak_protections`: immutable earned/consumed ledger.
- `quest_instances` and `quest_progress_events`: assigned rule version, period and progress facts.
- `badge_awards`: unique user + badge key + qualifying scope, rule version and awarded time.

The leaderboard is a query/read model over XP entries within a defined week; do not persist rank as authority.

## 7. Imports and jobs

### `stored_files`

Opaque ID, server-controlled storage key, original filename, media type, byte size, SHA-256, uploader, purpose, retention class and timestamps.

### `import_batches` / `import_rows`

Batch stores file, source declaration, format, worksheet/mapping, status and counts. Row stores ordinal, raw normalized input, validation errors, duplicate disposition, linked lexical entry/draft and processing status. Unique batch + ordinal.

### Worker job references

Graphile Worker owns queue tables. Application tables store durable operation records and expose a safe job reference, state summary and correlation ID. External call records carry idempotency key, request hash, provider/model/version, sanitized response hash/status, attempts and timestamps.

## 8. Essential indexes and retention

- `learning_cards(user_id, due_at)` filtered to planning-eligible cards.
- `review_events(card_id, reviewed_at desc)` and unique idempotency index.
- released items by `release_id, unit_position, item_position` and stable item ID.
- XP by user/time; import rows by batch/status; enrichment drafts by review status/time.
- Sessions and authentication records follow security retention policy; audit, reviews, release snapshots and XP facts are retained for the life of v1 unless a later privacy policy defines deletion/anonymization.

## 9. Migration rules

Migrations are ordered SQL committed with code, applied once by a dedicated migration step before API/worker rollout. Destructive changes use expand → backfill → verify → contract. Every production migration has a tested forward path and a documented restore/rollback decision; published/review facts are never silently rewritten.
