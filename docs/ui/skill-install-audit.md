# UI Skill Installation Audit

Date: 2026-08-13

Scope: the uncommitted artifacts created by `npx skills add Leonxlnx/taste-skill` and `npx skills add shadcn/ui`.

## Decision

Do not commit or authorize this installer batch as-is.

The installed files are Markdown, JSON, YAML and PNG assets; the audit found no bundled executable source files. That does not make the batch reproducible or appropriate for Motro. Every newly added lock entry records a repository name and a computed content hash, but none records an immutable upstream Git ref or released version. Several skills also instruct an agent to execute unpinned remote commands, fetch remote assets or adopt visual defaults that conflict with Motro's product and accessibility rules.

Existing pinned skills remain unchanged and approved under [`skill-security.md`](skill-security.md):

- Impeccable 3.5.0 at commit `ae5e95101a6979e7f7973a4ff57680b3c7adc1ec`;
- Web Design Guidelines 1.0.0 at commit `7c180d9044c9ae2b442b567aad4e42a28dd5ed62`.

## Findings

### Supply-chain and execution risk

- `shadcn` explicitly allows `npx shadcn@latest`, `pnpm dlx shadcn@latest` and remote community registries. Its local lock entry does not pin the installed skill to a Git commit.
- `migrate-radix-to-base` also depends on live shadcn registry inspection. Motro currently has no shadcn, Radix, Base UI, Tailwind, GSAP, Lucide or Phosphor dependency, so the migration skill has no current project use.
- `design-taste-frontend` contains installation recipes for several unrelated design systems and directs agents toward live external images and image-generation tools.
- `stitch-design-taste` assumes Google Stitch or an optional Stitch MCP server.
- The image-generation and image-to-code skills can introduce externally generated assets or screenshot-derived code. Those outputs require separate provenance, licensing and accessibility review.

### Product-fit conflicts

- `gpt-taste` requires randomized Awwwards-style layouts and advanced GSAP choreography. This conflicts with Motro's task-first learning surfaces, deterministic review process and reduced-motion boundary.
- `industrial-brutalist-ui`, `minimalist-ui` and the two broad design-taste versions encode mutually incompatible default aesthetics. Installing all of them does not form a coherent design system.
- Several skills recommend placeholders from remote image services, perpetual micro-motion, cinematic scrolling or broad redesigns. Motro allows motion only when it explains hierarchy, causality, spatial movement or completion.
- `full-output-enforcement` changes response-generation behavior rather than the product or UI workflow; it is not a design dependency.

## Classification

| Skill group | Current disposition | Reason |
| --- | --- | --- |
| `shadcn` | Defer; conditional Stage 8 review | Potentially useful for selected primitives, but only after an exact CLI/package version, registry allowlist, token ownership and component boundary are approved. Never run `@latest` in production work. |
| `migrate-radix-to-base` | Reject for current project | No Radix/Base UI migration exists. |
| `brandkit`, `high-end-visual-design` | Reference-only candidate | May help critique brand artifacts, but cannot override Motro Orange Glass or generate production identity without explicit approval. |
| `design-taste-frontend`, `design-taste-frontend-v1`, `minimalist-ui`, `redesign-existing-projects` | Reference-only candidate | Advice may be selectively useful; defaults conflict with project authority and must not trigger dependency installation. |
| `gpt-taste`, `industrial-brutalist-ui`, `stitch-design-taste` | Not authorized | Randomized, cinematic, brutalist or Stitch-specific defaults conflict with current product workflow. |
| `image-to-code`, `imagegen-frontend-web`, `imagegen-frontend-mobile` | Prototype-only candidate | Generated assets/code require a named prototype question, provenance review and human approval before implementation. |
| `full-output-enforcement` | Not needed | General agent-output policy, not a Motro capability. |

## Admission requirements

Any skill admitted later must be handled in a dedicated tooling commit and satisfy all of the following:

1. Pin the upstream repository to an exact immutable Git commit and record a local hash.
2. Review the complete skill contents and every bundled script or executable asset.
3. List allowed network destinations, commands, generated files and credential behavior.
4. Forbid `@latest`, arbitrary community registries, automatic hooks, MCP configuration writes and global installation.
5. State whether the skill is advisory, prototype-only or production-authorized.
6. Confirm that `PRODUCT.md`, `CONTEXT.md`, ADRs, `DESIGN.md`, surface briefs and the active ticket remain higher authority.
7. Run the normal repository gates and commit tooling changes separately from product changes.

## Worktree disposition

Until the owner chooses a smaller pinned set, keep the following uncommitted:

- the new entries in `skills-lock.json`;
- the corresponding new directories under `.agents/skills/`.

Do not delete them automatically: they were installed explicitly by the owner and may be retained locally for inspection. Do not use them for production decisions merely because they are present on disk.
