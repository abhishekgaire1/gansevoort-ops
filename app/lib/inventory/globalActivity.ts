import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmployeeDisplayNames } from "@/app/lib/inventory/cycleCounts";
import { movementTypesForFilter, type ActivityTypeFilter } from "@/app/lib/inventory/activityTypeFilters";
import { mapBaseActivityRow, type InventoryActivityEntry, type BaseActivityRow } from "@/app/lib/inventory/activityTypes";

/**
 * Global Inventory Activity milestone -- an org-wide READ VIEW over the
 * SAME ledger list_inventory_item_activity (itemActivity.ts) already
 * reads, via the new list_inventory_activity RPC (20260811100090). Never
 * a second timeline implementation: row shaping is shared through
 * mapBaseActivityRow (activityTypes.ts); only the extra item/location
 * identity fields (implicit and therefore omitted on the item-scoped
 * page) are added here.
 */

export interface GlobalInventoryActivityEntry extends InventoryActivityEntry {
  inventoryItemId: string;
  itemName: string;
  locationId: string;
  locationName: string;
}

interface GlobalActivityRow extends BaseActivityRow {
  out_inventory_item_id: string;
  out_item_name: string;
  out_location_id: string;
  out_location_name: string;
}

export interface ListInventoryActivityInput {
  organizationId: string;
  search?: string | null;
  filter?: ActivityTypeFilter;
  locationId?: string | null;
  employeeAppUserId?: string | null;
  stationId?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  beforeOccurredAt?: string | null;
  beforeId?: string | null;
  limit?: number;
}

export interface InventoryActivityPage {
  entries: GlobalInventoryActivityEntry[];
  nextCursor: { occurredAt: string; id: string } | null;
}

const DEFAULT_PAGE_SIZE = 30;

export async function listInventoryActivity(supabase: SupabaseClient, input: ListInventoryActivityInput): Promise<InventoryActivityPage> {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const movementTypes = movementTypesForFilter(input.filter ?? "ALL");

  const { data, error } = await supabase.rpc("list_inventory_activity", {
    p_organization_id: input.organizationId,
    p_search: input.search?.trim() ? input.search.trim() : null,
    p_movement_types: movementTypes,
    p_location_id: input.locationId ?? null,
    p_employee_app_user_id: input.employeeAppUserId ?? null,
    p_station_id: input.stationId ?? null,
    p_from_date: input.fromDate ?? null,
    p_to_date: input.toDate ?? null,
    p_before_occurred_at: input.beforeOccurredAt ?? null,
    p_before_id: input.beforeId ?? null,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as GlobalActivityRow[];

  const actorIds = Array.from(new Set(rows.map((r) => r.out_performed_by_app_user_id).filter((v): v is string => v !== null)));
  const names = await resolveEmployeeDisplayNames(supabase, actorIds);

  const entries: GlobalInventoryActivityEntry[] = rows.map((row) => ({
    ...mapBaseActivityRow(row, row.out_performed_by_app_user_id ? names.get(row.out_performed_by_app_user_id) || null : null),
    inventoryItemId: row.out_inventory_item_id,
    itemName: row.out_item_name,
    locationId: row.out_location_id,
    locationName: row.out_location_name,
  }));

  const last = entries[entries.length - 1];
  const nextCursor = entries.length === limit && last ? { occurredAt: last.occurredAt, id: last.id } : null;

  return { entries, nextCursor };
}

export type GlobalActivityDetail = GlobalInventoryActivityEntry;

/**
 * One movement line's full detail, by its own id -- the same identity
 * the feed's "View →" link and the detail route
 * (/manager/inventory/activity/[movementLineId]) use. A precise,
 * dedicated RPC (get_inventory_activity_detail, 20260811100091), never a
 * page-walk over list_inventory_activity -- same join shape, filtered
 * directly to one line, so it stays correct and O(1) regardless of how
 * much activity history exists.
 */
export async function getInventoryActivityDetail(
  supabase: SupabaseClient,
  organizationId: string,
  movementLineId: string
): Promise<GlobalActivityDetail | null> {
  const { data, error } = await supabase.rpc("get_inventory_activity_detail", {
    p_organization_id: organizationId,
    p_movement_line_id: movementLineId,
  });
  if (error) throw new Error(error.message);

  const row = (Array.isArray(data) ? data[0] : data) as GlobalActivityRow | undefined;
  if (!row) return null;

  const names = row.out_performed_by_app_user_id ? await resolveEmployeeDisplayNames(supabase, [row.out_performed_by_app_user_id]) : new Map<string, string>();

  return {
    ...mapBaseActivityRow(row, row.out_performed_by_app_user_id ? names.get(row.out_performed_by_app_user_id) || null : null),
    inventoryItemId: row.out_inventory_item_id,
    itemName: row.out_item_name,
    locationId: row.out_location_id,
    locationName: row.out_location_name,
  };
}
