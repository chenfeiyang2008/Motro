# Home Server Deployment

## Target

- x86_64 Linux home server, 4GB RAM target, persistent SSD storage. Daily use is about five people; capacity evidence still covers 20 users, 100k course items and 1m review events.
- Private access through Tailscale HTTPS; no public Internet ingress in v1.
- Docker Compose runs `web`, `api`, `worker`, `postgres` and a private reverse proxy/Tailscale integration as selected during implementation.

## Configuration

Commit only examples and schema. Runtime secrets include database credentials, session secret, DeepSeek key, backup encryption key and Tailscale credentials. Keep them outside Git with owner-only permissions. Configuration validation must fail fast on missing/weak secrets.

Persistent paths:

- PostgreSQL data volume.
- Original import files and necessary generated reports.
- Encrypted backup staging/output.
- Optional local logs with rotation; structured logs should normally go to container stdout.

## Deployment sequence

1. Verify architecture, free disk, memory, clock synchronization and Tailscale connectivity.
2. Pull pinned image digests or build from the tagged private repository commit.
3. Back up database/config/files and verify the backup manifest.
4. Start PostgreSQL, run the dedicated migration job once, then start API/worker/Web.
5. Wait for readiness, run authenticated smoke tests and verify worker queue age.
6. Keep the previous images and backup until the observation window passes.

Do not let every application replica auto-run migrations. A failed migration stops rollout; restoration is chosen using the migration’s runbook, never an automatic destructive rollback.

## Networking and TLS

- Publish services only on the Tailscale/private interface. PostgreSQL and worker have no host-public port.
- Use Tailscale HTTPS/name resolution for browser access. The API accepts proxy headers only from the known reverse proxy.
- Restrict CORS to the Motro origin; prefer same-origin `/api/v1` routing.
- Firewall denies unsolicited WAN traffic. Tailscale ACLs limit learner access and tighter administrative access where practical.

## Backups

Run daily after a consistency checkpoint:

1. Produce a PostgreSQL logical dump suitable for the running major version.
2. Archive runtime configuration needed to reconstruct services, excluding replaceable caches.
3. Archive original/required content files and a manifest of SHA-256 hashes.
4. Encrypt before copying to an independent disk or NAS; never store the decryption key beside backups.
5. Retain 30 daily restore points and alert when the latest verified backup exceeds 36 hours.

Backup success means a restorable artifact, not a zero exit code. Monthly, restore the latest backup into an empty isolated environment, verify migrations, file hashes, login, course read and one non-production study transaction; record duration and evidence.

## Health and operations

- Liveness: process loop responds.
- Readiness: DB reachable, schema version compatible and required storage writable.
- Monitor host disk/RAM, container restarts, HTTP p95/errors, DB connections, job age/failures, supplier failures and backup age.
- Set memory/CPU limits that leave headroom for PostgreSQL and backup jobs. Imports and enrichment use bounded worker concurrency.

## Failure playbooks

- **API/Web restart:** accepted review events remain durable; browser resumes active session.
- **Worker restart:** Graphile Worker retries at-least-once tasks; handlers use application idempotency keys.
- **Supplier outage:** pause/retry affected queues; learning and already published content remain available.
- **Bad release:** move course current pointer to an older immutable release; do not edit snapshots.
- **Database loss/corruption:** isolate, provision empty compatible PostgreSQL, restore latest verified backup, verify hashes/health, then reopen access.
- **Lost Tailscale access:** use local console/LAN administration; do not expose emergency public ports.

## Acceptance evidence

Before v1 release, retain logs/checklists for fresh install, migration, restart during active session, Tailscale HTTPS from learner device, encrypted backup, empty-environment restore and capacity run with 20 users/100k course items.
