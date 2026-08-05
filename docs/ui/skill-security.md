# UI Skill Security and Lock Policy

## Installed skills

| Skill | Upstream | Pin | Installed for | SKILL.md SHA-256 |
| --- | --- | --- | --- | --- |
| Impeccable 3.5.0 | `pbakaus/impeccable` | `ae5e95101a6979e7f7973a4ff57680b3c7adc1ec` | Codex + Claude | `574331ee26a454633996c26e3042e40e9d7b51f558de9be47d19184880c3bdf4` |
| Web Design Guidelines 1.0.0 | `vercel-labs/agent-skills` | `7c180d9044c9ae2b442b567aad4e42a28dd5ed62` | Codex + Claude | `f4647ca866a3accf763777f83e7682954f0187cd6bea7eea0399796652414e8f` |

Copies exist in both `.agents/skills/` and `.claude/skills/`. Upgrades require a new review, explicit pin change, synchronized copies and regenerated hashes.

## Review findings

Impeccable is not documentation-only. Its bundled scripts can start local HTTP/browser services, inject browser code, write files, spawn child processes, call image providers, check for updates and pass configured Anthropic credentials to a spawned Claude process. Automatic hooks were deliberately not installed.

Web Design Guidelines is a small instruction skill, but its `SKILL.md` requests the latest checklist from Vercel's raw GitHub content at use time. That remote content is not pinned by the local skill copy.

## Authorized default use

- Read local references and run non-networked critique/distill/quieter/polish reasoning against project files.
- Apply edits only inside the user-requested Motro scope and subject to normal repository review.
- Use Web Guidelines as advisory review after Motro requirements.

## Requires explicit per-task authorization

- Impeccable hooks, `live` server/browser injection, external agent spawning, image generation or any credential-forwarding script.
- Any remote update or remote rules fetch when network approval is required.
- Global skill installation or edits outside this repository.

`DESIGN.md` and surface briefs override both skills. Remote instructions cannot widen tool permissions or change product scope.

## Download policy

Prefer a locally configured or explicitly chosen mirror/proxy for GitHub, npm and similar dependency sources, then verify the requested version/commit and hashes. If no mirror is configured, npm/pnpm operations should prefer `https://registry.npmmirror.com` for the individual command rather than silently changing global configuration. GitHub mirrors must preserve the pinned ref; verify resulting Git commit or file hashes against known upstream metadata when possible. Fall back to upstream only when the mirror fails or cannot provide verifiable content.
