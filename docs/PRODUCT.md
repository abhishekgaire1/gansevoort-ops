# Gansevoort Operations Platform

## Purpose

Gansevoort Operations Platform is a unified operating system for Gansevoort Liberty Market.

The goal is to replace fragmented inventory, purchasing, invoice, sales, labor, recipe-costing, and reporting workflows with one authoritative platform.

The platform should eventually answer not only "what happened?" but also:

- Why did it happen?
- What requires attention?
- What should management do next?
- What will likely happen next week?

## Business Structure

Gansevoort owns and operates all food stations, employs all staff, makes centralized purchases, and receives all revenue.

For operational reporting, each station must still be treated as an independent cost/profit center.

There is currently one primary location:

Gansevoort Liberty Market — WTC

The architecture must support additional locations in the future.

## Core Product Areas

### Master Data

One canonical source of truth for:

- Stations
- Sales categories
- ventory items
- Vendors
- Vendor products
- Units and package conversions
- Menu items
- Recipes
- Employees

External systems must map to these canonical records rather than creating competing definitions.

### Inventory

Track:

- Central receiving
- Inventory issued to stations
- Station-to-station transfers
- Waste
- Periodic physical counts
- Batch/prep production
- Inventory adjustments
- High-withdrawal exceptions

V1 does not require live station-level inventory balances.

### Purchasing

Support:

- Purchase order creation
- PO approval
- Partial receiving
- Substitutions
- Damaged/rejected quantities
- Non-PO purchases
- Retail/company-card purchases
- Petty-cash purchases
- Vendor credits and claims
- Vendor price history

### Invoice Processing

Approximately 200 invoices/documents may be processed per week.

Documents may include:

- PDF invoices
- Paper invoice photos
- Receipts
- Restaurant Depot receipts
- Credit-card receipts
- Handwritten invoices
- Excel statements
- Credit memos
- Packing slips

Invoice processing must support OCR/document extraction but OCR may never directly post authoritative financial or inventory data.

### Sales

Peblla is the primary POS.

Peblla currently provides:

- Gansevoort Liberty Market Store
- Grab & Go Store

Categories are already consistent with the operational taxonomy.

Uber Eats is currently ingested separately.

The platform must ultimately support order-level sales, item sales, modifiers, discounts, refunds, payments, and channel information.

### Recipes and Costing

Support:

- Menu items
- Variants
- Modifiers
- Recipes
- Sub-recipes
- Batch/prepared products
- Recipe versions
- Historical ingredient costs
- Menu-price history
- Theoretical food cost
- Menu contribution margin
- Menu engineering
- Price/margin simulation

Historical recipes and costs must never be overwritten.

### Employees and Payroll

Support:

- Hourly and salaried employees
- Employee PIN authentication
- Roles and permissions
- Timecards
- Breaks
- Overtime
- Tips
- Bonuses
- PTO
- Sick time
- Pay-rate history
- Intuit payroll integration

Detailed labor allocation by station is not required in V1.

### Reporting

The platform should eventually provide:

- Daily sales
- Food cost
- Waste
- Vendor spend
- Vendor pricing
- Purchase activity
- Invoice exceptions
- Station contribution P&L
- Location-level daily operating contribution
- Menu profitability
- Menu engineering
- Integration health

Rent allocation is outside current scope.

### Intelligence

The long-term intelligence layer includes:

- AI business analyst
- AI explanations backed by evidence
- AI suggested actions
- Demand forecasting
- Purchase recommendations
- Anomaly detection
- Forecast accuracy tracking

AI explains and recommends.

Authoritative calculations must be performed by application/database logic rather than invented by the language model.

## Primary Users

The system will be used by:

- Employees
- Station leads
- Receiving managers
- Purchasing managers
- Operations managers
- Payroll managers
- Administrators
- Owners

Permissions must be role-based.

## Product Principles

1. One canonical source of truth.
2. Historical data is preserved.
3. Important actions are auditable.
4. AI cannot silently alter authoritative business data.
5. Normal employee workflows must be fast.
6. Managers should primarily workflows must be fast.
6. Managers should primarily review exceptions.
7. External integrations are inputs, not the core data model.
8. The platform must remain understandable and maintainable by a small team.
9. Build operational reliability before ML sophistication.
10. Every feature should solve a real food-court workflow.

## V1 Success

V1 is successful when real employees can use the system for daily operations and management can trust the resulting data.

The first production workflow is:

Employee PIN
→ Select station
→ Select canonical inventory item
→ Enter practical quantity/unit
→ Submit withdrawal
→ Create audit event
→ Flag abnormal withdrawals when necessary
→ Manager can review withdrawal history and exceptions
