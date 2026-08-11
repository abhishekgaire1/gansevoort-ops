# Product Roadmap

The roadmap is intentionally incremental.

Do not begin later milestones until the underlying operational data is reliable.

## Milestone 0 — Project Foundation

Status: Current

Deliverables:

- Next.js project
- TypeScript
- Git
- Private GitHub repository
- Supabase development project
- Supabase CLI
- Claude Code
- Project documentation
- Migration workflow
- Basic test setup

## Milestone 1 — Inventory MVP

Goal:

Replace the most important part of the existing inventory withdrawal workflow with a reliable canonical system.

Deliverables:

- Employees
- Employee PIN login
- Stations
- Inventory categories
- Canonical inventory items
- Units
- Item-specific allowed units
- Station selection
- Inventory item search
- Box/pack/piece/weight entry
- Fractional package support
- Inventory withdrawal
- Audit events
- Withdrawal history
- Configurable high-withdrawal rules
- Exception Center
- Import existing inventory master into staging
- Canonical cleanup/mapping workflow

This milestone should be tested by actual staff on an iPad before moving on.

## Milestone 2 — Purchasing

Deliverables:

- Vendors
- Vendor items
- Vendor package conversions
- Purchase orders
- PO lines
- PO approval
- Partial receiving
- Substitutions
- Damaged/rejected goods
- Receiving review
- Non-PO purchases
- Non-PO reasons/flags

## Milestone 3 — Invoice Platform

Start with manual invoice entry before OCR.

Deliverables:

- Document storage
- Manual invoices
- Invoice lines
- Canonical item mapping
- System review
- Same-reviewer warning
- Three-way matching
- Posting workflow
- Duplicate detection
- Vendor claims/credits
- Vendor price history
- OCR/document extraction
- OCR confidence
- OCR correction history

## Milestone 4 — Sales

Deliverables:

- Peblla import
- Peblla store mapping
- Daily item-sales import
- Peblla transaction import
- Uber Eats ingestion
- Canonical menu items
- Variants
- Modifiers
- Payments
- Refunds
- Import reconciliation
- Integration health

## Milestone 5 — Recipes and Costing

Deliverables:

- Recipes
- Sub-recipes
- Recipe versions
- Recipe components
- Batch/prep production
- Ingredient cost history
- Menu price history
- Theoretical ingredient usage
- Food cost
- Waste cost
- Menu margin
- Menu engineering
- Price/margin simulator

## Milestone 6 — Labor and Payroll

Deliverables:

- Peblla timecards
- Breaks
- Overtime
- Pay-rate history
- Tips
- Bonuses
- PTO
- Sick time
- Intuit integration
- Payroll reporting

Detailed labor allocation by station remains outside initial scope.

## Milestone 7 — Management Intelligence

Deliverables:

- Daily operating dashboard
- Station contribution P&L
- Location-level daily operating contribution
- Vendor intelligence
- Exception workflows
- Global search
- Comments/@mentions
- Data exports
- Master-data approvals
- Integration health dashboard

## Milestone 8 — AI Analyst

Deliverables:

- Natural-language business questions
- Controlled analytics tools
- Evidence-backed answers
- Source links
- Suggested actions
- AI analysis history
- AI recommendation history

AI cannot silently execute material operational actions.

## Milestone 9 — ML and Forecasting

Only begin after sufficient clean historical data exists.

Potential deliverables:

- Demand forecasting
- Ingredient demand conversion
- Purchase recommendations
- Anomaly detection
- Vendor-price anomaly detection
- Waste forecasting
- Forecast accuracy tracking
- What-if forecasting

## Explicitly Deferred

Not required now:

- Rent allocation
- Detailed labor allocation by station
- Live station-level inventory balances
- Shelf/bin-level storage tracking
- Full accounting general ledger
- Payroll tax filing
- Autonomous AI purchasing
- Microservices
