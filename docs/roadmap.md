# Roadmap

Each phase exits only when its documented acceptance criteria pass. Dates are intentionally omitted until implementation capacity is known.

## 1. Documentation baseline — current

Deliver product/domain/architecture/API/deployment/test/UI documentation, seven ADRs and pinned UI skills. Initialize local Git. Exit: links and lock file validate; no business code exists.

## 2. Design proof

Use `prototype` for real switchable Home, Study, weekly challenge board and focused quiz prototypes at 390/768/1440. Confirm tokens, learner navigation, card/reveal/rating and quiz-feedback states and accessibility. Run the approved Impeccable and Web Guidelines workflow. Exit: human-approved direction and updated screenshot/decision notes.

## 3. Platform foundation

Scaffold pnpm monorepo, strict TypeScript, CI, Compose development, PostgreSQL + Drizzle migrations, Nest/Fastify API, Next Web, OpenAPI generation, configuration and authentication. The implementation work is split into the one-session tickets in [`platform-foundation`](../.scratch/platform-foundation/spec.md):

- [`01-monorepo-toolchain`](../.scratch/platform-foundation/issues/01-monorepo-toolchain.md)
- [`02-ci-quality-gates`](../.scratch/platform-foundation/issues/02-ci-quality-gates.md)
- [`03-compose-development`](../.scratch/platform-foundation/issues/03-compose-development.md)
- [`04-postgres-migrations`](../.scratch/platform-foundation/issues/04-postgres-migrations.md)
- [`05-configuration-boundary`](../.scratch/platform-foundation/issues/05-configuration-boundary.md)
- [`06-api-shell-openapi`](../.scratch/platform-foundation/issues/06-api-shell-openapi.md)
- [`07-web-shell`](../.scratch/platform-foundation/issues/07-web-shell.md)
- [`08-authentication-backend`](../.scratch/platform-foundation/issues/08-authentication-backend.md)
- [`09-authentication-web-loop`](../.scratch/platform-foundation/issues/09-authentication-web-loop.md)

Exit: admin-created user can securely log in through Web in Compose; no course, study, FSRS, challenge, XP, import or enrichment business feature is implemented in this phase.

## 4. Manual content vertical slice

Accounts, lexical entries, course draft/unit/item authoring, validation and immutable publish. Exit: admin manually publishes one course and learner can browse it; audit and rollback pointer work.

## 5. Learning core

Home plan, course selection, dual flashcards, FSRS v6, idempotent review, session resume, unit unlock and progress. Exit: complete learner E2E plus concurrency/domain tests.

## 6. Content pipeline

Four-format import, stored originals, validation, Wiktionary adapter, DeepSeek adapter, human review and job status. Exit: failures/retries/provenance and rejection paths pass fixtures/E2E.

## 7. Motivation and operations

Versioned game rules, routine XP, levels, tasks, streak/protection, badges, objective challenge attempts/scores/settlement, weekly challenge board and minimal operational metrics. Exit: Beijing-boundary, quiz/idempotency, settlement/adjustment and read-performance tests pass.

## 8. Quality pass

Responsive refinement, accessibility, cross-browser, visual regression, content copy, security review and capacity tuning. Exit: all UI gates and 20-user/100k-item capacity pass.

## 9. Home-server release

Pinned production images, Tailscale HTTPS, monitoring, health, encrypted 30-day backups and restore drill. Exit: fresh install/migrate/restart/backup/empty restore evidence retained.

## 10. Native discovery — after Web stability

Reassess API gaps and offline needs, then independently plan Android, iOS and macOS clients. Do not inherit Web UI implementation; inherit product behavior, domain terms and versioned REST contracts.
