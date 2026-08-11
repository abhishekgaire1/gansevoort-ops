# Technical Architecture

## Current Stack

Frontend / Application:
Next.js
TypeScript
React
Tailwind CSS

Backend foundation:
Supabase

Database:
PostgreSQL

Authentication:
Supabase Auth plus application-level employee PIN workflow where appropriate

File storage:
Supabase Storage initially

Version control:
Git + GitHub

Development environment:
Cursor

Primary coding agent:
Claude Code

## Future Services

Invoice/document extraction:
Google Document AI or equivalent document-understanding service

AI analyst:
OpenAI API and/or other approved model provider through controlled application tools

ML/forecasting:
Python introduced when clean operational history exists

Do not introduce Python merely because ML may exist later.

## Development Philosophy

Prefer the simplest architecture that safely supports current requirements.

Do not prematurely create:

- Microservices
- Kubernetes
- Separate databases per domain
- Complex event buses
- Dedicated search infrastructure
- Dedicated ML infrastructure

Add infrastructure only when a demonstrated requirement exists.

## Database Access

PostgreSQL is the source of truth.

Schema is managed through Supabase migrations committed to Git.

Do not manually make untracked schema changes in the Supabase dashboard.

## Security

Never commit:

- Database passwords
- Service-role keys
- API secrets
- OAuth secrets
- Employee PINs
- Private credentials

Use environment variables.

Local environment files must remain Git-ignored.

Use Row Level Security where appropriate.

Use least-privilege access.

## Server vs Client

Sensitive business logic must run server-side.

Do not expose service-role credentials to browser/client code.

Client-side code must not be trusted to enforce financial, inventory, review, or permission rules.

## Transactions

Business actions that modify multiple authoritative records should be atomic when practical.

Example:

Inventory withdrawal
→ inventory movement
→ movement line
→ audit event

should succeed or fail as one logical operation.

## Integrations

External integrations include:

Peblla
Uber Eats
Intuit
Legacy inventory imports
Invoice/document processing

Each integration requires:

- Import/run logging
- Error handling
- Source identifiers
- Retry-safe/idempotent behavior where possible
- Integration health visibility

## Import Philosophy

Never silently discard malformed records.

Invalid/unmapped records should be retained in staging or exception workflows.

Imports should be safe to rerun without generating duplicate authoritative data.

## OCR Architecture

Document upload
→ Original document retained
→ OCR/document extraction
→ Structured draft data
→ Canonical item mapping
→ Receiving/system verification
→ Exceptions resolved
→ Posted transaction

OCR must never directly write authoritative inventory/cost transactions without required human review.

## AI Architecture

AI does not receive unrestricted authority over the database.

Expose controlled application tools such as:

get_sales
get_food_cost
get_vendor_price_history
get_inventory_withdrawals
get_open_exceptions
get_invoice
compare_periods
get_menu_margin

Application code performs calculations.

AI explains results and recommends actions.

Material AI claims should carry supporting evidence.

## ML Architecture

ML is not part of the first development milestone.

When introduced, forecasting should primarily predict demand.

Purchase recommendations are derived from:

forecast demand
+ recipe requirements
+ available inventory data
+ outstanding purchase orders
+ safety stock
+ vendor lead times
+ pack sizes

Do not train a model merely to imitate historical purchase orders.

## Testing

Each implemented business rule should have automated coverage where practical.

Importers should use real sanitized sample exports as fixtures.

Database migrations require validation.

Critical calculations require deterministic tests.

## Git Workflow

Work in small, reviewable changes.

Before major feature implementation:

1. Read relevant documentation.
2. Produce an implementation plan.
3. Confirm existing schema/business rules.
4. Implement the smallest coherent feature.
5. Run tests.
6. Review diff.
7. Commit.

Avoid large uncontrolled AI-generated rewrites.
