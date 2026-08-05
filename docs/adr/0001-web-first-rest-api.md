# 0001 — Web first with a platform-independent REST API

Status: Accepted  
Date: 2026-08-05

## Context

Motro must deliver useful learning and administration quickly while later Android, iOS and macOS clients remain possible. Multiple native clients now would multiply UI and synchronization work before product behavior is proven.

## Decision

Release one responsive Web learner/admin application first. All business behavior is exposed through a versioned `/api/v1` REST API with generated OpenAPI; Web does not access the database directly. Native clients are deferred and will consume the behavioral contract rather than inherit Web visual implementation.

## Consequences

- One client proves the product with lower initial cost and serves desktop/mobile browsers.
- API boundaries, idempotency and compatibility matter from day one.
- v1 does not promise PWA offline or complete offline synchronization.
- Native-specific capabilities and UI are planned only after Web stability.
