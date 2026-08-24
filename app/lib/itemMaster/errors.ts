import { PURCHASE_DOCUMENT_SQLSTATE, NotPreparerError, VerifiedLockedError } from "@/app/lib/purchaseDocuments/errors";

/**
 * App-defined SQLSTATEs for Milestone 2A.3's item-master/receiving RPCs,
 * continuing the sequence already established in
 * app/lib/purchaseDocuments/errors.ts (GA001-GA006) and this milestone's
 * own earlier migrations (GA007 spend-category cycle, GA008 employee not
 * found/inactive). Centralized here, not merged into the purchase-document
 * registry, since these concern a distinct domain (item master, vendor
 * mappings, receiving) even though a few call sites span both.
 *
 * GA006 (NOT_PREPARER) is deliberately NOT redefined here -- the
 * classification-approval RPCs (20260811100060) reuse the exact same
 * SQLSTATE as submit_purchase_document_for_verification for the identical
 * business condition ("caller is not this document's preparer"), so
 * mapItemMasterRpcError below maps it to the SAME NotPreparerError class
 * already defined in app/lib/purchaseDocuments/errors.ts, rather than a
 * second, redundant error type for one condition.
 */
export const ITEM_MASTER_SQLSTATE = {
  SPEND_CATEGORY_CYCLE: "GA007",
  EMPLOYEE_NOT_FOUND_OR_INACTIVE: "GA008",
  ITEM_NOT_PENDING_REVIEW: "GA009",
  ITEM_PROPOSAL_REFERENCED: "GA010",
  LINE_NOT_FOUND_IN_CURRENT_REVISION: "GA011",
  RECEIPT_NOT_FOUND_OR_INVALID: "GA012",
  CATEGORY_ALREADY_EXISTS: "GA014",
  FIXED_CONVERSION_QUANTITY_MISMATCH: "GA015",
  DUPLICATE_ITEM_NAME: "GA016",
  /** Admin Master Data milestone (20260811100100) -- category
   * deactivation blocked by active dependents (inventory items for an
   * Inventory Category, child categories for a Spend Category). */
  INVENTORY_CATEGORY_HAS_ACTIVE_ITEMS: "GA055",
  SPEND_CATEGORY_HAS_ACTIVE_CHILDREN: "GA056",
} as const;

export class SpendCategoryCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendCategoryCycleError";
  }
}

export class EmployeeNotFoundOrInactiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmployeeNotFoundOrInactiveError";
  }
}

export class ItemNotPendingReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemNotPendingReviewError";
  }
}

export class ItemProposalReferencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemProposalReferencedError";
  }
}

export class LineNotFoundInCurrentRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineNotFoundInCurrentRevisionError";
  }
}

export class ReceiptNotFoundOrInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptNotFoundOrInvalidError";
  }
}

export class CategoryAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CategoryAlreadyExistsError";
  }
}

/** A category deactivation was blocked because active dependents still
 * reference it (Admin Master Data milestone, Part 29) -- an active
 * inventory item for an Inventory Category, or an active child category
 * for a Spend Category. */
export class CategoryDeactivationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CategoryDeactivationBlockedError";
  }
}

/** record_receipt's own server-side recomputation of a FIXED_CONVERSION
 * line's verified base quantity either disagreed with a client-supplied
 * value, or the received unit didn't resolve to the item's purchase/base
 * unit at all (20260811100061) -- the receipt was NOT recorded. */
export class FixedConversionQuantityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixedConversionQuantityMismatchError";
  }
}

/** An active, CONFIRMED Item Master entry with the same normalized
 * canonical name already exists (20260811100060) -- existingItemId/
 * existingItemName are parsed from the RPC's error DETAIL (a JSON string)
 * when present, so the UI can offer "Use Existing Item" instead of a bare
 * failure message. */
export class DuplicateItemNameError extends Error {
  existingItemId: string | null;
  existingItemName: string | null;

  constructor(message: string, details?: string) {
    super(message);
    this.name = "DuplicateItemNameError";
    let existingItemId: string | null = null;
    let existingItemName: string | null = null;
    if (details) {
      try {
        const parsed = JSON.parse(details) as { existingItemId?: string; existingItemName?: string };
        existingItemId = parsed.existingItemId ?? null;
        existingItemName = parsed.existingItemName ?? null;
      } catch {
        // Detail wasn't parseable JSON -- fall back to the message alone.
      }
    }
    this.existingItemId = existingItemId;
    this.existingItemName = existingItemName;
  }
}

export function mapItemMasterRpcError(error: { code?: string; message: string; details?: string | null }): Error {
  switch (error.code) {
    case ITEM_MASTER_SQLSTATE.SPEND_CATEGORY_CYCLE:
      return new SpendCategoryCycleError(error.message);
    case ITEM_MASTER_SQLSTATE.EMPLOYEE_NOT_FOUND_OR_INACTIVE:
      return new EmployeeNotFoundOrInactiveError(error.message);
    case ITEM_MASTER_SQLSTATE.ITEM_NOT_PENDING_REVIEW:
      return new ItemNotPendingReviewError(error.message);
    case ITEM_MASTER_SQLSTATE.ITEM_PROPOSAL_REFERENCED:
      return new ItemProposalReferencedError(error.message);
    case ITEM_MASTER_SQLSTATE.LINE_NOT_FOUND_IN_CURRENT_REVISION:
      return new LineNotFoundInCurrentRevisionError(error.message);
    case ITEM_MASTER_SQLSTATE.RECEIPT_NOT_FOUND_OR_INVALID:
      return new ReceiptNotFoundOrInvalidError(error.message);
    case ITEM_MASTER_SQLSTATE.CATEGORY_ALREADY_EXISTS:
      return new CategoryAlreadyExistsError(error.message);
    case ITEM_MASTER_SQLSTATE.INVENTORY_CATEGORY_HAS_ACTIVE_ITEMS:
    case ITEM_MASTER_SQLSTATE.SPEND_CATEGORY_HAS_ACTIVE_CHILDREN:
      return new CategoryDeactivationBlockedError(error.message);
    case ITEM_MASTER_SQLSTATE.FIXED_CONVERSION_QUANTITY_MISMATCH:
      return new FixedConversionQuantityMismatchError(error.message);
    case ITEM_MASTER_SQLSTATE.DUPLICATE_ITEM_NAME:
      return new DuplicateItemNameError(error.message, error.details ?? undefined);
    case PURCHASE_DOCUMENT_SQLSTATE.NOT_PREPARER:
      return new NotPreparerError(error.message);
    case PURCHASE_DOCUMENT_SQLSTATE.VERIFIED_LOCKED:
      // The parent purchase_document moved out of DRAFT/READY_FOR_VERIFICATION
      // mid-run (GA003) -- a genuinely document-wide condition: every other
      // line's classification write will fail identically, unlike a
      // per-line data issue. classifyPurchaseDocumentLines.ts checks for
      // this specific type to decide "stop the whole run" vs "isolate this
      // one line and keep going."
      return new VerifiedLockedError(error.message);
    default:
      return new Error(error.message);
  }
}
