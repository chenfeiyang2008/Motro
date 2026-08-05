# 0004 — FSRS v6, dual independent cards and idempotent reviews

Status: Accepted  
Date: 2026-08-05

## Context

Recognizing English and recalling it from Chinese are different memory tasks. Browser retries can duplicate writes, while reviews drive scheduling and XP.

## Decision

Each user/course item has independent English→Chinese and Chinese→English cards, scheduled by a versioned FSRS v6 adapter. `ReviewEvent` is immutable and uses a user-scoped idempotency key. Event, memory state, XP and session advance commit in one transaction. An item is stable only when both intervals reach 21 days.

## Consequences

- Progress is more faithful but doubles card state and initial reviews.
- Scheduler parameters/version need deterministic fixtures.
- Downstream effects key off the review event for retry safety.
- Offline synchronization is not solved; v1 resumes server-owned sessions.

Reference: [Open Spaced Repetition FSRS](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler).
