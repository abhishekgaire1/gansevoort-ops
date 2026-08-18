// Deliberately NOT "server-only" -- this is a pure, side-effect-free
// function (no DB access, no secrets) that the VERIFIED page calls
// client-side once its review summary has already loaded, the same way
// computeReceivingPrefill.ts is shared between server and client code.

export type InventoryPostingStatus = "NOT_POSTED" | "PARTIALLY_POSTED" | "POSTED";

export interface InventoryPostingLine {
  lineKey: string;
  description: string | null;
  postedQuantity: number;
  postedUnit: string | null;
  locationName: string | null;
  postedAt: string;
}

export interface InventoryPostingSummary {
  status: InventoryPostingStatus;
  /** How many CURRENT CONFIRMED INVENTORY lines this document has --
   * always the denominator for "X / Y lines posted," regardless of
   * whether any posting exists yet. */
  totalInventoryLines: number;
  postedLineCount: number;
  postedLines: InventoryPostingLine[];
  /** The most recent posting timestamp across postedLines, or null. */
  lastPostedAt: string | null;
}

/**
 * Derives inventory-posting status from the actual posting source of
 * truth -- inventory_movements -- never inferred from purchase_document.
 * status, receipt existence, or "receiving is complete." A recorded
 * receipt is NOT an inventory posting.
 *
 * Investigated against a real VERIFIED Gansevoort DEV document twice now
 * (most recently Bartlett #3614450, 9 confirmed INVENTORY lines, fully
 * received): zero inventory_movement_lines exist for any of its mapped
 * items, and inventory_movements.movement_type's own check constraint
 * only allows 'ISSUE_TO_STATION' -- there is currently NO inbound/receipt
 * movement type in the schema at all, and critically NO reference/
 * idempotency column anywhere linking a movement back to a specific
 * receipt_line or purchase_document (that link is 2A.4's job to add).
 * Matching by inventory_item_id alone would be WRONG -- an item can have
 * unrelated ISSUE_TO_STATION movements (kiosk withdrawals) that have
 * nothing to do with this document's own receiving -- so this
 * deliberately does not attempt that as a proxy.
 *
 * "NOT_POSTED" is therefore not a guess or a placeholder -- it is the
 * only value that can be correct today, for every document, until 2A.4
 * introduces both the inbound movement type and that reference column.
 * This function exists so that when 2A.4 adds them, only THIS function's
 * body needs a real query -- every caller (the VERIFIED page) already
 * reads posting status/detail through it rather than assuming anything
 * itself, and the PARTIALLY_POSTED/POSTED shapes are already correct and
 * ready to receive real data.
 */
export function getInventoryPostingSummary(totalInventoryLines: number): InventoryPostingSummary {
  return { status: "NOT_POSTED", totalInventoryLines, postedLineCount: 0, postedLines: [], lastPostedAt: null };
}

/** The VERIFIED page's status badge text -- a pure mapping, kept separate
 * from the (currently always-NOT_POSTED) derivation above so the label
 * logic itself is directly testable with every status, even though real
 * data can only ever produce NOT_POSTED until 2A.4 exists. */
export function inventoryPostingBadgeLabel(status: InventoryPostingStatus): string {
  switch (status) {
    case "POSTED":
      return "Inventory Posted";
    case "PARTIALLY_POSTED":
      return "Verified — Partially Posted";
    case "NOT_POSTED":
      return "Verified — Ready for Inventory";
  }
}
