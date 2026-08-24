import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmployeeDisplayNames } from "@/app/lib/inventory/cycleCounts";
import { movementTypesForFilter, type ActivityTypeFilter } from "@/app/lib/inventory/activityTypeFilters";
import { mapBaseActivityRow, type InventoryActivityEntry, type InventoryMovementType, type BaseActivityRow } from "@/app/lib/inventory/activityTypes";

export type { ActivityTypeFilter, InventoryActivityEntry, InventoryMovementType };

/**
 * Inventory Item Detail + Activity History milestone -- a READ VIEW over
 * the existing authoritative ledger (inventory_movements/
 * inventory_movement_lines) and its existing source records. This file
 * never writes anything; it only shapes list_inventory_balances_for_item
 * and list_inventory_item_activity (20260811100089) into
 * presentation-friendly objects. No new "history" system, no duplicated
 * ledger data.
 */

export interface InventoryItemLocationSummary {
  inventoryItemId: string;
  itemName: string;
  locationId: string;
  locationName: string;
  /** The location's own IANA timezone (locations.timezone) -- the SAME
   * value every write RPC's business_date logic already uses. Overview's
   * Today/7-day/30-day windows and Usage's period buckets both need this
   * to avoid introducing a second timezone convention. */
  locationTimezone: string;
  baseUnitCode: string;
  balance: number;
  fullReferenceQuantity: number | null;
  referenceSource: "RESTOCK" | "MANAGER_OVERRIDE" | null;
  includesLegacyEstimate: boolean;
}

/**
 * The detail page's stock summary -- CURRENT STOCK/FULL LEVEL/STATUS must
 * use the SAME authoritative balance logic as Current Inventory (Part
 * 18), never a sum over whatever activity rows happen to be loaded. This
 * reuses list_inventory_balances_for_item (20260811100075, already the
 * kiosk's own authoritative per-item balance read), scoped down to the
 * one requested location -- never a new balance formula.
 *
 * Returns null when the item or location does not exist in this
 * organization (never distinguishes "wrong org" from "doesn't exist" --
 * that would leak cross-org existence). A location genuinely never
 * touched by this item (balance always exactly zero, no rows at all in
 * the RPC's UNIONed location set) is NOT an error -- it renders as a
 * legitimate zero-balance summary.
 */
export async function getInventoryItemLocationSummary(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  locationId: string
): Promise<InventoryItemLocationSummary | null> {
  const { data: item, error: itemError } = await supabase
    .from("inventory_items")
    .select("id, name, units(code)")
    .eq("id", inventoryItemId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (itemError) throw new Error(itemError.message);
  if (!item) return null;

  const { data: location, error: locationError } = await supabase
    .from("locations")
    .select("id, name, timezone")
    .eq("id", locationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (locationError) throw new Error(locationError.message);
  if (!location) return null;

  const itemUnit = Array.isArray(item.units) ? item.units[0] : item.units;

  const { data, error } = await supabase.rpc("list_inventory_balances_for_item", {
    p_organization_id: organizationId,
    p_inventory_item_id: inventoryItemId,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Record<string, unknown>[];
  const row = rows.find((r) => r.out_location_id === locationId);

  if (!row) {
    return {
      inventoryItemId,
      itemName: item.name as string,
      locationId,
      locationName: location.name as string,
      locationTimezone: location.timezone as string,
      baseUnitCode: (itemUnit?.code as string | undefined) ?? "",
      balance: 0,
      fullReferenceQuantity: null,
      referenceSource: null,
      includesLegacyEstimate: false,
    };
  }

  return {
    inventoryItemId,
    itemName: item.name as string,
    locationId,
    locationName: location.name as string,
    locationTimezone: location.timezone as string,
    baseUnitCode: row.out_base_unit_code as string,
    balance: Number(row.out_balance),
    fullReferenceQuantity: row.out_full_reference_quantity === null ? null : Number(row.out_full_reference_quantity),
    referenceSource: (row.out_reference_source as "RESTOCK" | "MANAGER_OVERRIDE" | null) ?? null,
    includesLegacyEstimate: row.out_includes_legacy_estimate === true,
  };
}

export interface ListInventoryItemActivityInput {
  organizationId: string;
  inventoryItemId: string;
  locationId: string;
  filter?: ActivityTypeFilter;
  beforeOccurredAt?: string | null;
  beforeId?: string | null;
  limit?: number;
}

export interface InventoryItemActivityPage {
  entries: InventoryActivityEntry[];
  nextCursor: { occurredAt: string; id: string } | null;
}

const DEFAULT_PAGE_SIZE = 30;

export async function listInventoryItemActivity(
  supabase: SupabaseClient,
  input: ListInventoryItemActivityInput
): Promise<InventoryItemActivityPage> {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const movementTypes = movementTypesForFilter(input.filter ?? "ALL");

  const { data, error } = await supabase.rpc("list_inventory_item_activity", {
    p_organization_id: input.organizationId,
    p_inventory_item_id: input.inventoryItemId,
    p_location_id: input.locationId,
    p_movement_types: movementTypes,
    p_before_occurred_at: input.beforeOccurredAt ?? null,
    p_before_id: input.beforeId ?? null,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as BaseActivityRow[];

  const actorIds = Array.from(new Set(rows.map((r) => r.out_performed_by_app_user_id).filter((v): v is string => v !== null)));
  const names = await resolveEmployeeDisplayNames(supabase, actorIds);

  const entries: InventoryActivityEntry[] = rows.map((row) =>
    mapBaseActivityRow(row, row.out_performed_by_app_user_id ? names.get(row.out_performed_by_app_user_id) || null : null)
  );

  const last = entries[entries.length - 1];
  const nextCursor = entries.length === limit && last ? { occurredAt: last.occurredAt, id: last.id } : null;

  return { entries, nextCursor };
}
