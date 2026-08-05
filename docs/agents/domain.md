# Domain Docs

How the engineering skills should consume this project's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files do not exist, proceed silently. The `/domain-modeling` skill creates them when terms or decisions are actually resolved.

## File structure

This is a single-context project:

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When an output names a domain concept, use the term as defined in `CONTEXT.md`. If the needed concept is absent, reconsider whether the project already has a term for it or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If an output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
