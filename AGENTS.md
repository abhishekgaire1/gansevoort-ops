# Coding Agent Rules

This repository is the Gansevoort Operations Platform.

All coding agents must follow these rules.

## Source of Truth

Read:

docs/PRODUCT.md
docs/BUSINESS_RULES.md
docs/DATABASE.md
docs/ARCHITECTURE.md
docs/ROADMAP.md

before making architectural or business-logic changes.

## Non-Negotiable Principles

1. PostgreSQL is the authoritative operational data store.
2. Schema changes use committed migrations.
3. Canonical entities are created once and referenced by ID.
4. External system labels are mappings, not canonical identity.
5. Historical business facts are preserved.
6. Financial calculations use exact numeric types.
7. Important business changes are auditable.
8. OCR results require human verification before authoritative posting.
9. AI analysis must rely on trusted application/database calculations.
10. Do not introduce architecture outside the current milestone without explicit approval.
11. Never commit secrets or plaintext employee PINs.
12. Prefer simple, maintainable architecture for a small development team.

## Scope Control

Current milestone:

Milestone 1 — Inventory MVP.

Do not implement future-roadmap modules unless explicitly instructed.

## Quality

Before considering a task complete:

- Run relevant tests
- Run lint/type checking
- Review migration safety
- Verify business rules
- Summarize changed files
- Call out unresolved assumptions

If documentation and code conflict, do not silently choose one.

Report the conflict.
