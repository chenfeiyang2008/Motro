# 0003 — Immutable course releases

Status: Accepted  
Date: 2026-08-05

## Context

Learners need stable displayed content and historical meaning while administrators continue editing. Updating published rows in place would make past reviews ambiguous and risk breaking progress.

## Decision

Authors edit a course draft. Publishing creates a complete immutable release snapshot with a monotonically increasing version and stable unit/course-item IDs. Correction creates a new release or moves the current pointer to an existing release.

## Consequences

- Learning/audit history identifies the exact content shown.
- Releases use extra storage, acceptable for v1.
- Publish validation/materialization must be atomic.
- Stable identity is preserved deliberately; replacement creates new identity.
