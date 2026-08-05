# Testing Strategy

## Principles

Test irreversible domain facts and contracts most deeply. Time, randomness, scheduler parameters and supplier responses must be injectable/deterministic. Every production defect adds the narrowest regression test at the lowest effective layer.

## Domain tests

- Dual independent cards: creation, direction isolation and no cross-direction state mutation.
- FSRS v6 adapter: Again/Hard/Good/Easy fixtures, due calculations, parameter version and deterministic clock.
- Stability: both intervals `>= 21 days`; boundary and regression below threshold.
- Unit unlock: every item completes both initial reviews; empty/removed/new-version cases.
- Daily planning: overdue before due before new, locked-unit exclusion, time-budget fill and no-work result.
- Game rules: 5 routine-study XP eligibility, no rating multiplier, level/quest/badge versions, timezone streak and protection earn/consume.
- Challenge rules: fixed Beijing week/cutoff, 10 distinct lexical entries, five directions each way, 7 score-eligible / 3 review target and pool fallback, primary-course source preference, and no same-word opposite-direction leak.
- Challenge score: one 5-point fact per user/week/global-entry/direction across courses; wrong-then-later-correct awards once; already-scored review awards zero; first-reached-current-score tie-break and stable user ID fallback.
- Challenge grading: outer-space/case normalization, exact required spaces/hyphens, administrator aliases only, no fuzzy or AI acceptance.
- Challenge settlement: `floor(points/10)`, 200 XP cap, idempotent rerun, opt-out still rewards, and audited void/compensation produces adjustment plus XP compensation.

## Integration tests with PostgreSQL

- Concurrent duplicate `ReviewEvent` submissions produce one event, one card transition and at most one XP entry.
- Same idempotency key with changed payload returns conflict.
- Review transaction rolls back all effects on failure.
- Challenge response transaction validates week/expiry, locks the snapshot, makes repeated responses idempotent and records at most one score event under concurrent submits.
- Attempt recovery, five-minute expiry, Sunday 23:55 start denial and Monday boundary behavior are deterministic under injected Beijing clocks.
- Score adjustments preserve responses and original score facts; board read model excludes daily XP and hidden users while personal read models retain both.
- Published release rows reject mutation; publish is atomic and stable course-item IDs preserve history.
- Draft optimistic version conflicts are visible.
- Graphile tasks tolerate at-least-once execution, retry supplier errors and never duplicate applied results.
- Explicit SQL migrations run from empty DB and from each supported prior release fixture.

## Import tests

Fixture matrix covers TXT/CSV/XLSX/JSON, BOM/encoding, worksheets, custom mapping, duplicate word/row, blank or malformed row, large file limits and malicious filenames/content. Supplier fixtures cover Wiktionary missing/ambiguous/revision changes, DeepSeek empty/invalid/rate-limited response, retries, human edit/accept/reject and provenance retention.

No normal test calls live Wiktionary or DeepSeek. A separately gated contract smoke test may call providers with budgets and redacted recordings.

## API and security tests

- Generated OpenAPI matches a committed reviewed artifact; breaking diffs fail CI.
- Role/ownership matrix checks every endpoint, including hidden-resource `404` behavior.
- Cookie flags, session rotation/revocation, first-login password change, CSRF/origin checks, login rate limit and disabled users.
- Upload limits, MIME/content validation, path traversal, stored XSS, injection and secret/log redaction.
- Common error envelope, request IDs, pagination stability and time/timezone serialization.

## End-to-end

Playwright runs Chromium and WebKit:

1. login/required password change;
2. browse and select primary course;
3. create/resume session, learn new item, two initial directions and due review;
4. refresh before/after submit and verify no duplicate XP;
5. view result, profile and weekly challenge board;
6. unlock/start a challenge, submit choice and spelling answers, receive immediate feedback, refresh/retry safely, expire, view result and opt out/in;
7. admin create account;
8. import each format, inspect errors, enrichment review;
9. compose, validate and publish a course; learner sees correct release;
10. failed job inspection and idempotent retry.

## UI and accessibility

- Screenshot baselines for critical states at 390, 768 and 1440px, including leaderboard → quiz → immediate feedback → result and locked/cutoff states.
- Automated axe checks plus manual keyboard, focus restoration, zoom 200%, screen-reader spot checks and reduced-motion checks.
- Enforce no horizontal overflow, 44px mobile targets, logical headings/landmarks and AA contrast.
- Human review rejects decorative gradients, glassmorphism, nested cards, Emoji icons, unfamiliar navigation, meaningless dialogs and competing primary actions.
- Apply Impeccable `critique → distill/quieter → polish`, then Web Design Guidelines; documented Motro rules override external recommendations.

## Performance and capacity

Seed 20 users, 100k course items and 1m review events. Measure home-server-like x86_64/8GB resources. Acceptance: study reads p95 < 500ms and review writes p95 < 700ms under representative concurrency, no full scan on core paths, no lost/duplicate events, bounded DB pool, and imports do not starve study traffic.

## Deployment verification

Compose smoke tests cover fresh install, migrations, restart, readiness, Tailscale route, backup manifest/encryption and empty-environment restore. A release is not accepted until a restore drill proves login, published content, review history, XP and required import files.

## CI gates

Formatting/lint → typecheck → domain/unit → database/integration → OpenAPI diff → build → Playwright/visual/a11y. Provider smoke, capacity and restore drills run on demand/nightly before release rather than every commit.
