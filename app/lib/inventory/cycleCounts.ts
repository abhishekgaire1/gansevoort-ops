import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapCycleCountRpcError, mapCycleCountWasteRpcError } from "@/app/lib/inventory/errors";
import type { WasteReasonCode } from "@/app/lib/inventory/wasteReasons";

/**
 * Typed wrappers around the cycle-count RPC surface (see
 * 20260811100081_cycle_counts.sql for the full atomicity/locking/staleness
 * contract). Quantities are strings end-to-end, matching every other
 * inventory RPC wrapper in this codebase (docs/DATABASE.md: NUMERIC, never
 * floating point).
 */

export interface StartOrResumeCycleCountResult {
  cycleCountId: string;
  status: "DRAFT" | "COMPLETED" | "CANCELLED";
  version: number;
  resumed: boolean;
}

export async function startOrResumeCycleCount(
  supabase: SupabaseClient,
  input: { locationId: string; startedByAppUserId: string }
): Promise<StartOrResumeCycleCountResult> {
  const { data, error } = await supabase.rpc("start_or_resume_cycle_count", {
    p_location_id: input.locationId,
    p_started_by_app_user_id: input.startedByAppUserId,
  });
  if (error) throw mapCycleCountRpcError(error);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_cycle_count_id: string; out_status: string; out_version: number; out_resumed: boolean }
    | undefined;
  if (!row) throw new Error("start_or_resume_cycle_count returned no result");

  return {
    cycleCountId: row.out_cycle_count_id,
    status: row.out_status as "DRAFT" | "COMPLETED" | "CANCELLED",
    version: row.out_version,
    resumed: row.out_resumed,
  };
}

export interface AddCycleCountLineResult {
  lineId: string;
  expectedQuantityAtSnapshot: string;
  baseUnitId: string;
  physicalCountQuantity: string | null;
  alreadyExisted: boolean;
}

export async function addCycleCountLine(
  supabase: SupabaseClient,
  input: { cycleCountId: string; inventoryItemId: string; actorAppUserId: string }
): Promise<AddCycleCountLineResult> {
  const { data, error } = await supabase.rpc("add_cycle_count_line", {
    p_cycle_count_id: input.cycleCountId,
    p_inventory_item_id: input.inventoryItemId,
    p_actor_app_user_id: input.actorAppUserId,
  });
  if (error) throw mapCycleCountRpcError(error);

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_line_id: string;
        out_expected_quantity_at_snapshot: string | number;
        out_base_unit_id: string;
        out_physical_count_quantity: string | number | null;
        out_already_existed: boolean;
      }
    | undefined;
  if (!row) throw new Error("add_cycle_count_line returned no result");

  return {
    lineId: row.out_line_id,
    expectedQuantityAtSnapshot: String(row.out_expected_quantity_at_snapshot),
    baseUnitId: row.out_base_unit_id,
    physicalCountQuantity: row.out_physical_count_quantity === null ? null : String(row.out_physical_count_quantity),
    alreadyExisted: row.out_already_existed,
  };
}

export interface RecordCycleCountLineObservationResult {
  lineId: string;
  expectedQuantityAtSnapshot: string;
  physicalCountQuantity: string | null;
}

/**
 * physicalCountQuantity: null clears the line back to "not counted, no
 * change" -- NEVER pass "" or 0 to mean blank; 0 is a genuine physical
 * observation of zero (Part 27). refreshSnapshot is true ONLY for the
 * "Recount Items" flow after a stale finalize response (Part 13) -- an
 * ordinary entry/edit while still counting must leave the add-time
 * snapshot untouched (Part 10).
 */
export async function recordCycleCountLineObservation(
  supabase: SupabaseClient,
  input: {
    cycleCountId: string;
    inventoryItemId: string;
    physicalCountQuantity: string | null;
    actorAppUserId: string;
    refreshSnapshot?: boolean;
  }
): Promise<RecordCycleCountLineObservationResult> {
  const { data, error } = await supabase.rpc("record_cycle_count_line_observation", {
    p_cycle_count_id: input.cycleCountId,
    p_inventory_item_id: input.inventoryItemId,
    p_physical_count_quantity: input.physicalCountQuantity,
    p_actor_app_user_id: input.actorAppUserId,
    p_refresh_snapshot: input.refreshSnapshot ?? false,
  });
  if (error) throw mapCycleCountRpcError(error);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { out_line_id: string; out_expected_quantity_at_snapshot: string | number; out_physical_count_quantity: string | number | null }
    | undefined;
  if (!row) throw new Error("record_cycle_count_line_observation returned no result");

  return {
    lineId: row.out_line_id,
    expectedQuantityAtSnapshot: String(row.out_expected_quantity_at_snapshot),
    physicalCountQuantity: row.out_physical_count_quantity === null ? null : String(row.out_physical_count_quantity),
  };
}

export interface CompleteCycleCountResult {
  cycleCountId: string;
  inMovementId: string | null;
  outMovementId: string | null;
  countedLineCount: number;
  varianceLineCount: number;
  replayed: boolean;
}

export async function completeCycleCount(
  supabase: SupabaseClient,
  input: { cycleCountId: string; expectedVersion: number; completedByAppUserId: string; completionNote: string }
): Promise<CompleteCycleCountResult> {
  const { data, error } = await supabase.rpc("complete_cycle_count", {
    p_cycle_count_id: input.cycleCountId,
    p_expected_version: input.expectedVersion,
    p_completed_by_app_user_id: input.completedByAppUserId,
    p_completion_note: input.completionNote,
  });
  if (error) throw mapCycleCountRpcError(error);

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_cycle_count_id: string;
        out_in_movement_id: string | null;
        out_out_movement_id: string | null;
        out_counted_line_count: number;
        out_variance_line_count: number;
        out_replayed: boolean;
      }
    | undefined;
  if (!row) throw new Error("complete_cycle_count returned no result");

  return {
    cycleCountId: row.out_cycle_count_id,
    inMovementId: row.out_in_movement_id,
    outMovementId: row.out_out_movement_id,
    countedLineCount: row.out_counted_line_count,
    varianceLineCount: row.out_variance_line_count,
    replayed: row.out_replayed,
  };
}

export interface CancelCycleCountResult {
  cycleCountId: string;
  status: "CANCELLED";
  replayed: boolean;
}

export async function cancelCycleCount(
  supabase: SupabaseClient,
  input: { cycleCountId: string; expectedVersion: number; cancelledByAppUserId: string; reason: string }
): Promise<CancelCycleCountResult> {
  const { data, error } = await supabase.rpc("cancel_cycle_count", {
    p_cycle_count_id: input.cycleCountId,
    p_expected_version: input.expectedVersion,
    p_cancelled_by_app_user_id: input.cancelledByAppUserId,
    p_reason: input.reason,
  });
  if (error) throw mapCycleCountRpcError(error);

  const row = (Array.isArray(data) ? data[0] : data) as { out_cycle_count_id: string; out_status: string; out_replayed: boolean } | undefined;
  if (!row) throw new Error("cancel_cycle_count returned no result");

  return { cycleCountId: row.out_cycle_count_id, status: "CANCELLED", replayed: row.out_replayed };
}

// ============================================================
// Reads -- plain table selects via the service-role client, same
// convention as every other manager read (list_inventory_balances etc.
// aside, which is an RPC only because it needs to JOIN/compute; these are
// simple enough to read directly).
// ============================================================

/** Resolves employee display names for a set of app_user ids -- same
 * "${first_name} ${last_name}" convention app/lib/auth/verifyPin.ts
 * already uses for the kiosk, via the identical single-level app_users ->
 * employees embed. Only ever used for the started-by display (Part
 * "LISTING / LOCATION PICKER" -- name + timestamp only, never other
 * account fields), never as an authorization decision itself -- ownership
 * is always compared by id, not by name. */
export async function resolveEmployeeDisplayNames(supabase: SupabaseClient, appUserIds: string[]): Promise<Map<string, string>> {
  if (appUserIds.length === 0) return new Map();
  const { data, error } = await supabase.from("app_users").select("id, employees(first_name, last_name)").in("id", appUserIds);
  if (error) throw new Error(error.message);

  const names = new Map<string, string>();
  for (const row of data ?? []) {
    const employee = (Array.isArray(row.employees) ? row.employees[0] : row.employees) as { first_name: string; last_name: string } | null;
    names.set(row.id as string, employee ? `${employee.first_name} ${employee.last_name}` : "");
  }
  return names;
}

export interface CycleCountDraftStatus {
  cycleCountId: string;
  locationId: string;
  version: number;
  startedByAppUserId: string;
  startedByName: string;
  startedAt: string;
  /** True only when startedByAppUserId === the caller's own app_user id
   * (Part "OWNERSHIP RULE") -- the ONLY thing canResume is derived from. */
  isOwnedByCurrentManager: boolean;
  canResume: boolean;
}

/** DRAFT cycle counts per location, for the location picker (Part
 * "LISTING / LOCATION PICKER") -- at most one per location by construction
 * (the partial unique index), but this reads generally rather than
 * assuming that. Exposes just enough to explain WHY a location is/isn't
 * resumable by the current manager -- never a full account/user record. */
export async function listCycleCountDraftStatusForOrganization(
  supabase: SupabaseClient,
  organizationId: string,
  currentActorAppUserId: string
): Promise<CycleCountDraftStatus[]> {
  const { data, error } = await supabase
    .from("inventory_cycle_counts")
    .select("id, location_id, version, started_by_app_user_id, started_at")
    .eq("organization_id", organizationId)
    .eq("status", "DRAFT");
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const names = await resolveEmployeeDisplayNames(
    supabase,
    Array.from(new Set(rows.map((row) => row.started_by_app_user_id as string)))
  );

  return rows.map((row) => {
    const startedByAppUserId = row.started_by_app_user_id as string;
    const isOwnedByCurrentManager = startedByAppUserId === currentActorAppUserId;
    return {
      cycleCountId: row.id as string,
      locationId: row.location_id as string,
      version: row.version as number,
      startedByAppUserId,
      startedByName: names.get(startedByAppUserId) ?? "",
      startedAt: row.started_at as string,
      isOwnedByCurrentManager,
      canResume: isOwnedByCurrentManager,
    };
  });
}

export interface CycleCountDetail {
  id: string;
  organizationId: string;
  locationId: string;
  locationName: string;
  status: "DRAFT" | "COMPLETED" | "CANCELLED";
  version: number;
  startedByAppUserId: string;
  startedByName: string;
  startedAt: string;
  completedByAppUserId: string | null;
  completedByName: string | null;
  completedAt: string | null;
  completionNote: string | null;
  cancelledByAppUserId: string | null;
  cancelledByName: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  /** Only meaningful for a DRAFT count -- see this module's OWNERSHIP RULE
   * comments. A COMPLETED/CANCELLED count is viewable by any same-org
   * manager regardless of this flag (Part "HISTORY ACCESS / ORGANIZATION
   * ISOLATION") -- callers must never use this to gate history access. */
  isOwnedByCurrentManager: boolean;
}

export async function getCycleCountDetail(
  supabase: SupabaseClient,
  organizationId: string,
  cycleCountId: string,
  currentActorAppUserId: string
): Promise<CycleCountDetail | null> {
  const { data, error } = await supabase
    .from("inventory_cycle_counts")
    .select(
      "id, organization_id, location_id, status, version, started_by_app_user_id, started_at, completed_by_app_user_id, completed_at, completion_note, cancelled_by_app_user_id, cancelled_at, cancellation_reason, locations(name)"
    )
    .eq("id", cycleCountId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const location = (Array.isArray(data.locations) ? data.locations[0] : data.locations) as { name: string } | null;
  const startedByAppUserId = data.started_by_app_user_id as string;
  const completedByAppUserId = data.completed_by_app_user_id as string | null;
  const cancelledByAppUserId = data.cancelled_by_app_user_id as string | null;
  const namedActorIds = [startedByAppUserId, completedByAppUserId, cancelledByAppUserId].filter((id): id is string => id !== null);
  const names = await resolveEmployeeDisplayNames(supabase, Array.from(new Set(namedActorIds)));

  return {
    id: data.id as string,
    organizationId: data.organization_id as string,
    locationId: data.location_id as string,
    locationName: location?.name ?? "",
    status: data.status as "DRAFT" | "COMPLETED" | "CANCELLED",
    version: data.version as number,
    startedByAppUserId,
    startedByName: names.get(startedByAppUserId) ?? "",
    startedAt: data.started_at as string,
    completedByAppUserId,
    completedByName: completedByAppUserId ? (names.get(completedByAppUserId) ?? "") : null,
    completedAt: data.completed_at as string | null,
    completionNote: data.completion_note as string | null,
    cancelledByAppUserId,
    cancelledByName: cancelledByAppUserId ? (names.get(cancelledByAppUserId) ?? "") : null,
    cancelledAt: data.cancelled_at as string | null,
    cancellationReason: data.cancellation_reason as string | null,
    isOwnedByCurrentManager: startedByAppUserId === currentActorAppUserId,
  };
}

export interface CycleCountLineDetail {
  id: string;
  inventoryItemId: string;
  itemName: string;
  categoryName: string;
  baseUnitCode: string;
  expectedQuantityAtSnapshot: string;
  physicalCountQuantity: string | null;
  /** Provisional "known waste found during counting" marker (Part 22/23)
   * -- non-null means flagged, regardless of whether it has been posted
   * yet. Never implies a ledger write on its own. */
  identifiedWasteQuantity: string | null;
  /** Set only once the identified waste has actually been posted via
   * record_cycle_count_line_waste (Phase F) -- null means still
   * provisional/unresolved. */
  wasteEventId: string | null;
  wasteResolvedAt: string | null;
  /** Populated only for a resolved line (wasteEventId is not null), from
   * the linked inventory_waste_events row -- the reason/note chosen at
   * Review time, never stored redundantly on the line itself. */
  wasteReasonCode: WasteReasonCode | null;
  wasteNote: string | null;
}

/** Every line added to a cycle count so far, in the order added -- includes
 * lines that were added but never counted (physicalCountQuantity null); the
 * caller (UI/review) is responsible for filtering those out where "only
 * counted items" matters (Part 5, 30). */
export async function listCycleCountLines(supabase: SupabaseClient, cycleCountId: string): Promise<CycleCountLineDetail[]> {
  const { data: lineRows, error: lineError } = await supabase
    .from("inventory_cycle_count_lines")
    .select(
      "id, inventory_item_id, base_unit_id, expected_quantity_at_snapshot, physical_count_quantity, identified_waste_quantity, waste_event_id, waste_resolved_at"
    )
    .eq("cycle_count_id", cycleCountId)
    .order("created_at", { ascending: true });
  if (lineError) throw new Error(lineError.message);
  if (!lineRows || lineRows.length === 0) return [];

  const itemIds = Array.from(new Set(lineRows.map((row) => row.inventory_item_id as string)));
  const unitIds = Array.from(new Set(lineRows.map((row) => row.base_unit_id as string)));
  const wasteEventIds = Array.from(new Set(lineRows.map((row) => row.waste_event_id as string | null).filter((id): id is string => id !== null)));

  // Two flat, single-level lookups instead of a nested embed -- this
  // codebase has no existing precedent for a two-level PostgREST embed
  // (item -> category), so a plain single-level select per table (already
  // used everywhere else) is the safer, house-consistent choice.
  const [{ data: itemRows, error: itemError }, { data: unitRows, error: unitError }, { data: wasteRows, error: wasteError }] = await Promise.all([
    supabase.from("inventory_items").select("id, name, category_id, inventory_categories(name)").in("id", itemIds),
    supabase.from("units").select("id, code").in("id", unitIds),
    wasteEventIds.length > 0
      ? supabase.from("inventory_waste_events").select("id, reason_code, note").in("id", wasteEventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (itemError) throw new Error(itemError.message);
  if (unitError) throw new Error(unitError.message);
  if (wasteError) throw new Error(wasteError.message);

  const unitCodeById = new Map((unitRows ?? []).map((row) => [row.id as string, row.code as string]));
  const itemById = new Map(
    (itemRows ?? []).map((row) => {
      const category = (Array.isArray(row.inventory_categories) ? row.inventory_categories[0] : row.inventory_categories) as { name: string } | null;
      return [row.id as string, { name: row.name as string, categoryName: category?.name ?? "" }];
    })
  );
  const wasteById = new Map(
    (wasteRows ?? []).map((row) => [row.id as string, { reasonCode: row.reason_code as WasteReasonCode, note: row.note as string | null }])
  );

  return lineRows.map((row) => {
    const item = itemById.get(row.inventory_item_id as string);
    const wasteEventId = row.waste_event_id as string | null;
    const waste = wasteEventId ? wasteById.get(wasteEventId) : undefined;
    return {
      id: row.id as string,
      inventoryItemId: row.inventory_item_id as string,
      itemName: item?.name ?? "",
      categoryName: item?.categoryName ?? "",
      baseUnitCode: unitCodeById.get(row.base_unit_id as string) ?? "",
      expectedQuantityAtSnapshot: String(row.expected_quantity_at_snapshot),
      identifiedWasteQuantity: row.identified_waste_quantity === null ? null : String(row.identified_waste_quantity),
      wasteEventId,
      wasteResolvedAt: row.waste_resolved_at as string | null,
      wasteReasonCode: waste?.reasonCode ?? null,
      wasteNote: waste?.note ?? null,
      physicalCountQuantity: row.physical_count_quantity === null ? null : String(row.physical_count_quantity),
    };
  });
}

export interface MarkCycleCountLineKnownWasteResult {
  lineId: string;
  identifiedWasteQuantity: string | null;
}

/**
 * Provisional "known waste found during counting" marker (Part 22/23) --
 * never touches the ledger, never creates an inventory_waste_event. A
 * null quantity clears a previous flag. The manager keeps counting other
 * items after this call; nothing is posted until Review explicitly
 * records it (recordCycleCountLineWaste below).
 */
export async function markCycleCountLineKnownWaste(
  supabase: SupabaseClient,
  input: { cycleCountId: string; inventoryItemId: string; identifiedWasteQuantity: string | null; actorAppUserId: string }
): Promise<MarkCycleCountLineKnownWasteResult> {
  const { data, error } = await supabase.rpc("mark_cycle_count_line_known_waste", {
    p_cycle_count_id: input.cycleCountId,
    p_inventory_item_id: input.inventoryItemId,
    p_identified_waste_quantity: input.identifiedWasteQuantity,
    p_actor_app_user_id: input.actorAppUserId,
  });
  if (error) throw mapCycleCountWasteRpcError(error);

  const row = (Array.isArray(data) ? data[0] : data) as { out_line_id: string; out_identified_waste_quantity: string | number | null } | undefined;
  if (!row) throw new Error("mark_cycle_count_line_known_waste returned no result row");

  return {
    lineId: row.out_line_id,
    identifiedWasteQuantity: row.out_identified_waste_quantity === null ? null : String(row.out_identified_waste_quantity),
  };
}

export interface RecordCycleCountLineWasteResult {
  wasteEventId: string;
  cycleCountLineId: string;
  quantity: string;
  unitCode: string;
  newExpectedQuantity: string;
  replayed: boolean;
}

/**
 * The atomic, safe record-and-re-anchor operation (Part 26/27) -- the
 * ONLY place a cycle-count-identified waste actually posts. Locks the
 * cycle count row, verifies ownership, locks (org, item, location),
 * re-verifies the line's ledger watermark still matches its snapshot
 * (StaleCycleCountLine-style refusal otherwise, via
 * CycleCountWasteStaleError/GA030 -- zero waste written), then creates
 * the Inventory Waste event + WASTE movement and re-anchors this line's
 * expected_quantity_at_snapshot/ledger_line_count_at_snapshot to the
 * POST-waste authoritative values while preserving physicalCountQuantity
 * exactly. clientRequestId makes retries safe the same way every other
 * write RPC in this schema is.
 */
export async function recordCycleCountLineWaste(
  supabase: SupabaseClient,
  input: {
    cycleCountId: string;
    inventoryItemId: string;
    reasonCode: WasteReasonCode;
    note?: string | null;
    actorAppUserId: string;
    clientRequestId: string;
  }
): Promise<RecordCycleCountLineWasteResult> {
  const { data, error } = await supabase.rpc("record_cycle_count_line_waste", {
    p_cycle_count_id: input.cycleCountId,
    p_inventory_item_id: input.inventoryItemId,
    p_reason_code: input.reasonCode,
    p_note: input.note ?? null,
    p_actor_app_user_id: input.actorAppUserId,
    p_client_request_id: input.clientRequestId,
  });
  if (error) throw mapCycleCountWasteRpcError(error);

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_waste_event_id: string;
        out_cycle_count_line_id: string;
        out_quantity: string | number;
        out_unit_code: string;
        out_new_expected_quantity: string | number;
        out_replayed: boolean;
      }
    | undefined;
  if (!row) throw new Error("record_cycle_count_line_waste returned no result row");

  return {
    wasteEventId: row.out_waste_event_id,
    cycleCountLineId: row.out_cycle_count_line_id,
    quantity: String(row.out_quantity),
    unitCode: row.out_unit_code,
    newExpectedQuantity: String(row.out_new_expected_quantity),
    replayed: row.out_replayed,
  };
}

export interface CycleCountSearchableItem {
  id: string;
  name: string;
  categoryName: string;
  baseUnitId: string;
  baseUnitCode: string;
}

/** Every ACTIVE item in the org, unfiltered by stock (Part 6 -- unlike the
 * kiosk's withdrawal grid, cycle count must be able to add an item the
 * system currently believes has zero stock anywhere). Small enough per
 * organization for client-side search/filtering, same assumption the kiosk
 * item grid already makes. */
export async function listActiveInventoryItemsForCycleCount(supabase: SupabaseClient, organizationId: string): Promise<CycleCountSearchableItem[]> {
  const { data, error } = await supabase
    .from("inventory_items")
    .select("id, name, base_unit_id, category_id, inventory_categories(name), units(code)")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const category = (Array.isArray(row.inventory_categories) ? row.inventory_categories[0] : row.inventory_categories) as { name: string } | null;
    const unit = (Array.isArray(row.units) ? row.units[0] : row.units) as { code: string } | null;
    return {
      id: row.id as string,
      name: row.name as string,
      categoryName: category?.name ?? "",
      baseUnitId: row.base_unit_id as string,
      baseUnitCode: unit?.code ?? "",
    };
  });
}

export interface StorageEligibleLocation {
  id: string;
  name: string;
}

/** Active, storage-eligible locations only (Part 4) -- a station/business
 * location is never a valid cycle-count scope, even if active. */
export async function listStorageEligibleLocations(supabase: SupabaseClient, organizationId: string): Promise<StorageEligibleLocation[]> {
  const { data, error } = await supabase
    .from("locations")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .eq("is_storage_eligible", true)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({ id: row.id as string, name: row.name as string }));
}

export interface CycleCountSummary {
  cycleCountId: string;
  locationId: string;
  locationName: string;
  status: "DRAFT" | "COMPLETED" | "CANCELLED";
  version: number;
  startedByAppUserId: string;
  startedByName: string;
  startedAt: string;
  completedByAppUserId: string | null;
  completedByName: string | null;
  completedAt: string | null;
  completionNote: string | null;
  cancelledByAppUserId: string | null;
  cancelledByName: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  /** Lines with an explicit physical observation only -- never counts a
   * blank/unobserved display row (Part "COUNT SUMMARY / VARIANCE COUNT"). */
  countedItemCount: number;
  /** Counted lines whose physical count differs from their (already
   * completion-time-verified, never re-read live) expected snapshot. */
  varianceItemCount: number;
  isOwnedByCurrentManager: boolean;
}

/**
 * ONE query for a whole page of cycle-count summaries (Part "HISTORY
 * PERFORMANCE") -- serves both the hub's "in progress" section
 * (statuses: ["DRAFT"]) and its history section (statuses defaults to
 * COMPLETED + CANCELLED), via list_cycle_count_summaries
 * (20260811100083), which itself aggregates countedItemCount/
 * varianceItemCount with a single lateral join, never once per row.
 */
export async function listCycleCountSummaries(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    currentActorAppUserId: string;
    statuses?: ("DRAFT" | "COMPLETED" | "CANCELLED")[];
    locationId?: string | null;
    limit?: number;
  }
): Promise<CycleCountSummary[]> {
  const { data, error } = await supabase.rpc("list_cycle_count_summaries", {
    p_organization_id: input.organizationId,
    p_statuses: input.statuses ?? ["COMPLETED", "CANCELLED"],
    p_location_id: input.locationId ?? null,
    p_limit: input.limit ?? 50,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as {
    out_cycle_count_id: string;
    out_location_id: string;
    out_location_name: string;
    out_status: "DRAFT" | "COMPLETED" | "CANCELLED";
    out_version: number;
    out_started_by_app_user_id: string;
    out_started_at: string;
    out_completed_by_app_user_id: string | null;
    out_completed_at: string | null;
    out_cancelled_by_app_user_id: string | null;
    out_cancelled_at: string | null;
    out_cancellation_reason: string | null;
    out_completion_note: string | null;
    out_counted_item_count: number;
    out_variance_item_count: number;
  }[];

  const namedActorIds = rows.flatMap((row) => [row.out_started_by_app_user_id, row.out_completed_by_app_user_id, row.out_cancelled_by_app_user_id]);
  const names = await resolveEmployeeDisplayNames(
    supabase,
    Array.from(new Set(namedActorIds.filter((id): id is string => id !== null)))
  );

  return rows.map((row) => ({
    cycleCountId: row.out_cycle_count_id,
    locationId: row.out_location_id,
    locationName: row.out_location_name,
    status: row.out_status,
    version: row.out_version,
    startedByAppUserId: row.out_started_by_app_user_id,
    startedByName: names.get(row.out_started_by_app_user_id) ?? "",
    startedAt: row.out_started_at,
    completedByAppUserId: row.out_completed_by_app_user_id,
    completedByName: row.out_completed_by_app_user_id ? (names.get(row.out_completed_by_app_user_id) ?? "") : null,
    completedAt: row.out_completed_at,
    completionNote: row.out_completion_note,
    cancelledByAppUserId: row.out_cancelled_by_app_user_id,
    cancelledByName: row.out_cancelled_by_app_user_id ? (names.get(row.out_cancelled_by_app_user_id) ?? "") : null,
    cancelledAt: row.out_cancelled_at,
    cancellationReason: row.out_cancellation_reason,
    countedItemCount: row.out_counted_item_count,
    varianceItemCount: row.out_variance_item_count,
    isOwnedByCurrentManager: row.out_started_by_app_user_id === input.currentActorAppUserId,
  }));
}
