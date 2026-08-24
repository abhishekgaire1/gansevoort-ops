import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** V1 Reports foundation -- Inventory Usage (Section 32). Withdrawals TO
 * STATIONS only -- never "consumption"/"sales usage" (V1 has no Sales
 * data). Quantities are only ever summed within one item + base unit,
 * never across incompatible units. */
export interface UsageReportItemRow {
  itemId: string;
  itemName: string;
  baseUnitCode: string;
  quantity: number;
}

export interface UsageReportStationRow {
  stationId: string | null;
  stationName: string;
  movementCount: number;
}

export interface UsageReport {
  movementCount: number;
  byItem: UsageReportItemRow[];
  byStation: UsageReportStationRow[];
}

export interface UsageReportFilters {
  stationId?: string | null;
  inventoryItemId?: string | null;
  locationId?: string | null;
}

export async function getUsageReport(
  supabase: SupabaseClient,
  organizationId: string,
  dateFrom: string,
  dateTo: string,
  filters: UsageReportFilters = {}
): Promise<UsageReport> {
  const { data, error } = await supabase.rpc("get_inventory_usage_report", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_station_id: filters.stationId ?? null,
    p_inventory_item_id: filters.inventoryItemId ?? null,
    p_location_id: filters.locationId ?? null,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as Partial<UsageReport>;
  return { movementCount: row.movementCount ?? 0, byItem: row.byItem ?? [], byStation: row.byStation ?? [] };
}
