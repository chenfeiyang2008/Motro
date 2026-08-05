# 0006 — Docker Compose, Tailscale and home-server deployment

Status: Accepted  
Date: 2026-08-05

## Context

Motro is private, low-scale and hosted on an x86_64 Linux home server. Public exposure and orchestration complexity would increase security and maintenance burden.

## Decision

Deploy pinned containers with Docker Compose and expose Motro only over Tailscale private HTTPS. Persist PostgreSQL/files on server storage. Run daily encrypted backups to an independent disk/NAS, retain 30 days and prove recovery with empty-environment drills.

## Consequences

- Operation is simple and inexpensive but depends on home infrastructure.
- Tailscale limits reachability but does not replace application authorization.
- Compose, migration, monitoring and restore evidence are release requirements.
- Public signup, CDN and multi-region availability remain out of scope.
