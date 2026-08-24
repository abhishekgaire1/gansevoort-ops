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
  STALE_CYCLE_COUNT_LINE: "GA023",
  /** Only the manager who started a DRAFT cycle count
   * (started_by_app_user_id) may resume, add to, observe on, refresh a
   * stale snapshot for, complete, or cancel it -- every DRAFT-mutating
   * cycle-count RPC raises this for a different manager, scoped to the
   * DRAFT window only (an already-terminal count's stored result is a
   * harmless read for anyone, per 20260811100082's own comments). */
  CYCLE_COUNT_OWNED_BY_ANOTHER_MANAGER: "GA024",
  /** complete_cycle_count refused: p_completion_note was null or blank
   * after trimming. Checked server-side (20260811100083), never trusted
   * from a client-side "is the textarea non-empty" check alone -- and
   * enforced a second time by inventory_cycle_counts_completed_fields_
   * check as defense in depth against a coding mistake bypassing the RPC. */
  MISSING_COMPLETION_NOTE: "GA025",
  /** Reused, not a new code (see purchase_documents_forbid_locked_
   * mutation's own comment) -- "this row is locked from the kind of edit
   * being attempted," the exact same semantic complete_cycle_count/
   * cancel_cycle_count/add_cycle_count_line/record_cycle_count_line_
   * observation raise for a non-DRAFT count, a version conflict, or a
   * terminal-status transition attempted on the wrong state. */
  LOCKED: "GA003",
  /** record_inventory_waste refused: quantity was <= 0, or a
   * COUNT-category base-unit item was given a non-whole quantity
   * (20260811100085). */
  INVALID_WASTE_QUANTITY: "GA026",
  /** record_inventory_waste refused: inventory_item_id is not an active
   * item in the caller's organization. */
  INVALID_WASTE_ITEM: "GA027",
  /** record_inventory_waste refused: reason_code was OTHER and note was
   * null/blank-after-trim. */
  WASTE_NOTE_REQUIRED: "GA028",
  /** record_inventory_waste refused: client_request_id was already used
   * with a different waste payload -- the idempotency contract fails
   * closed rather than silently replaying an unrelated waste event. */
  WASTE_REQUEST_CONFLICT: "GA029",
  /** record_cycle_count_line_waste refused: the cycle count line's
   * ledger watermark no longer matches its snapshot -- some unrelated
   * inventory activity happened since the manager counted this item, so
   * the identified waste cannot be safely posted/re-anchored and a
   * recount is required instead (20260811100086/100087). */
  CYCLE_COUNT_WASTE_STALE: "GA030",
  /** record_cycle_count_line_waste refused: this line's identified waste
   * was already recorded (waste_resolved_at is set) -- replay of an
   * already-resolved line returns the original result instead. */
  CYCLE_COUNT_WASTE_ALREADY_RECORDED: "GA031",
  /** complete_cycle_count refused: one or more lines still have
   * waste_identified = true but have not been recorded/resolved yet
   * (Part 31) -- "Known waste must be recorded before this cycle count
   * can be completed." */
  CYCLE_COUNT_KNOWN_WASTE_UNRESOLVED: "GA032",
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

export interface StaleCycleCountLine {
  inventoryItemId: string;
  locationId: string;
  snapshotExpectedQuantity: number;
  currentExpectedQuantity: number;
  physicalCountQuantity: number;
  stale: true;
}

/** complete_cycle_count refused: one or more explicitly counted lines
 * changed (per the ledger-line-count watermark, never a bare balance
 * comparison -- see inventory_location_item_ledger_line_count) since the
 * manager counted them. Per the stale-state contract, ZERO adjustments are
 * ever committed when this is thrown -- every counted line, not just the
 * stale ones, needs the manager to look again (the stale lines specifically
 * need a recount; the rest simply weren't finalized this attempt). */
export class StaleCycleCountError extends Error {
  staleLines: StaleCycleCountLine[];

  constructor(message: string, details?: string) {
    super(message);
    this.name = "StaleCycleCountError";
    let staleLines: StaleCycleCountLine[] = [];
    if (details) {
      try {
        const parsed = JSON.parse(details) as StaleCycleCountLine[];
        if (Array.isArray(parsed)) staleLines = parsed;
      } catch {
        // Detail wasn't parseable JSON -- fall back to the message alone.
      }
    }
    this.staleLines = staleLines;
  }
}

/** cycle count is DRAFT-only for mutation, and complete/cancel are
 * terminal, version-gated transitions -- see inventory_cycle_counts_
 * forbid_locked_mutation and every RPC's own explicit status/version
 * checks in 20260811100081_cycle_counts.sql. */
export class CycleCountLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CycleCountLockedError";
  }
}

/** A DRAFT-mutating cycle-count RPC (start/resume, add line, record
 * observation, complete, cancel) was called by someone other than
 * inventory_cycle_counts.started_by_app_user_id -- ownership is checked
 * server-side on every one of them (20260811100082_cycle_count_draft_
 * ownership.sql), never only in the UI. Deliberately distinct from
 * CycleCountLockedError: this is "not YOUR draft," not "this draft is no
 * longer editable by anyone." */
export class CycleCountOwnedByAnotherManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CycleCountOwnedByAnotherManagerError";
  }
}

/** complete_cycle_count refused: no non-blank completion note was
 * supplied (20260811100083). Every UI path to Complete Cycle Count must
 * gate on a non-empty note client-side too, but this is the actual
 * enforcement boundary -- never trust the textarea alone. */
export class MissingCompletionNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCompletionNoteError";
  }
}

export function mapCycleCountRpcError(error: { code?: string; message: string; details?: string | null }): Error {
  if (error.code === INVENTORY_SQLSTATE.STALE_CYCLE_COUNT_LINE) {
    return new StaleCycleCountError(error.message, error.details ?? undefined);
  }
  if (error.code === INVENTORY_SQLSTATE.CYCLE_COUNT_OWNED_BY_ANOTHER_MANAGER) {
    return new CycleCountOwnedByAnotherManagerError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.MISSING_COMPLETION_NOTE) {
    return new MissingCompletionNoteError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.INVALID_STORAGE_LOCATION) {
    return new InvalidStorageLocationError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.LOCKED) {
    return new CycleCountLockedError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.CYCLE_COUNT_KNOWN_WASTE_UNRESOLVED) {
    return new CycleCountKnownWasteUnresolvedError(error.message);
  }
  return new Error(error.message);
}

/** record_inventory_waste / record_cycle_count_line_waste refused: the
 * requested waste quantity is not > 0, or (for a COUNT-category
 * base-unit item) is not a whole number. */
export class InvalidWasteQuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWasteQuantityError";
  }
}

/** record_inventory_waste refused: inventory_item_id is not an active
 * item in the caller's organization. */
export class InvalidWasteItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWasteItemError";
  }
}

/** record_inventory_waste refused: reason_code OTHER requires a
 * non-blank note, checked server-side (20260811100085), never trusted
 * from the UI alone. */
export class WasteNoteRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasteNoteRequiredError";
  }
}

/** record_inventory_waste refused: client_request_id was reused with a
 * different payload than its original submission. */
export class WasteRequestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasteRequestConflictError";
  }
}

/** record_cycle_count_line_waste refused: this line's ledger watermark
 * moved since the manager's physical count, so the identified waste
 * cannot be safely re-anchored -- a recount is required (Part 26). */
export class CycleCountWasteStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CycleCountWasteStaleError";
  }
}

/** record_cycle_count_line_waste refused: this line's identified waste
 * was already recorded/resolved -- a genuine duplicate call, distinct
 * from an idempotent replay of the SAME request. */
export class CycleCountWasteAlreadyRecordedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CycleCountWasteAlreadyRecordedError";
  }
}

/** complete_cycle_count refused: one or more lines still have
 * waste_identified = true with no linked waste_event_id (Part 31) --
 * "Known waste must be recorded before this cycle count can be
 * completed." */
export class CycleCountKnownWasteUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CycleCountKnownWasteUnresolvedError";
  }
}

export function mapInventoryWasteRpcError(error: { code?: string; message: string; details?: string | null }): Error {
  if (error.code === INVENTORY_SQLSTATE.INSUFFICIENT_INVENTORY) {
    return new InsufficientInventoryError(error.message, error.details ?? undefined);
  }
  if (error.code === INVENTORY_SQLSTATE.INVALID_STORAGE_LOCATION) {
    return new InvalidStorageLocationError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.INVALID_WASTE_QUANTITY) {
    return new InvalidWasteQuantityError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.INVALID_WASTE_ITEM) {
    return new InvalidWasteItemError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.WASTE_NOTE_REQUIRED) {
    return new WasteNoteRequiredError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.WASTE_REQUEST_CONFLICT) {
    return new WasteRequestConflictError(error.message);
  }
  return new Error(error.message);
}

export function mapCycleCountWasteRpcError(error: { code?: string; message: string; details?: string | null }): Error {
  if (error.code === INVENTORY_SQLSTATE.INSUFFICIENT_INVENTORY) {
    return new InsufficientInventoryError(error.message, error.details ?? undefined);
  }
  if (error.code === INVENTORY_SQLSTATE.INVALID_WASTE_QUANTITY) {
    return new InvalidWasteQuantityError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.WASTE_NOTE_REQUIRED) {
    return new WasteNoteRequiredError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.CYCLE_COUNT_WASTE_STALE) {
    return new CycleCountWasteStaleError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.CYCLE_COUNT_WASTE_ALREADY_RECORDED) {
    return new CycleCountWasteAlreadyRecordedError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.CYCLE_COUNT_OWNED_BY_ANOTHER_MANAGER) {
    return new CycleCountOwnedByAnotherManagerError(error.message);
  }
  if (error.code === INVENTORY_SQLSTATE.LOCKED) {
    return new CycleCountLockedError(error.message);
  }
  return new Error(error.message);
}
