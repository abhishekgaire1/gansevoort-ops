import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UsagePeriod, CustomUsageRange } from "@/app/lib/inventory/usagePeriods";

/**
 * Inventory Item Detail Overview + Usage milestone -- the Usage tab's
 * primary read model: withdrawals aggregated by destination station,
 * plus a daily trend for the 7-day/30-day/Custom periods (Today has no
 * trend -- Part 19). Wraps get_inventory_item_usage_by_station /
 * get_inventory_item_usage_trend (20260811100092, extended for CUSTOM by
 * 20260811100093). "Usage" here means ONLY ISSUE_TO_STATION movement
 * lines -- never receiving, Waste, or Cycle Count adjustment (Part 1/10).
 *
 * No withdrawal-correction/reversal movement type exists anywhere in
 * this schema yet (confirmed against the actual live schema before
 * writing this file) -- the prior Global Inventory Activity milestone's
 * own Phase D report stopped short of implementing one specifically
 * because no existing movement_type could represent it truthfully. This
 * read model therefore has nothing to net against: summing
 * ISSUE_TO_STATION lines directly IS already the current, correct net
 * business effect. If a correction mechanism is added later, this file
 * (not the UI) is where its net-effect handling must go.
 */

export interface UsageByStation {
  stationId: string;
  stationName: string;
  quantity: number;
  percentage: number;
}

export interface InventoryItemUsageByStation {
  baseUnitCode: string;
  total: number;
  byStation: UsageByStation[];
}

interface UsageByStationRow {
  out_station_id: string;
  out_station_name: string;
  out_quantity: string | number;
  out_base_unit_code: string | null;
}

export async function getInventoryItemUsageByStation(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  locationId: string,
  period: UsagePeriod,
  customRange?: CustomUsageRange | null
): Promise<InventoryItemUsageByStation> {
  const { data, error } = await supabase.rpc("get_inventory_item_usage_by_station", {
    p_organization_id: organizationId,
    p_inventory_item_id: inventoryItemId,
    p_location_id: locationId,
    p_period: period,
    p_custom_start: period === "CUSTOM" ? (customRange?.start ?? null) : null,
    p_custom_end: period === "CUSTOM" ? (customRange?.end ?? null) : null,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as UsageByStationRow[];
  const total = rows.reduce((sum, r) => sum + Number(r.out_quantity), 0);

  return {
    baseUnitCode: rows[0]?.out_base_unit_code ?? "",
    total,
    byStation: rows.map((r) => ({
      stationId: r.out_station_id,
      stationName: r.out_station_name,
      quantity: Number(r.out_quantity),
      percentage: total > 0 ? (Number(r.out_quantity) / total) * 100 : 0,
    })),
  };
}

export interface RawUsageTrendPoint {
  date: string;
  quantity: number;
}

interface UsageTrendRow {
  out_bucket_date: string;
  out_quantity: string | number;
}

/** Sparse -- a day with zero withdrawals produces no row. Zero-filling
 * for a continuous chart is presentation-layer work (see
 * usagePresentation.ts's zeroFillUsageTrend), deliberately not done
 * here. */
export async function getInventoryItemUsageTrend(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  locationId: string,
  period: "SEVEN_DAYS" | "THIRTY_DAYS" | "CUSTOM",
  customRange?: CustomUsageRange | null
): Promise<RawUsageTrendPoint[]> {
  const { data, error } = await supabase.rpc("get_inventory_item_usage_trend", {
    p_organization_id: organizationId,
    p_inventory_item_id: inventoryItemId,
    p_location_id: locationId,
    p_period: period,
    p_custom_start: period === "CUSTOM" ? (customRange?.start ?? null) : null,
    p_custom_end: period === "CUSTOM" ? (customRange?.end ?? null) : null,
  });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as UsageTrendRow[];
  return rows.map((r) => ({ date: r.out_bucket_date, quantity: Number(r.out_quantity) }));
}
