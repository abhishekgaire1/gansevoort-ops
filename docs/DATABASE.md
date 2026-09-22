# Database Architecture

## Database

PostgreSQL hosted by Supabase.

The database is the authoritative operational data store.

Database schema changes must be performed through version-controlled migrations.

Do not manually create production schema through the Supabase dashboard.

## Architectural Style

Use a modular monolith.

Do not introduce microservices unless scale or operational requirements clearly justify them.

## Core Domains

### Organization

organizations
locations
stations
sales_categories
storage_locations

### Identity and Access

employees
app_users
roles
user_roles
role_permissions

Employee PINs must be securely hashed.

Never store plaintext PINs.

### Inventory Master

inventory_categories
inventory_items
units
inventory_item_units

Inventory items use canonical internal identities.

Do not use vendor descriptions as canonical inventory identities.

### Vendors

vendors
vendor_items
vendor_item_aliases
vendor_item_pack_versions

Vendor aliases and vendor SKUs map to canonical inventory items.

Vendors carry a classification (INVENTORY or NON_INVENTORY). It is an
identity label and a classification default, never a restriction on
what the vendor's lines may be classified as.

### Purchasing

purchase_orders
purchase_order_lines
receipts
receipt_lines
receiving_reviews

### Documents and Invoices

documents
document_extractions
invoices
invoice_lines
invoice_system_reviews
invoice_match_results
duplicate_candidates

purchase_document_line_classifications carries the authoritative
**line treatment** for every invoice line (20260811100182):
INVENTORY_PURCHASE, EXPENSE, FREIGHT_FEE, TAX, DISCOUNT, CREDIT_RETURN
(with credit_subtype FINANCIAL_CREDIT / RETURNABLE_CONTAINER_CREDIT /
INVENTORY_RETURN) or UNRESOLVED. The coarse disposition column
(INVENTORY / NON_INVENTORY / UNRESOLVED) is derived from the treatment by
a trigger and kept only for existing consumers; the two can never
disagree (CHECK constraint). UNRESOLVED is never a valid posting
classification. AI/rule proposals are stored beside the decision
(ai_proposed_treatment, ai_proposed_credit_subtype,
ai_proposed_spend_category_id, ai_reason, ai_evidence, ai_review_fields)
so the manager's change is always visible next to what was proposed.

vendor_line_treatment_rules -- organization-scoped, vendor-specific
prior decisions for non-item lines (vendor + SKU or normalized
description -> treatment + category/subtype). Created only when a
manager explicitly chooses to remember a decision, auditable, Admin-
editable (deactivate), ignored automatically when the referenced expense
category is deactivated, and never applied when it contradicts the
current line's own evidence.

purchase_document_inventory_return_lines -- links an INVENTORY_RETURN
credit line to the VENDOR_RETURN movement it posted (append-only;
classification_id UNIQUE is the idempotency backbone, like
receipt_line_id on purchase_document_inventory_posting_lines).

Original uploaded files must be retained.

OCR results must be preserved separately from corrected/approved values.

### Vendor Claims

vendor_claims

### Inventory Transactions

inventory_movements
inventory_movement_lines
inventory_counts
inventory_count_lines
waste_details

Inventory movements must use explicit movement types.

Never infer business meaning from positive/negative quantity signs.

Movement types currently enforced by the schema (CHECK constraint,
20260811100182):

PURCHASE_RECEIPT (inbound)
ISSUE_TO_STATION (outbound)
TRANSFER_IN / TRANSFER_OUT
WASTE (outbound)
COUNT_ADJUSTMENT_IN / COUNT_ADJUSTMENT_OUT
INVENTORY_CORRECTION_IN / INVENTORY_CORRECTION_OUT
VENDOR_RETURN (outbound -- tracked merchandise physically returned to a
vendor, posted from an INVENTORY_RETURN credit line; never a negative
receipt)

Planned, not yet in the schema: STATION_TRANSFER, RETURN_TO_CENTRAL,
BATCH_INPUT, BATCH_OUTPUT, LEGACY_IMPORT.

V1 does not require authoritative station inventory balances.

### Menu and Recipes

menu_items
menu_item_variants
menu_modifiers
recipes
recipe_versions
recipe_components
menu_variant_recipes
modifier_recipes
production_batches
menu_price_history

Recipe history must be versioned using effective date ranges.

### Sales

external_systems
pos_stores
sales_orders
sales_order_items
sales_order_item_modifiers
daily_item_sales
payment_transactions

Aggregate Peblla files may populate daily_item_sales until full order-item data is available.

### Labor

timecards
timecard_breaks
employee_pay_rates
payroll_periods
payroll_earnings

Detailed station labor allocation is not required in V1.

### Controls

control_rules
exceptions
audit_events
master_data_change_requests

### Collaboration

comments
comment_mentions

### Integrations

integration_runs
import_batches
external_entity_mappings

### Export

export_jobs

### Search

search_index or PostgreSQL-derived searchable projections.

Prefer PostgreSQL full-text/trigram capabilities before introducing an external search engine.

### AI

ai_analysis_runs
ai_evidence
ai_recommendations

AI evidence must reference authoritative records where possible.

## Important Relationships

Organization
→ Locations
→ Stations
→ Sales Categories

Vendor
→ Vendor Item
→ Canonical Inventory Item

Purchase Order
→ PO Lines
→ Receipt
→ Receipt Lines
→ Invoice
→ Invoice Lines

Menu Item
→ Variant
→ Recipe
→ Recipe Version
→ Recipe Components
→ Canonical Inventory Items

Sales Order
→ Order Items
→ Menu Variants
→ Recipes

Employee
→ App User
→ Roles

## IDs

Use UUID primary keys for internal records.

Human-readable codes may also exist, for example:

INV-000123
STN-001
PO-2026-00123

Business logic must use internal IDs rather than display names.

## External Data

External integrations must preserve:

source_system_id
source_record_id

Legacy/external IDs are for traceability and mapping.

They are not the canonical identity.

## Financial Values

Use PostgreSQL NUMERIC for currency and exact cost calculations.

Never use floating point for money.

Do not round internal unit costs merely because the UI displays two decimal places.

## Quantities

Use NUMERIC for quantities.

Support fractional quantities.

A movement may preserve both:

entered quantity/unit

and

normalized/measured base quantity/unit

Example:

entered_quantity = 2
entered_unit = BOX

measured_base_quantity = 43.6
base_unit = LB

## Time

Use TIMESTAMPTZ for event timestamps.

Also store business_date where daily operational reporting requires it.

Location timezone must be explicit.

## History

Do not overwrite historical facts when effective-dated records are required.

Use effective_from/effective_to or append-only events for:

- Recipes
- Menu prices
- Pay rates
- Vendor pack definitions where appropriate
- Costs

## Posting

Draft/staging records and posted authoritative records must be distinguishable.

Invoices must not influence authoritative cost/posting logic until required reviews are complete.

## Audit

audit_events should be append-only.

Audit records should include:

actor
action
entity
before state
after state
timestamp

## Derived Analytics

Avoid duplicating calculated truths into manually maintained tables.

Prefer database views/materialized views/application queries for:

current item cost
vendor price history
station daily sales
station food cost
station waste
station contribution P&L
daily location P&L
menu margin
menu engineering
three-way match
open vendor claims
exception center
integration health

## Initial Database Scope

The first migration should NOT create the entire future schema.

Initial implementation should focus on:

organizations
locations
stations
employees
app_users
roles
user_roles
inventory_categories
inventory_items
units
inventory_item_units
inventory_movements
inventory_movement_lines
control_rules
exceptions
audit_events

Additional domains should be introduced milestone by milestone.
