# 0002 — TypeScript modular monolith, PostgreSQL and monorepo

Status: Accepted  
Date: 2026-08-05

## Context

The system serves about 20 invited users on an 8GB home server, yet learning, content and jobs need transactional consistency. Microservices/Redis would add operational failure modes without scale benefit.

## Decision

Use a pnpm TypeScript monorepo: Next.js Web, NestJS/Fastify modular-monolith API, separate Graphile Worker process, PostgreSQL, Drizzle and explicit SQL migrations. Modules own their data/use cases and communicate through narrow application interfaces.

## Consequences

- Shared tooling and one database simplify development, transactions and deployment.
- Module boundaries require tests/import rules so the monolith does not become tangled.
- Worker deployment is independently restartable but not a separate business service.
- Future extraction requires measured operational or team need.
