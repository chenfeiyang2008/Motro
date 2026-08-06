# REST API Contract

## 1. Contract rules

- Base path: `/api/v1`; JSON UTF-8 unless an endpoint explicitly streams a file.
- Browser authenticates with a Secure, HttpOnly session cookie. Unsafe methods require same-origin/CSRF protection.
- Server timestamps are RFC 3339 UTC; local dates are `YYYY-MM-DD` plus the timezone used.
- IDs are opaque UUID strings. Clients must not infer ordering or type from IDs.
- `Idempotency-Key` is required for review submission, publish, account creation/reset and explicit job retry. The server scopes and persists keys per actor/operation.
- OpenAPI 3 is generated from Nest DTOs, linted, diffed in CI and used to generate client types. Human semantics in this document remain authoritative.

## 2. Common shapes

Success returns the resource directly or `{ "items": [], "page": { "cursor": null, "hasMore": false } }`. Cursor pagination is preferred for event/job queues; stable small catalogs may use bounded page/limit.

Errors use:

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "该请求键已用于不同的评分。",
    "requestId": "req_...",
    "fieldErrors": [{ "path": "rating", "code": "invalid" }],
    "retryable": false
  }
}
```

Expected status codes: `400` malformed, `401` unauthenticated, `403` unauthorized, `404` absent/hidden, `409` state/idempotency conflict, `422` valid JSON but failed domain validation, `429` rate limited, `503` temporarily unavailable. Never return stack traces or supplier secrets.

## 3. Auth

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/login` | Establish and rotate session cookie |
| `POST` | `/auth/logout` | Revoke current session |
| `GET` | `/auth/me` | Current account, role and settings |
| `POST` | `/auth/change-password` | Change initial/current password and revoke other sessions |
| `GET` | `/auth/sessions` | List active session summaries |
| `DELETE` | `/auth/sessions/{id}` | Revoke one owned session |

Login is rate-limited and returns the same public failure for unknown user and wrong password.

## 4. Learner catalog

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/catalog/courses` | Visible published courses with enrollment summary |
| `GET` | `/catalog/courses/{courseId}` | Course, units, lock state and progress |
| `POST` | `/catalog/courses/{courseId}/enroll` | Join a course; optional make-primary flag |
| `PUT` | `/catalog/primary-course` | Atomically select enrolled primary course |

Course responses expose release ID/number so clients can display consistent content. They do not expose mutable drafts. Both `GET /catalog/courses` and `GET /catalog/courses/{courseId}` include the current user's own `isEnrolled` and `isPrimary` state; a course with no current release, or not published, is hidden (detail returns `404`).

`POST /catalog/courses/{courseId}/enroll` is idempotent: joining an already-joined course returns the existing enrollment (`200`, no duplicate row) and never downgrades an existing primary. Optional body `{ "makePrimary": true }` joins and sets the course as primary atomically; the response is the course detail. Hidden or no-current-release courses return `404`.

`PUT /catalog/primary-course` takes `{ "courseId" }` of an enrolled course and atomically clears the previous primary before setting the new one in one transaction. Only the current user's own enrollment may be selected. Not-yet-enrolled returns `409`; hidden or no-current-release returns `404`. Exactly one active primary per user is guaranteed by a partial unique index; concurrent switches serialize on the server so the last committed switch wins. Switching never deletes other enrollments or their future learning history. Responses never include other users' enrollment data.

## 5. Study

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/study/today` | Today summary, budget, due/new counts and completion state |
| `POST` | `/study/sessions` | Resume active or create server-planned session |
| `GET` | `/study/sessions/{sessionId}` | Session progress and current item |
| `POST` | `/study/sessions/{sessionId}/items/{itemId}/reveal` | Optional auditable reveal; no review event/XP |
| `POST` | `/study/sessions/{sessionId}/reviews` | Submit one rating with idempotency key |
| `POST` | `/study/sessions/{sessionId}/abandon` | Close an active session explicitly |
| `GET` | `/study/sessions/{sessionId}/result` | Accepted-event totals and next action eligibility |

Review request:

```json
{
  "clientEventId": "019...",
  "sessionItemId": "019...",
  "cardId": "019...",
  "rating": "good",
  "revealedAt": "2026-08-05T10:00:03.000Z",
  "answeredAt": "2026-08-05T10:00:07.000Z"
}
```

Response includes `reviewEventId`, authoritative next-due/memory summary, `xpAwarded`, updated session counters and next item/result link. Reusing the same key/body returns the same response; same key with changed semantics returns `409`.

The client may cache the current rendered item for transient recovery but v1 has no offline queue or background synchronization guarantee.

## 6. Game, weekly challenge and profile

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/game/summary` | Level, daily-study XP, streak, active tasks and recent badges; not a rank source |
| `GET` | `/game/leaderboard/weekly` | Public challenge points, rank, time current score was reached, Beijing week boundary/cutoff and participation state |
| `GET` | `/game/challenge/weekly` | Viewer challenge points, distinct score-eligible words, estimated weekly growth XP, countdown and unlock/start state |
| `POST` | `/game/challenge/attempts` | Idempotently create or recover one 10-question, five-minute challenge attempt |
| `GET` | `/game/challenge/attempts/{id}` | Current question and remaining time; never pre-reveals answers |
| `POST` | `/game/challenge/attempts/{id}/responses` | Idempotently submit exactly one response and receive immediate grading/score/rank summary |
| `GET` | `/game/challenge/attempts/{id}/result` | Correct count, new challenge points and scored/review question breakdown |
| `GET` | `/profile` | Profile and preference values including public-board participation |
| `PATCH` | `/profile` | Update display name, timezone, daily budget or public challenge-board participation |

`GET /game/leaderboard/weekly` returns only challenge points for ranking, never routine-study XP. It includes `weekStartsAt`, `weekEndsAt`, `startClosedAt`, `tieBreak: first_reached_current_score_then_user_id`, a viewer row even when opted out, and only public users in the displayed list.

Attempt creation requires an idempotency key, at least 10 distinct exposed lexical entries, and a time before Sunday 23:55 `Asia/Shanghai`. It returns or resumes the active attempt and `maxPotentialPoints`; no second active attempt is created. Question snapshots always contain 10 distinct lexical entries, five directions each way, with source course and score-eligibility displayed but no answer exposed.

A response body contains `questionId`, answer value and `clientResponseId`. The response validates the fixed week/expiry and snapshot, locks the question, stores the immutable response, grades it, then inserts the unique first-correct score fact if eligible. It returns `correct`, `correctAnswer`, `awardedChallengePoints` (`0|5`), updated personal points and a small rank summary. Retry with the same key/body returns the original result; changed semantics return `409`.

Chinese→English spelling comparison uses Unicode normalization, lowercase and outer-trim only. Internal required spaces/hyphens remain exact. The accepted set is the snapshot's canonical spelling plus administrator-approved aliases; no fuzzy or AI evaluation occurs. Timeout ends the attempt and later writes return its final state.

Timezone changes are validated/rate-limited and affect future personal calculations; challenge-week time is always Beijing time and does not change with profile timezone.

## 7. Admin accounts

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/admin/users` | List/create invited accounts |
| `GET/PATCH` | `/admin/users/{id}` | Inspect/update safe account fields |
| `POST` | `/admin/users/{id}/disable` | Disable and revoke sessions |
| `POST` | `/admin/users/{id}/reset-password` | Issue one-time credential |

One-time passwords are returned once and excluded from logs/audit payloads.

## 8. Admin content and import

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/admin/lexical-entries` | Search/create entries |
| `GET` | `/admin/lexical-entries/{id}` | Read entry facts and source provenance |
| `POST` | `/admin/imports` | Multipart upload and create batch |
| `GET/PATCH` | `/admin/imports/{id}` | Read status/set mapping/source declaration |
| `POST` | `/admin/imports/{id}/validate` | Enqueue parsing/validation |
| `GET` | `/admin/imports/{id}/rows` | Paginated rows/errors |
| `POST` | `/admin/imports/{id}/commit` | Commit valid row decisions/enqueue enrichment |
| `GET` | `/admin/imports/{id}/error-report` | Stream generated error report |
| `GET` | `/admin/reviews` | Pending enrichment review queue |
| `GET` | `/admin/reviews/{draftId}` | Draft, source and history |
| `POST` | `/admin/reviews/{draftId}/decision` | Accept/edit/reject with optimistic version |

Uploads enforce configured byte/row limits and do not trust browser MIME. Long work returns `202` with operation/job links.

## 9. Admin course and publishing

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/admin/courses` | List/create stable courses |
| `GET/PATCH` | `/admin/courses/{id}/draft` | Read/update metadata with draft version |
| `POST/PATCH/DELETE` | `/admin/courses/{id}/draft/units...` | Unit commands |
| `POST/PATCH/DELETE` | `/admin/courses/{id}/draft/items...` | Course-item commands |
| `POST` | `/admin/courses/{id}/draft/reorder` | Accessible deterministic reorder command |
| `POST` | `/admin/courses/{id}/validate` | Publish readiness and diff |
| `POST` | `/admin/courses/{id}/releases` | Create immutable release |
| `POST` | `/admin/game/challenge-score-adjustments` | Append audited challenge-score void or compensation; never edit a total |
| `GET` | `/admin/courses/{id}/releases` | Version history |
| `PUT` | `/admin/courses/{id}/current-release` | Move current pointer to an existing release |

Draft mutations require `If-Match` or explicit `draftVersion`; stale changes return `409 DRAFT_VERSION_CONFLICT`. Publish requires an idempotency key and exact validated draft version.

## 10. Operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/operations/jobs` | Sanitized status list |
| `GET` | `/operations/jobs/{id}` | Progress, attempts and last safe error |
| `POST` | `/operations/jobs/{id}/retry` | Idempotently retry eligible failed job |
| `GET` | `/operations/health-summary` | Admin-safe dependency/backup age summary |

Operational endpoints require admin role. Raw Graphile Worker tables and provider payloads are never exposed directly.

## 11. Contract compatibility

- Additive optional fields and endpoints are backward-compatible within v1. Existing enum expansion must be treated as potentially breaking by generated clients.
- Removing/renaming fields, changing meaning or tightening required input requires `/api/v2` or a documented migration window.
- Contract tests compare the generated OpenAPI artifact and run a generated client against the API. Future native clients pin an OpenAPI version and send an app version header for diagnostics.

## Reference

[NestJS OpenAPI](https://docs.nestjs.com/openapi/introduction) documents generation of a serializable OpenAPI document from Nest routes and DTO metadata.
