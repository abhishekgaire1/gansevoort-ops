# Business Rules

This document contains product rules that application code must follow.

Changes to these rules require an intentional product decision.

## Organization and Stations

Gansevoort owns all stations, employs all employees, purchases centrally, and receives all revenue.

Stations must still be treated separately for operational analysis.

Station names will be configured as canonical master data.

Sales categories belong to stations but categories and stations are separate concepts.

## Canonical Master Data

The new platform is the authoritative source for canonical business entities.

A canonical inventory item must have one internal identity regardless of vendor wording.

Example:

Vendor description:
CHKN THIGH B/S 4/10LB

Canonical item:
Chicken Thigh — Boneless Skinless

Different vendor descriptions must map to the same canonical item when they represent the same product.

Creating or merging sensitive master data must support approval controls.

The system must avoid duplicate canonical records.

## Inventory Units

Inventory must support practical operational units.

Examples:

- box
- case
- pack
- piece
- bottle
- pound
- ounce
- gallon
- liter

Fixed conversions may be stored.

Example:

1 box = 360 eggs

Variable-weight products must support both package quantity and actual measured quantity.

Example:

2 boxes
43.6 lb actual weight

Half-box and fractional-package quantities must be supported.

Costs and quantities must use exact numeric database types, not floating point.

## Inventory Withdrawals

Any employee may record an inventory withdrawal using an employee PIN.

Normal withdrawals do not require manager approval.

Each withdrawal must record:

- Employee
- Station
- Canonical inventory item
- Entered quantity
- Entered unit
- Measured quantity when applicable
- Timestamp
- Audit information

Unusually high withdrawals must generate an exception rather than block the transaction.

Thresholds must be configurable.

V1 does not require a running station-level inventory balance.

## Physical Inventory Counts

A dedicated employee can perform periodic inventory counts.

The application must support physical counts without forcing a fixed daily/weekly schedule.

## Storage Locations

Current known central storage locations include:

- Central Walk-In
- Central Freezer
- Dry Storage — Near Walk-In
- Dry Storage — Level C2
- Dry Storage — Level C3

Detailed rack/shelf/bin tracking is not required.

Storage-location support should remain lightweight.

## Purchasing

The platform must generate purchase orders.

POs may support:

- Draft
- Approval
- Sending
- Partial receiving
- Full receiving
- Closing
- Cancellation

Not every purchase will have a PO.

Non-PO purchases are allowed but must:

- Be flagged
- Be manually verified
- Record a reason

Examples include:

- Restaurant Depot
- Costco
- Company-card purchases
- Petty cash
- Emergency purchases

The system must not fabricate retroactive purchase orders merely to make a transaction appear compliant.

## Receiving

Receiving represents what physically arrived.

Receiving must remain separate from both the PO and invoice.

The system must preserve:

- Ordered quantity
- Received quantity
- Accepted quantity
- Rejected quantity
- Damage
- Substitution
- Partial delivery

## Invoice Review

There are two distinct invoice controls.

### Level 1 — Receiving Review

Performed when the physical delivery is received.

The reviewer verifies what actually arrived.

The system must record:

- Reviewer
- Timestamp
- Decision
- Notes/exceptions

### Level 2 — System Verification

Performed after the invoice/document has been extracted and entered into the system.

The reviewer verifies:

- Vendor
- Invoice number
- Dates
- Canonical item mappings
- Quantities
- Units
- Unit conversions
- Prices
- Totals
- Credits
- Other extracted data

The system must record:

- Reviewer
- Timestamp
- Decision
- Corrections
- Notes

For smaller invoices, the same manager may perform both reviews.

If the same person performs both reviews, the UI must warn them and require acknowledgment before continuing.

The threshold for requiring a different reviewer must be configurable.

## Invoice Posting

OCR/extraction results may exist in staging data before approval.

They must not become authoritative posted transactions until required verification is complete.

Posted transactions should not be silently overwritten.

Material corrections should use an auditable correction/reversal process.

## Three-Way Matching

Where possible the system should compare:

Purchase Order
vs
Receiving
vs
Invoice

Possible exceptions include:

- Quantity mismatch
- Price mismatch
- Item mismatch
- Missing PO
- Missing receiving record

## Vendor Credits and Claims

When a vendor owes Gansevoort a credit, the system must preserve the claim until it is resolved.

Examples:

- Short delivery
- Damaged product
- Overbilling
- Incorrect price

Claims must track expected and received credit amounts and status.

## Vendor Price Intelligence

Every approved invoice line contributes to vendor price history.

Historical prices must not be overwritten.

The system should eventually compare:

- Current vendor price
- Previous vendor price
- Price change
- Alternative vendors
- Historical trend

## Recipes

Recipes and sub-recipes must be supported.

Prepared/batch items may themselves become canonical inventory items.

Recipes must be versioned.

A recipe change creates a new version rather than overwriting the old version.

Historical analysis must use the recipe that was effective on the analyzed date.

## Ingredient Costs

Historical purchase costs must be retained.

Current cost calculations must not destroy historical price information.

Operational costing may use a weighted-average cost methodology unless intentionally changed later.

## Menu Prices

Menu-price history must be retained.

Historical price changes must not overwrite previous prices.

## Sales

Peblla and other systems are data sources.

External names/IDs must map to canonical internal records.

Do not make the core product dependent on Peblla-specific structures.

Refunds must remain separate transactions rather than rewriting original payments.

An order may contain multiple payment/refund transactions.

## Waste

Waste must be attributable to:

- Item
- Quantity
- Unit
- Employee
- Station/location when applicable
- Reason
- Time

Normal waste entry does not require approval.

High-value or abnormal waste may generate an exception through configurable rules.

## Exceptions

Managers should work from a centralized Exception Center.

Examples include:

- High withdrawal
- Non-PO purchase
- Invoice mismatch
- Duplicate invoice
- Vendor price spike
- Missing review
- Import failure
- High waste
- Master-data problem

Normal operations should not be blocked unnecessarily.

## Audit Trail

Important actions require immutable audit records.

Examples:

- Invoice edits
- Reviews
- Recipe changes
- Cost changes
- PO changes
- Timecard changes
- Master-data changes
- Item mappings
- Inventory movements

Audit history must answer:

Who?
What?
When?
Previous value?
New value?

## AI

AI may:

- Analyze
- Explain
- Compare
- Summarize
- Recommend actions

AI must show evidence for material conclusions.

Evidence should link back to authoritative source records when possible.

AI must not invent financial calculations.

Application/database functions calculate metrics; AI interprets them.

AI suggested actions require a human decision before changing authoritative operations.

## Comments and Collaboration

Comments, notes, and @mentions may be attached to relevant business records such as:

- Invoice
- PO
- Vendor claim
- Exception
- Inventory movement
- Recipe

Conversation should remain attached to the underlying business record.

## Data Ownership

Authorized users must be able to export business data.

Initial formats may include:

- CSV
- Excel
- PDF

API-based export may be added later.
