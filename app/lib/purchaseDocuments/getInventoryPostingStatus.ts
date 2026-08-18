// Deliberately NOT "server-only" -- a pure label mapping the VERIFIED
// page uses client-side, the same way computeReceivingPrefill.ts is
// shared between server and client code.
//
// 2A.4 note: the pre-2A.4 stub (getInventoryPostingSummary, which could
// only ever truthfully return NOT_POSTED because no inbound posting path
// existed) is gone. Real posting status now comes from
// purchase_document_inventory_posting_status /
// app/lib/inventory/getInventoryPostingDetail.ts -- derived from ACTUAL
// posting records (purchase_document_inventory_posting_lines vs required
// effective inventory lines), never from purchase_document.status,
// receipt existence, or receiving completeness.

export type InventoryPostingStatus = "NOT_POSTED" | "PARTIALLY_POSTED" | "POSTED";

/** The VERIFIED page's status badge text -- a pure mapping, kept separate
 * from the posting-status derivation so the label logic itself is
 * directly unit-testable for every status. */
export function inventoryPostingBadgeLabel(status: InventoryPostingStatus): string {
  switch (status) {
    case "POSTED":
      return "Inventory Posted";
    case "PARTIALLY_POSTED":
      return "Partially Posted";
    case "NOT_POSTED":
      return "Verified — Ready for Inventory";
  }
}
