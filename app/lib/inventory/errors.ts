/**
 * App-defined SQLSTATEs for Milestone 2A.4's inventory-posting RPCs,
 * continuing the GA0xx sequence (see app/lib/purchaseDocuments/errors.ts
 * and app/lib/itemMaster/errors.ts). GA003 (VERIFIED/status lock) is
 * reused from the purchase-document registry for the identical business
 * condition rather than redefined.
 */
export const INVENTORY_SQLSTATE = {
  POSTING_BLOCKED: "GA017",
} as const;

export interface InventoryPostingBlocker {
  lineKey: string | null;
  description: string | null;
  reason: string;
}

/** post_purchase_document_inventory refused to post -- one or more
 * required inventory lines are not postable. The exact per-line reasons
 * are parsed from the RPC's error DETAIL (a JSON array) so the UI can
 * show the manager exactly what to fix, e.g. "Korean Radish -- verified
 * measurement is required". */
export class InventoryPostingBlockedError extends Error {
  blockers: InventoryPostingBlocker[];

  constructor(message: string, details?: string) {
    super(message);
    this.name = "InventoryPostingBlockedError";
    let blockers: InventoryPostingBlocker[] = [];
    if (details) {
      try {
        const parsed = JSON.parse(details) as InventoryPostingBlocker[];
        if (Array.isArray(parsed)) blockers = parsed;
      } catch {
        // Detail wasn't parseable JSON -- fall back to the message alone.
      }
    }
    this.blockers = blockers;
  }
}

export function mapInventoryRpcError(error: { code?: string; message: string; details?: string | null }): Error {
  if (error.code === INVENTORY_SQLSTATE.POSTING_BLOCKED) {
    return new InventoryPostingBlockedError(error.message, error.details ?? undefined);
  }
  return new Error(error.message);
}
