"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import {
  startOrResumeCycleCount,
  addCycleCountLine,
  recordCycleCountLineObservation,
  completeCycleCount,
  cancelCycleCount,
  listCycleCountDraftStatusForOrganization,
  listCycleCountSummaries,
  getCycleCountDetail,
  listCycleCountLines,
  listActiveInventoryItemsForCycleCount,
  listStorageEligibleLocations,
  markCycleCountLineKnownWaste,
  recordCycleCountLineWaste,
  type StartOrResumeCycleCountResult,
  type AddCycleCountLineResult,
  type RecordCycleCountLineObservationResult,
  type CompleteCycleCountResult,
  type CancelCycleCountResult,
  type CycleCountDraftStatus,
  type CycleCountSummary,
  type CycleCountDetail,
  type CycleCountLineDetail,
  type CycleCountSearchableItem,
  type StorageEligibleLocation,
  type MarkCycleCountLineKnownWasteResult,
  type RecordCycleCountLineWasteResult,
} from "@/app/lib/inventory/cycleCounts";
import {
  StaleCycleCountError,
  CycleCountLockedError,
  CycleCountOwnedByAnotherManagerError,
  MissingCompletionNoteError,
  InvalidStorageLocationError,
  CycleCountKnownWasteUnresolvedError,
  InsufficientInventoryError,
  InvalidWasteQuantityError,
  WasteNoteRequiredError,
  CycleCountWasteStaleError,
  CycleCountWasteAlreadyRecordedError,
  type StaleCycleCountLine,
} from "@/app/lib/inventory/errors";
import type { WasteReasonCode } from "@/app/lib/inventory/wasteReasons";

/**
 * Manager-only cycle-count actions (Part 22) -- every one of these gates on
 * requireManagerOrAdmin first, exactly like the rest of app/actions/
 * inventory.ts. The RPCs themselves also derive organization_id from the
 * acting app_user server-side (never trusting a client-supplied org id),
 * so org isolation holds even if this gate were ever bypassed.
 *
 * DRAFT OWNERSHIP: only inventory_cycle_counts.started_by_app_user_id may
 * resume, add to, observe on, complete, or cancel a DRAFT count -- enforced
 * in the RPCs themselves (20260811100082_cycle_count_draft_ownership.sql,
 * GA024 / CycleCountOwnedByAnotherManagerError), never only here. Actions
 * that READ line-level data (which includes another manager's in-progress
 * physical observations) additionally check ownership BEFORE returning
 * anything, since listCycleCountLines itself has no RPC gate of its own --
 * a direct call to listCycleCountLinesAction for someone else's draft must
 * never leak their counts, even though nothing in this file's UI would
 * normally construct that call (Part "DIRECT URL PROTECTION").
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

const OWNED_BY_ANOTHER_MANAGER_MESSAGE = "This cycle count was started by another manager and can only be resumed by them.";

export type ListStorageLocationsResult = { ok: true; locations: StorageEligibleLocation[] } | AuthFailure;

export async function listStorageEligibleLocationsForOrganization(): Promise<ListStorageLocationsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const locations = await listStorageEligibleLocations(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, locations };
}

export type ListCycleCountDraftStatusResult = { ok: true; drafts: CycleCountDraftStatus[] } | AuthFailure;

/** Draft status per location (Part "LISTING / LOCATION PICKER") -- each
 * row already carries isOwnedByCurrentManager/canResume so the picker can
 * render "Resume" vs. "In Progress" without a second round trip or its
 * own copy of the ownership rule. */
export async function listCycleCountDraftStatus(): Promise<ListCycleCountDraftStatusResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const drafts = await listCycleCountDraftStatusForOrganization(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId);
  return { ok: true, drafts };
}

export type ListCycleCountSummariesResult = { ok: true; summaries: CycleCountSummary[] } | AuthFailure;

/** Serves both the hub's "in progress" section and its history section
 * (Part "CYCLE COUNT LANDING PAGE" / "HISTORY PERFORMANCE") -- one query
 * regardless of how many counts are returned. History access is NOT
 * gated by draft ownership (Part "HISTORY ACCESS / ORGANIZATION
 * ISOLATION"): any manager in the same organization may see completed/
 * cancelled summaries; org isolation itself is still enforced (only this
 * organization's rows are ever returned). */
export async function listCycleCountSummariesAction(input?: {
  statuses?: ("DRAFT" | "COMPLETED" | "CANCELLED")[];
  locationId?: string | null;
  limit?: number;
}): Promise<ListCycleCountSummariesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const summaries = await listCycleCountSummaries(getServiceRoleClient(), {
    organizationId: auth.manager.organizationId,
    currentActorAppUserId: auth.manager.appUserId,
    statuses: input?.statuses,
    locationId: input?.locationId,
    limit: input?.limit,
  });
  return { ok: true, summaries };
}

export type StartOrResumeCycleCountActionResult =
  | { ok: true; result: StartOrResumeCycleCountResult }
  | AuthFailure
  | { ok: false; reason: "invalid_location"; message: string }
  | { ok: false; reason: "owned_by_another_manager"; message: string }
  | { ok: false; reason: "misconfigured"; message: string };

export async function startOrResumeCycleCountAction(locationId: string): Promise<StartOrResumeCycleCountActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const result = await startOrResumeCycleCount(getServiceRoleClient(), {
      locationId,
      startedByAppUserId: auth.manager.appUserId,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof CycleCountOwnedByAnotherManagerError) {
      // The location picker's own draft-status listing should already have
      // prevented this by not offering "Resume" -- reaching here means a
      // direct/stale call, not normal navigation. No draft was created or
      // returned as editable (Part "START RPC SEMANTICS").
      return { ok: false, reason: "owned_by_another_manager", message: OWNED_BY_ANOTHER_MANAGER_MESSAGE };
    }
    if (err instanceof InvalidStorageLocationError) {
      return { ok: false, reason: "invalid_location", message: "That location is not an active storage location." };
    }
    return { ok: false, reason: "misconfigured", message: err instanceof Error ? err.message : String(err) };
  }
}

export type GetCycleCountDetailResult = { ok: true; detail: CycleCountDetail | null } | AuthFailure;

export async function getCycleCountDetailAction(cycleCountId: string): Promise<GetCycleCountDetailResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const detail = await getCycleCountDetail(getServiceRoleClient(), auth.manager.organizationId, cycleCountId, auth.manager.appUserId);
  return { ok: true, detail };
}

export type ListCycleCountLinesResult =
  | { ok: true; lines: CycleCountLineDetail[] }
  | AuthFailure
  | { ok: false; reason: "owned_by_another_manager"; message: string }
  | { ok: false; reason: "not_found"; message: string };

/** Ownership only gates a still-DRAFT count's line data (its physical
 * observations are actively being worked on by its owner) -- see this
 * file's header comment. A COMPLETED or CANCELLED count is historical:
 * Part "HISTORY ACCESS / ORGANIZATION ISOLATION" requires any manager in
 * the SAME organization to be able to view it, regardless of who
 * performed it. Cross-organization access is still refused via
 * getCycleCountDetail's own organizationId scoping (returns null,
 * "not_found") -- never "owned_by_another_manager", which would leak that
 * a count exists in a different org at all. */
export async function listCycleCountLinesAction(cycleCountId: string): Promise<ListCycleCountLinesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const detail = await getCycleCountDetail(getServiceRoleClient(), auth.manager.organizationId, cycleCountId, auth.manager.appUserId);
  if (!detail) {
    return { ok: false, reason: "not_found", message: "This cycle count was not found." };
  }
  if (detail.status === "DRAFT" && !detail.isOwnedByCurrentManager) {
    return { ok: false, reason: "owned_by_another_manager", message: OWNED_BY_ANOTHER_MANAGER_MESSAGE };
  }

  const lines = await listCycleCountLines(getServiceRoleClient(), cycleCountId);
  return { ok: true, lines };
}

export type ListSearchableItemsResult = { ok: true; items: CycleCountSearchableItem[] } | AuthFailure;

export async function listActiveInventoryItemsForCycleCountAction(): Promise<ListSearchableItemsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const items = await listActiveInventoryItemsForCycleCount(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, items };
}

export type AddCycleCountLineActionResult =
  | { ok: true; result: AddCycleCountLineResult }
  | AuthFailure
  | { ok: false; reason: "locked"; message: string }
  | { ok: false; reason: "owned_by_another_manager"; message: string }
  | { ok: false; reason: "misconfigured"; message: string };

export async function addCycleCountLineAction(cycleCountId: string, inventoryItemId: string): Promise<AddCycleCountLineActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const result = await addCycleCountLine(getServiceRoleClient(), {
      cycleCountId,
      inventoryItemId,
      actorAppUserId: auth.manager.appUserId,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof CycleCountOwnedByAnotherManagerError) {
      return { ok: false, reason: "owned_by_another_manager", message: OWNED_BY_ANOTHER_MANAGER_MESSAGE };
    }
    if (err instanceof CycleCountLockedError) {
      return { ok: false, reason: "locked", message: "This cycle count is no longer open for counting." };
    }
    return { ok: false, reason: "misconfigured", message: err instanceof Error ? err.message : String(err) };
  }
}

export type RecordObservationActionResult =
  | { ok: true; result: RecordCycleCountLineObservationResult }
  | AuthFailure
  | { ok: false; reason: "locked"; message: string }
  | { ok: false; reason: "owned_by_another_manager"; message: string }
  | { ok: false; reason: "invalid"; message: string }
  | { ok: false; reason: "misconfigured"; message: string };

/** physicalCountQuantity: null clears the line back to "not counted" --
 * never pass "" or 0 to mean blank (Part 27). refreshSnapshot is true ONLY
 * when recounting a line the last complete_cycle_count attempt flagged
 * stale (Part 13). */
export async function recordCycleCountLineObservationAction(
  cycleCountId: string,
  inventoryItemId: string,
  physicalCountQuantity: string | null,
  refreshSnapshot = false
): Promise<RecordObservationActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (physicalCountQuantity !== null) {
    const num = Number(physicalCountQuantity);
    if (!Number.isFinite(num) || num < 0) {
      return { ok: false, reason: "invalid", message: "Enter a non-negative quantity, or leave it blank to leave this item unchanged." };
    }
  }

  try {
    const result = await recordCycleCountLineObservation(getServiceRoleClient(), {
      cycleCountId,
      inventoryItemId,
      physicalCountQuantity,
      actorAppUserId: auth.manager.appUserId,
      refreshSnapshot,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof CycleCountOwnedByAnotherManagerError) {
      return { ok: false, reason: "owned_by_another_manager", message: OWNED_BY_ANOTHER_MANAGER_MESSAGE };
    }
    if (err instanceof CycleCountLockedError) {
      return { ok: false, reason: "locked", message: "This cycle count is no longer open for counting." };
    }
    return { ok: false, reason: "misconfigured", message: err instanceof Error ? err.message : String(err) };
  }
}

export type CompleteCycleCountActionResult =
  | { ok: true; result: CompleteCycleCountResult }
  | AuthFailure
  | { ok: false; reason: "stale"; message: string; staleLines: StaleCycleCountLine[] }
  | { ok: false; reason: "locked"; message: string }
  | { ok: false; reason: "owned_by_another_manager"; message: string }
  | { ok: false; reason: "missing_note"; message: string }
  | { ok: false; reason: "invalid_location"; message: string }
  | { ok: false; reason: "known_waste_unresolved"; message: string }
  | { ok: false; reason: "misconfigured"; message: string };

/** completionNote is required (Part "REQUIRED COMPLETION NOTE") -- checked
 * here for immediate UX feedback, but complete_cycle_count itself is the
 * actual enforcement boundary (GA025 / MissingCompletionNoteError), never
 * trusted from this client-facing check alone. If stale-line validation
 * fails inside the RPC, the whole transaction (adjustments AND the note)
 * rolls back together -- there is no path where a note gets saved against
 * a DRAFT that failed to complete. */
export async function completeCycleCountAction(
  cycleCountId: string,
  expectedVersion: number,
  completionNote: string
): Promise<CompleteCycleCountActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (completionNote.trim() === "") {
    return { ok: false, reason: "missing_note", message: "A completion note is required to complete a cycle count." };
  }

  try {
    const result = await completeCycleCount(getServiceRoleClient(), {
      cycleCountId,
      expectedVersion,
      completedByAppUserId: auth.manager.appUserId,
      completionNote,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof StaleCycleCountError) {
      return {
        ok: false,
        reason: "stale",
        message: "Inventory changed while you were counting. Recount the items below and try again.",
        staleLines: err.staleLines,
      };
    }
    if (err instanceof CycleCountOwnedByAnotherManagerError) {
      return { ok: false, reason: "owned_by_another_manager", message: OWNED_BY_ANOTHER_MANAGER_MESSAGE };
    }
    if (err instanceof MissingCompletionNoteError) {
      return { ok: false, reason: "missing_note", message: "A completion note is required to complete a cycle count." };
    }
    if (err instanceof CycleCountLockedError) {
      return { ok: false, reason: "locked", message: "This cycle count was already completed, cancelled, or changed. Reload and try again." };
    }
    if (err instanceof InvalidStorageLocationError) {
      return { ok: false, reason: "invalid_location", message: "This location is no longer an active storage location." };
    }
    if (err instanceof CycleCountKnownWasteUnresolvedError) {
      return {
        ok: false,
        reason: "known_waste_unresolved",
        message: "Known waste must be recorded before this cycle count can be completed.",
      };
    }
    return { ok: false, reason: "misconfigured", message: err instanceof Error ? err.message : String(err) };
  }
}

export type CancelCycleCountActionResult =
  | { ok: true; result: CancelCycleCountResult }
  | AuthFailure
  | { ok: false; reason: "invalid"; message: string }
  | { ok: false; reason: "locked"; message: string }
  | { ok: false; reason: "owned_by_another_manager"; message: string }
  | { ok: false; reason: "misconfigured"; message: string };

export async function cancelCycleCountAction(cycleCountId: string, expectedVersion: number, reason: string): Promise<CancelCycleCountActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (reason.trim() === "") {
    return { ok: false, reason: "invalid", message: "A cancellation reason is required." };
  }

  try {
    const result = await cancelCycleCount(getServiceRoleClient(), {
      cycleCountId,
      expectedVersion,
      cancelledByAppUserId: auth.manager.appUserId,
      reason,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof CycleCountOwnedByAnotherManagerError) {
      return { ok: false, reason: "owned_by_another_manager", message: OWNED_BY_ANOTHER_MANAGER_MESSAGE };
    }
    if (err instanceof CycleCountLockedError) {
      return { ok: false, reason: "locked", message: "This cycle count was already completed or changed. Reload and try again." };
    }
    return { ok: false, reason: "misconfigured", message: err instanceof Error ? err.message : String(err) };
  }
}

export type MarkCycleCountLineKnownWasteActionResult =
  | { ok: true; result: MarkCycleCountLineKnownWasteResult }
  | AuthFailure
  | { ok: false; reason: "locked"; message: string }
  | { ok: false; reason: "owned_by_another_manager"; message: string }
  | { ok: false; reason: "already_recorded"; message: string }
  | { ok: false; reason: "invalid_quantity"; message: string }
  | { ok: false; reason: "misconfigured"; message: string };

/** Provisional "waste found during count" marker (Part 22/23) -- never
 * touches the ledger. identifiedWasteQuantity: null clears a previous
 * flag. Server-enforced: only a negative-variance, still-unresolved line
 * the caller owns can be flagged, and the quantity can never exceed the
 * absolute negative variance (Part 30) -- never trusted from the
 * checkbox/input alone. */
export async function markCycleCountLineKnownWasteAction(
  cycleCountId: string,
  inventoryItemId: string,
  identifiedWasteQuantity: string | null
): Promise<MarkCycleCountLineKnownWasteActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const result = await markCycleCountLineKnownWaste(getServiceRoleClient(), {
      cycleCountId,
      inventoryItemId,
      identifiedWasteQuantity,
      actorAppUserId: auth.manager.appUserId,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof CycleCountOwnedByAnotherManagerError) {
      return { ok: false, reason: "owned_by_another_manager", message: OWNED_BY_ANOTHER_MANAGER_MESSAGE };
    }
    if (err instanceof CycleCountLockedError) {
      return { ok: false, reason: "locked", message: "This cycle count is no longer open for counting." };
    }
    if (err instanceof CycleCountWasteAlreadyRecordedError) {
      return { ok: false, reason: "already_recorded", message: "This item's waste has already been recorded and cannot be re-flagged." };
    }
    if (err instanceof InvalidWasteQuantityError) {
      return { ok: false, reason: "invalid_quantity", message: "Enter a valid quantity -- it cannot exceed the negative variance for this item." };
    }
    return { ok: false, reason: "misconfigured", message: err instanceof Error ? err.message : String(err) };
  }
}

export type RecordCycleCountLineWasteActionResult =
  | { ok: true; result: RecordCycleCountLineWasteResult }
  | AuthFailure
  | { ok: false; reason: "locked"; message: string }
  | { ok: false; reason: "owned_by_another_manager"; message: string }
  | { ok: false; reason: "stale"; message: string }
  | { ok: false; reason: "already_recorded"; message: string }
  | { ok: false; reason: "insufficient_inventory"; message: string }
  | { ok: false; reason: "invalid_quantity"; message: string }
  | { ok: false; reason: "note_required"; message: string }
  | { ok: false; reason: "misconfigured"; message: string };

/**
 * The atomic, safe record-and-re-anchor operation (Part 26/27) -- the
 * ONLY place cycle-count-identified waste actually posts to the ledger.
 * A STALE result means unrelated inventory activity happened since the
 * manager counted this item; zero waste is written and a recount is
 * required (Part 26) -- never blindly posted and re-anchored.
 */
export async function recordCycleCountLineWasteAction(
  cycleCountId: string,
  inventoryItemId: string,
  reasonCode: WasteReasonCode,
  note: string | null,
  clientRequestId: string
): Promise<RecordCycleCountLineWasteActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (reasonCode === "OTHER" && (note ?? "").trim() === "") {
    return { ok: false, reason: "note_required", message: "A note is required when the reason is Other." };
  }

  try {
    const result = await recordCycleCountLineWaste(getServiceRoleClient(), {
      cycleCountId,
      inventoryItemId,
      reasonCode,
      note,
      actorAppUserId: auth.manager.appUserId,
      clientRequestId,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof CycleCountOwnedByAnotherManagerError) {
      return { ok: false, reason: "owned_by_another_manager", message: OWNED_BY_ANOTHER_MANAGER_MESSAGE };
    }
    if (err instanceof CycleCountLockedError) {
      return { ok: false, reason: "locked", message: "This cycle count is no longer open for counting." };
    }
    if (err instanceof CycleCountWasteStaleError) {
      return {
        ok: false,
        reason: "stale",
        message: "Inventory changed since this item was counted. Recount it and try again before recording waste.",
      };
    }
    if (err instanceof CycleCountWasteAlreadyRecordedError) {
      return { ok: false, reason: "already_recorded", message: "This item's waste has already been recorded." };
    }
    if (err instanceof InsufficientInventoryError) {
      return { ok: false, reason: "insufficient_inventory", message: "This quantity exceeds what's currently available at this location." };
    }
    if (err instanceof InvalidWasteQuantityError) {
      return { ok: false, reason: "invalid_quantity", message: "Enter a valid waste quantity." };
    }
    if (err instanceof WasteNoteRequiredError) {
      return { ok: false, reason: "note_required", message: "A note is required when the reason is Other." };
    }
    return { ok: false, reason: "misconfigured", message: err instanceof Error ? err.message : String(err) };
  }
}
