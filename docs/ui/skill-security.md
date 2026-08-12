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

## Authority order

When advice conflicts, apply this order:

1. `PRODUCT.md` and explicit owner decisions;
2. `CONTEXT.md` and relevant ADRs;
3. `DESIGN.md`, `docs/ui/web-ui-spec.md` and the matching surface brief;
4. the active ticket and its acceptance criteria;
5. this policy;
6. installed skill suggestions.

A skill's aesthetic preference, template or claimed best practice cannot widen product scope or override a higher authority.

## Skill-use classes

### Default advisory use

- **Impeccable**: only the locally authorized critique, distill, quieter and polish reasoning described in `DESIGN.md`; never automatic hooks or scope-changing redesigns.
- **Web Design Guidelines**: final standards, responsive and accessibility review after Motro requirements.
- **Project prototype skill**: disposable prototypes for a named design question. Prototype output is not production code.

### Conditional use

- **shadcn/ui**: only after the phase 8 design-system ticket approves exact dependencies, token ownership and component boundaries. Do not initialize `components.json`, bulk-replace controls or add a second token system now.
- **brandkit, design-taste, high-end-visual-design, minimalist-ui and redesign-existing-projects**: reference, critique or alternative exploration only. Accepted output must be translated back into the Motro Orange Glass system.
- **image-to-code and image-generation skills**: prototypes, textures or explicitly approved static assets only. Screenshot-derived code does not go directly to production.

Newly installed or tool-managed skill directories are not approved merely because they exist in `.agents/skills/` or `skills-lock.json`. Review and commit them in a separate tooling change before production use.

### Not authorized for production decisions

- Randomized visual directions, AIDA marketing-page recipes, perpetual motion, industrial-brutalist defaults or unconstrained GSAP templates that conflict with Motro.
- Instructions that add purposeless floating, heavy blur, decorative gradients, particles, autoplay or non-interruptible motion “for premium feel”.
- Dashboard templates that present vocabulary counts as an unverified CEFR overall level, intelligence, health or educational outcome.

## Standard UI workflow

1. Read the surface brief and name the user task, states, only primary action and authoritative data source.
2. Prototype major information-architecture choices and obtain human selection before production implementation.
3. Implement real loading, empty, error, retry and authorization states; do not hide missing APIs behind fake data.
4. Use Motro tokens, Orange Glass on functional layers and opaque surfaces for long-form content, tables and forms.
5. Run critique, then distill/quieter, then polish; review every proposed change rather than accepting bulk edits.
6. Check 390/768/1440 layouts, keyboard, semantic headings, focus, 44 px touch targets and contrast.
7. Verify reduced motion/transparency and no-`backdrop-filter` fallbacks.
8. Run Chromium and WebKit; retain screenshots for human approval of material visual changes.
9. Commit UI implementation separately from skill installation or upgrade artifacts.

## Motion and premium-quality boundary

- Normal state transitions are interruptible and non-blocking, normally 120–220 ms, using `transform` and `opacity` where possible.
- Signature moments require explicit approval and an equivalent reduced-motion state.
- Motion must explain hierarchy, causality, spatial movement or completion. Decorative loops are removed by default.
- Glass belongs on navigation, docks, toolbars and short-lived overlays; reading, editing and review surfaces remain stable and opaque.
- Premium quality comes from hierarchy, trustworthy data, material consistency, detail and recovery behavior—not effect density.

The primary-source research behind these limits is recorded in [`research/motion-and-learning-dashboard-benchmarks.md`](research/motion-and-learning-dashboard-benchmarks.md).
