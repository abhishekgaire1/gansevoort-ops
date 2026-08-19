/**
 * App-defined SQLSTATEs for Milestone 2A.4's inventory-posting RPCs,
 * continuing the GA0xx sequence (see app/lib/purchaseDocuments/errors.ts
 * and app/lib/itemMaster/errors.ts). GA003 (VERIFIED/status lock) is
 * reused from the purchase-document registry for the identical business
 * condition rather than redefined.
 */
export const INVENTORY_SQLSTATE = {
  POSTING_BLOCKED: "GA017",
  INVALID_STORAGE_LOCATION: "GA021",
  INSUFFICIENT_INVENTORY: "GA022",
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

/** record_inventory_withdrawal refused: the requested quantity exceeds
 * what's currently available at the chosen source location. Distinct
 * from HIGH_WITHDRAWAL (an operational anomaly signal that never blocks)
 * -- this always blocks, with no partial movement ever written. */
export class InsufficientInventoryError extends Error {
  availableQuantity: number | null;
  requestedQuantity: number | null;

  constructor(message: string, details?: string) {
    super(message);
    this.name = "InsufficientInventoryError";
    let availableQuantity: number | null = null;
    let requestedQuantity: number | null = null;
    if (details) {
      try {
        const parsed = JSON.parse(details) as { availableQuantity?: number; requestedQuantity?: number };
        availableQuantity = parsed.availableQuantity ?? null;
        requestedQuantity = parsed.requestedQuantity ?? null;
      } catch {
        // Detail wasn't parseable JSON -- fall back to the message alone.
      }
    }
    this.availableQuantity = availableQuantity;
    this.requestedQuantity = requestedQuantity;
  }
}

/** record_inventory_withdrawal / record_receipt refused: the chosen
 * location is not an active, storage-eligible location in this
 * organization (2A.5 -- a site/business location is never a valid
 * storage source, even if it's otherwise active). */
export class InvalidStorageLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStorageLocationError";
  }
}

export interface InsufficientBatchLine {
  inventoryItemId: string;
  sourceLocationId: string;
  availableQuantity: number;
  requestedQuantity: number;
}

/** record_inventory_withdrawal_batch refused: one or more cart lines
 * exceed what's currently available at their source location. Distinct
 * from the single-item InsufficientInventoryError -- a batch can have
 * MULTIPLE short lines at once, so this carries the whole list (never
 * just the first one found) rather than a single availableQuantity/
 * requestedQuantity pair. The whole batch is rolled back regardless of
 * how many lines were short. */
export class BatchInsufficientInventoryError extends Error {
  lines: InsufficientBatchLine[];

  constructor(message: string, details?: string) {
    super(message);
    this.name = "BatchInsufficientInventoryError";
    let lines: InsufficientBatchLine[] = [];
    if (details) {
      try {
        const parsed = JSON.parse(details) as InsufficientBatchLine[];
        if (Array.isArray(parsed)) lines = parsed;
      } catch {
        // Detail wasn't parseable JSON -- fall back to the message alone.
      }
    }
    this.lines = lines;
  }
}

export function mapInventoryBatchRpcError(error: { code?: string; message: string; details?: string | null }): Error {
  if (error.code === INVENTORY_SQLSTATE.INSUFFICIENT_INVENTORY) {
    return new BatchInsufficientInventoryError(error.message, error.details ?? undefined);
  }
  if (error.code === INVENTORY_SQLSTATE.INVALID_STORAGE_LOCATION) {
    return new InvalidStorageLocationError(error.message);
  }
  return new Error(error.message);
}

export function mapInventoryRpcError(error: { code?: string; message: string; details?: string | null }): Error {
  if (error.code === INVENTORY_SQLSTATE.POSTING_BLOCKED) {
    return new InventoryPostingBlockedError(error.message, error.details ?? undefined);
  }
  if (error.code === INVENTORY_SQLSTATE.INSUFFICIENT_INVENTORY) {
    return new InsufficientInventoryError(error.message, error.details ?? undefined);
  }
  if (error.code === INVENTORY_SQLSTATE.INVALID_STORAGE_LOCATION) {
    return new InvalidStorageLocationError(error.message);
  }
  return new Error(error.message);
}
