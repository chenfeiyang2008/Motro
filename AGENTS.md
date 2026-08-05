## Agent skills

### Issue tracker

Issues and specifications are tracked as local Markdown files in `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default canonical triage labels are used for local issues. See `docs/agents/triage-labels.md`.

### Domain docs

This project uses a single-context documentation layout. See `docs/agents/domain.md`.

### Product and design

Before product or UI work, read `PRODUCT.md`, `CONTEXT.md`, `DESIGN.md`, the matching file under `docs/ui/surfaces/`, and relevant ADRs. Project documents override external skills.

Impeccable automatic hooks, live/browser injection, external-agent spawning and image generation are disabled unless the user explicitly authorizes them for the current task. See `docs/ui/skill-security.md`.

### External downloads

Prefer an available mirror/proxy for GitHub, npm and similar sources. Pin versions or Git commits and verify hashes/refs after download. If no registry mirror is configured, prefer `https://registry.npmmirror.com` per command rather than modifying global user configuration. Fall back to upstream only when needed.
