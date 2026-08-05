# 0005 — Wiktionary facts, DeepSeek drafts and mandatory human review

Status: Accepted  
Date: 2026-08-05

## Context

Imports require only English spelling. Learner-ready bilingual content needs traceable facts and efficient Chinese drafting, but automated sources can be incomplete, wrong or license-sensitive.

## Decision

Use English Wiktionary with revision/license provenance for English data. Use the official DeepSeek API for Simplified Chinese drafts from source facts and course context. An administrator must accept, edit-accept or reject every draft before release.

## Consequences

- Automation assists but never publishes.
- Source, prompt/model metadata, hashes and review decisions are retained.
- Supplier failures become retryable/manual states without blocking other rows.
- The owner remains responsible for import rights and required attribution.

Reference: [DeepSeek API](https://api-docs.deepseek.com/).
