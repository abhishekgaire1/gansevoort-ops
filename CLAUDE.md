# Claude Code Instructions — Gansevoort Operations Platform

You are working on a real operational platform for Gansevoort Liberty Market.

Before implementing a feature, read the relevant files in /docs.

Required source-of-truth documents:

- docs/PRODUCT.md
- docs/BUSINESS_RULES.md
- docs/DATABASE.md
- docs/ARCHITECTURE.md
- docs/ROADMAP.md

## Core Rules

Do not invent product requirements.

Do not create duplicate business concepts.

Do not add a new database table merely because it is convenient. Check DATABASE.md first.

Do not modify business rules silently.

Do not overwrite historical recipe, price, pay-rate, or cost data when versioning/history is required.

Do not treat external-system names as canonical identities.

Do not use floating point for financial values.

Do not commit secrets.

Do not bypass audit requirements.

Do not let OCR post authoritative transactions directly.

Do not give AI unrestricted database authority.

Do not introduce microservices or unnecessary infrastructure.

## Working Style

For non-trivial features:

1. Read relevant documentation.
2. Inspect existing code/schema.
3. Produce a concise implementation plan.
4. Identify files/tables that will change.
5. Call out any conflict with documented architecture.
6. Implement the smallest coherent scope.
7. Add/update tests.
8. Run tests/lint/typecheck.
9. Summarize what changed.
10. Do not automatically expand into the next milestone.

Prefer small commits and reviewable changes.

## Database

All schema changes must use version-controlled Supabase migrations.

Never rely on undocumented manual dashboard changes.

Use UUID internal IDs.

Use NUMERIC for money and exact quantities.

Use TIMESTAMPTZ for event timestamps.

Use foreign keys and database constraints where they protect business integrity.

Use transactions for multi-record authoritative operations when practical.

## Current Priority

The current product priority is Milestone 1 — Inventory MVP.

Do not build purchasing, OCR, AI, ML, payroll, or unrelated future modules unless explicitly requested.

The first operational workflow is:

Employee PIN
→ Select station
→ Select canonical inventory item
→ Enter package/quantity/weight
→ Record withdrawal
→ Write audit event
→ Generate exception if threshold is exceeded
→ Show manager withdrawal history

## When Unsure

Stop and explain the ambiguity.

Do not make irreversible architectural decisions based on guesses.
