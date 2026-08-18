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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
