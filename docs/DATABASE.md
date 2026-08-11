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

Initial movement types include:

PURCHASE_RECEIPT
ISSUE_TO_STATION
STATION_TRANSFER
RETURN_TO_CENTRAL
WASTE
COUNT_ADJUSTMENT
BATCH_INPUT
BATCH_OUTPUT
VENDOR_RETURN
LEGACY_IMPORT

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
