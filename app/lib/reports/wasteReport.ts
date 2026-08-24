import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** V1 Reports foundation -- Inventory Waste report (Section 34). Tracked-
 * storage inventory waste only (record_inventory_waste's own scope) --
 * never station/prep/end-day waste, which isn't modeled in V1. */
export interface WasteReportItemRow {
  itemId: string;
  itemName: string;
  unitCode: string;
  quantity: number;
}

export interface WasteReportReasonRow {
  reasonCode: string;
  eventCount: number;
}

export interface WasteReport {
  eventCount: number;
  byItem: WasteReportItemRow[];
  byReason: WasteReportReasonRow[];
}

export interface WasteReportFilters {
  inventoryItemId?: string | null;
  locationId?: string | null;
  reasonCode?: string | null;
  inventoryCategoryId?: string | null;
}

export async function getWasteReport(
  supabase: SupabaseClient,
  organizationId: string,
  dateFrom: string,
  dateTo: string,
  filters: WasteReportFilters = {}
): Promise<WasteReport> {
  const { data, error } = await supabase.rpc("get_inventory_waste_report", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_inventory_item_id: filters.inventoryItemId ?? null,
    p_location_id: filters.locationId ?? null,
    p_reason_code: filters.reasonCode ?? null,
    p_inventory_category_id: filters.inventoryCategoryId ?? null,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as Partial<WasteReport>;
  return { eventCount: row.eventCount ?? 0, byItem: row.byItem ?? [], byReason: row.byReason ?? [] };
}
