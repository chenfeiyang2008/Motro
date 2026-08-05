# Architecture Overview

## 1. System shape

Motro v1 is a TypeScript modular monolith in a pnpm monorepo. The browser uses a versioned REST API; it never reads PostgreSQL directly. One repository and one primary database keep operation simple for a 20-user home-server deployment, while explicit module boundaries and platform-neutral API contracts leave room for later native clients.

```text
Browser (learner + admin)
        │ HTTPS /api/v1
        ▼
Next.js Web ──────────────► NestJS + Fastify API
                                  │
                     ┌────────────┼─────────────┐
                     ▼            ▼             ▼
                PostgreSQL   Graphile Worker  Object files
                                  │          (imports/backups)
                           Wiktionary / DeepSeek
```

Tailscale provides private network reachability and HTTPS. The application remains responsible for authentication, authorization, CSRF, validation, rate limits and audit logs; Tailscale is not an authorization substitute.

## 2. Proposed monorepo

```text
apps/
  web/                 # Next.js learner and admin routes
  api/                 # NestJS/Fastify HTTP application
  worker/              # Graphile Worker process and task registry
packages/
  contracts/           # generated API client/types; no server internals
  domain/              # pure domain policies and value objects
  db/                  # Drizzle schema, repositories, explicit SQL migrations
  scheduling/          # FSRS adapter, parameter versions, deterministic tests
  ui/                  # learner primitives and Motro tokens
  config/              # typed runtime configuration loaders
infra/
  compose/             # Docker Compose and service configuration
  backup/              # backup/restore scripts and runbooks
```

This is a target layout, not authorization to scaffold code during the documentation phase.

## 3. Runtime components

### Web

- Next.js responsive application with separate learner and `/admin` route groups.
- Learner UI uses Tailwind plus project-owned components; admin uses Ant Design mapped to Motro tokens.
- Server rendering may read the API through an internal service URL, but all business mutations and authorization still pass through REST controllers.
- No service worker, offline cache or database access in v1. A refresh resumes the server-owned study session.

### API

- NestJS on Fastify with global `/api/v1` prefix.
- Modules: `auth`, `catalog`, `study`, `admin`, `game`, `operations`.
- Controllers translate HTTP to application commands/queries. Domain policies do not depend on Nest, Drizzle or Web types.
- OpenAPI is generated from controllers/DTOs and checked into CI as a reviewable artifact. Production exposes raw schema only to authorized operators or disables it entirely.

### Database

- PostgreSQL is the source of truth for content, identity, learning, rewards, audit and background jobs.
- Drizzle provides typed access; explicit ordered SQL migrations are the deployment contract.
- Constraints enforce uniqueness, immutability and idempotency. Transactions cover review+schedule+XP, publish snapshot creation and job enqueueing.
- Application tables use UTC `timestamptz`; user-local dates are derived with an IANA timezone and persisted only when they are business facts such as a streak day.

### Worker

- A separate Node process runs Graphile Worker task handlers against the same PostgreSQL database.
- Tasks: parse/import, Wiktionary lookup, DeepSeek drafting, release materialization where needed, leaderboard/statistics maintenance and retention cleanup.
- Graphile Worker provides at-least-once execution and exponential retry; every handler therefore has an application idempotency key and records external calls/results.
- Named queues cap supplier concurrency. No Redis is introduced in v1.

### File storage

- Original imports and required derived reports live in a configured server directory mounted into API/worker containers. Metadata and SHA-256 live in PostgreSQL.
- File paths are opaque IDs in the API. Validate size/MIME/content, generate server-side filenames and prevent path traversal.
- Files needed to reproduce or audit released content are included in encrypted backups.

## 4. Module ownership

| Module | Owns | May call |
| --- | --- | --- |
| `auth` | users, credentials, sessions, roles | audit |
| `catalog` | lexical entries, courses, releases, enrollment | audit, jobs |
| `study` | daily plans, sessions, cards, review events, FSRS state | catalog read model, game command |
| `game` | XP ledger, levels, streaks, quests, badges, leaderboard | study event facts, rulesets |
| `admin` | account/content use cases and review decisions | auth, catalog, operations |
| `operations` | imports, enrichment, job status, files, audit | catalog commands, external adapters |

Modules communicate through narrow application interfaces and IDs, not by importing another module's database tables into arbitrary queries. Cross-module reporting uses explicit read models.

## 5. Critical consistency boundaries

### Review submission

One database transaction: lock/read card → claim idempotency key → validate session/card → append `ReviewEvent` → calculate/persist new memory state → append eligible XP ledger entry → advance session cursor → commit. Retrying the same key returns the committed result.

### Course publishing

One transaction: lock course draft → validate complete draft → allocate release number → copy immutable unit/item snapshots with stable course-item IDs → write release record → update course current-release pointer → enqueue post-publish work → commit.

### Import and enrichment

Upload creates a durable batch and file record first. Parsing and supplier calls run asynchronously per row/chunk. Accepted drafts update reusable entries through audited commands; failures never roll back successful independent rows.

## 6. Security baseline

- Argon2id credential hashing with parameters stored per hash and periodically reviewed.
- Random opaque server sessions stored hashed, delivered only via Secure/HttpOnly/SameSite cookies; rotate after login/password/privilege changes.
- CSRF tokens or strict same-origin request validation on mutations, plus origin checks and content-type enforcement.
- Role guards in API, never only hidden UI. Admin mutations create audit records.
- Login and expensive endpoints are rate-limited per account/IP. DeepSeek credentials and backup keys are secrets, never client environment variables.
- Validate all uploads and supplier data as untrusted. Escape rendered content and apply a restrictive CSP.

## 7. Observability and health

- Structured JSON logs with request ID, actor ID (not credentials), module, outcome and latency.
- `/health/live` checks process responsiveness; `/health/ready` checks database/migrations and required storage, but not optional supplier uptime.
- Metrics include HTTP latency/error rate, active DB connections, worker queue age/failures, supplier latency, review conflicts and backup age.
- Audit logs are append-only application facts separate from debug logs.

## 8. Architectural constraints

- No microservices, Redis, GraphQL, direct Web-to-DB connection or native-client-specific endpoints in v1.
- No business decisions in React components or controllers; scheduling and game rules must be deterministic domain services.
- No mutable published content and no deleting review/XP facts to “fix” derived state; corrections are explicit compensating facts or rebuilds.
- Later native apps consume `/api/v1` or a successor and inherit behavior/contracts, not Tailwind/Ant Design implementation.

## References

- [Graphile Worker documentation](https://worker.graphile.org/docs)
- [NestJS OpenAPI documentation](https://docs.nestjs.com/openapi/introduction)
- [Architecture decision records](../adr/README.md)
