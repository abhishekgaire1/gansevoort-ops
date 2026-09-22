# Purchase-document / inventory posting error codes

Registry of the custom SQLSTATE domain error codes on the posting/receiving
paths, their internal exception class, the manager-facing message, and the
corrective action. A **known** posting rejection must never fall through to the
generic "We couldn't post this invoice. Please try again."

| Code | Domain | Raised by | Internal class | Manager-facing title | Message / action |
|------|--------|-----------|----------------|----------------------|------------------|
| GA002 | purchase-doc | version/status guards | `StaleVersionError` | Document changed | "This document was updated elsewhere. Reload to see the latest version." |
| GA003 | purchase-doc | verified-lock | `VerifiedLockedError` | Locked | Verified document is locked; corrections are proposals. |
| GA004 | purchase-doc | maker-checker | `CannotSelfVerifyError` | Can't self-review | The preparer cannot review-correct their own document. |
| GA006 | purchase-doc | classification approval | `NotPreparerError` | Not authorized | Only the preparer (or an authorized manager) can edit this draft. |
| GA013 | purchase-doc | posting/submit | `PreparationIncompleteError` | Not ready | Named incomplete-preparation reason; resolve in Items & Receiving. |
| GA075 | inventory | amendment double-post guard | `AmendmentLineageAlreadyPostedError` | Inventory already posted | "This invoice lineage has already added inventory and cannot post it again." Reference: GA075 |
| GA076 | purchase-doc | sole-approver permission | `SoleApproverPermissionDeniedError` | Not permitted | "You do not have permission to post without a second reviewer." |
| GA078 | purchase-doc | sole-approver reason | `SoleApproverReasonRequiredError` | Reason required | "A reason is required for single-manager approval." |
| GA079 | purchase-doc (posting path) | price-review guard `assert_price_review_acknowledged` | **`PriceReviewRequiredError`** | Price review required | "The price or received quantity changed after acknowledgment, or a significant price change has not been reviewed. Review the price change again in Items & Receiving before posting." Reference: GA079 |
| GA080 | delivery integrity | delivery-lineage gate (`isAmbiguousDeliveryLineage`) | (action result `reason: "delivery_conflict"`) | Delivery records need review | "This invoice has multiple recorded deliveries for the same lines whose delivery records cannot be automatically distinguished. Review the recorded deliveries…" Reference: GA080 |
| GA086 | line treatment | `set_purchase_document_line_treatment` / `set_line_classification_explanation` | `ExplanationRequiredError` | Explanation required | "A written explanation is required for this expense category." (catch-all "Other" categories) |
| GA087 | line treatment | `set_purchase_document_line_treatment` (20260811100182) | `InvalidLineTreatmentError` | Classification incomplete | The RPC's own message names the missing/invalid field: expense category, credit subtype, discount scope, returned item/quantity/unit/location/reason/acknowledgment, or an inactive category. |
| GA088 | line treatment (posting path) | `post_purchase_document_inventory` | `UnresolvedLinesError` (action result `reason: "blocked"` with per-line blockers) | Classify every line | "Cannot post yet. Classify every invoice line in Review Invoice, then try again." An UNRESOLVED / unconfirmed / invalid line never posts, even by direct RPC. |
| GA022 | inventory (return path) | `set_purchase_document_line_treatment` / `post_purchase_document_inventory` (INVENTORY_RETURN) | `InsufficientInventoryError` | Not enough on hand | "Returning that quantity would take inventory below zero at the source location." The whole posting rolls back. |

## GA079 collision — resolved

SQLSTATE **GA079** is overloaded across domains:
- `app/lib/inventory/errors.ts` → `INVALID_CORRECTION_INPUT`
- `app/lib/admin/errors.ts` → `INVALID_CONVERSION_FACTOR`
- the price-review guard raises GA079 for a significant unacknowledged price change.

On the **posting path** a GA079 can only be the price-review guard (the
correction/conversion RPCs are separate paths), so `postingRpcs.ts` and
`soleApproverPostingRpc.ts` map GA079 → `PriceReviewRequiredError` **before** the
generic inventory-error mapping that would otherwise mislabel it as
`InvalidCorrectionInputError`. This is verified by
`tests/priceReviewPostingGuard.rpc.test.ts` and the sole-approver action's
`price_review_required` result.

## Duplicate/ambiguous delivery — dedicated code (GA080)

Delivery-lineage safety is **independent of the price guard**: it blocks posting
whenever a document's effective deliveries are ambiguous (historical/unidentified
duplicates of the same physical delivery), even when there is no price history,
no material price change, or price review is not applicable. Genuine additional
deliveries (distinct `delivery_event_id`, 20260811100171) are allowed and summed.
It never reuses GA079 or a correction/price code.

## Unknown / unexpected failure

The sole-approver action returns `reason: "misconfigured"` with a safe message
("Inventory was not posted. No inventory changes were saved.") and a
**correlation id**; the exact technical error is logged server-side with that id
via `logIfUnexpected`. No SQL, stack traces, table names, or credentials are ever
shown to the manager. Posting is idempotent (unique `receipt_line_id`) and the
Post button disables while pending, so a retry can never double-post.
