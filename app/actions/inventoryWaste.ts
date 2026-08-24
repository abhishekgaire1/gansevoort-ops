"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import {
  recordInventoryWaste,
  listInventoryWasteEvents,
  getInventoryWasteDetail,
  listStockedItemsAtLocation,
  type RecordInventoryWasteResult,
  type InventoryWasteEventSummary,
  type InventoryWasteEventDetail,
  type StockedItemAtLocation,
} from "@/app/lib/inventory/waste";
import type { WasteReasonCode } from "@/app/lib/inventory/wasteReasons";
import { listStorageEligibleLocations, type StorageEligibleLocation } from "@/app/lib/inventory/cycleCounts";
import {
  InsufficientInventoryError,
  InvalidStorageLocationError,
  InvalidWasteQuantityError,
  InvalidWasteItemError,
  WasteNoteRequiredError,
  WasteRequestConflictError,
} from "@/app/lib/inventory/errors";

/**
 * Manager-only Inventory Waste actions -- gates on requireManagerOrAdmin
 * first, same posture as app/actions/cycleCounts.ts (Part 17: "Inventory
 * Waste is currently a MANAGER/ADMIN feature... Do not put it in the
 * employee kiosk yet"). record_inventory_waste also derives
 * organization_id server-side from the acting app_user, so org isolation
 * holds even if this gate were ever bypassed.
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export type ListWasteStorageLocationsResult = { ok: true; locations: StorageEligibleLocation[] } | AuthFailure;

/** Same active + storage-eligible location set Cycle Count uses (Part 6)
 * -- a business/site/station location is never a valid waste location. */
export async function listWasteStorageLocationsForOrganization(): Promise<ListWasteStorageLocationsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const locations = await listStorageEligibleLocations(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, locations };
}

export type ListStockedItemsResult = { ok: true; items: StockedItemAtLocation[] } | AuthFailure;

/** Items with a POSITIVE authoritative balance at the chosen location
 * only (Part 7) -- never the whole Item Master. */
export async function listStockedItemsAtLocationAction(locationId: string): Promise<ListStockedItemsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const items = await listStockedItemsAtLocation(getServiceRoleClient(), auth.manager.organizationId, locationId);
  return { ok: true, items };
}

export type RecordInventoryWasteActionResult =
  | { ok: true; result: RecordInventoryWasteResult }
  | AuthFailure
  | { ok: false; reason: "insufficient_inventory"; message: string; availableQuantity: number | null; requestedQuantity: number | null }
  | { ok: false; reason: "invalid_location"; message: string }
  | { ok: false; reason: "invalid_quantity"; message: string }
  | { ok: false; reason: "invalid_item"; message: string }
  | { ok: false; reason: "note_required"; message: string }
  | { ok: false; reason: "request_conflict"; message: string }
  | { ok: false; reason: "misconfigured"; message: string };

/**
 * Records known inventory loss from an exact physical storage location
 * (Part 5/10). clientRequestId makes retries safe -- an identical retry
 * replays the original result, a changed-payload retry with the same id
 * fails closed (Part 11). reasonCode/note validity is checked here for
 * immediate UX feedback, but record_inventory_waste itself is the actual
 * enforcement boundary (GA026-GA029), never trusted from this check
 * alone.
 */
export async function recordInventoryWasteAction(input: {
  locationId: string;
  inventoryItemId: string;
  quantity: string;
  reasonCode: WasteReasonCode;
  note?: string | null;
  clientRequestId: string;
}): Promise<RecordInventoryWasteActionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (input.reasonCode === "OTHER" && (input.note ?? "").trim() === "") {
    return { ok: false, reason: "note_required", message: "A note is required when the reason is Other." };
  }

  try {
    const result = await recordInventoryWaste(getServiceRoleClient(), {
      recordedByAppUserId: auth.manager.appUserId,
      locationId: input.locationId,
      inventoryItemId: input.inventoryItemId,
      quantity: input.quantity,
      reasonCode: input.reasonCode,
      note: input.note,
      clientRequestId: input.clientRequestId,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof InsufficientInventoryError) {
      return {
        ok: false,
        reason: "insufficient_inventory",
        message: "This quantity exceeds what's currently available at this location.",
        availableQuantity: err.availableQuantity,
        requestedQuantity: err.requestedQuantity,
      };
    }
    if (err instanceof InvalidStorageLocationError) {
      return { ok: false, reason: "invalid_location", message: "This location is not an active storage location." };
    }
    if (err instanceof InvalidWasteQuantityError) {
      return { ok: false, reason: "invalid_quantity", message: "Enter a valid waste quantity." };
    }
    if (err instanceof InvalidWasteItemError) {
      return { ok: false, reason: "invalid_item", message: "This item is not active." };
    }
    if (err instanceof WasteNoteRequiredError) {
      return { ok: false, reason: "note_required", message: "A note is required when the reason is Other." };
    }
    if (err instanceof WasteRequestConflictError) {
      return { ok: false, reason: "request_conflict", message: "This request conflicts with a previous submission. Please try again." };
    }
    return { ok: false, reason: "misconfigured", message: err instanceof Error ? err.message : String(err) };
  }
}

export type ListInventoryWasteEventsResult = { ok: true; events: InventoryWasteEventSummary[] } | AuthFailure;

export async function listInventoryWasteEventsAction(input?: {
  locationId?: string | null;
  reasonCode?: WasteReasonCode | null;
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
}): Promise<ListInventoryWasteEventsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const events = await listInventoryWasteEvents(getServiceRoleClient(), {
    organizationId: auth.manager.organizationId,
    locationId: input?.locationId,
    reasonCode: input?.reasonCode,
    fromDate: input?.fromDate,
    toDate: input?.toDate,
    limit: input?.limit,
  });
  return { ok: true, events };
}

export type GetInventoryWasteDetailResult = { ok: true; detail: InventoryWasteEventDetail | null } | AuthFailure;

/** Read-only (Part 19) -- no edit/delete action exists at all; waste is a
 * posted, append-only ledger fact. Org-scoped: a waste event id from
 * another organization resolves to null, never another org's data. */
export async function getInventoryWasteDetailAction(wasteEventId: string): Promise<GetInventoryWasteDetailResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const detail = await getInventoryWasteDetail(getServiceRoleClient(), auth.manager.organizationId, wasteEventId);
  return { ok: true, detail };
}
