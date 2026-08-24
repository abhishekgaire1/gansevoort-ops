import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmployeeDisplayNames } from "@/app/lib/inventory/cycleCounts";

/**
 * Inventory Item Detail Overview + Usage milestone -- Overview-tab-only
 * read helpers (Last Received + the compact Today/7-day/30-day
 * withdrawal totals). Both wrap the two new focused RPCs
 * (get_inventory_item_last_received / get_inventory_item_usage_totals,
 * 20260811100092). Usage-by-station/trend live in itemUsage.ts.
 */

export interface InventoryItemLastReceived {
  occurredAt: string;
  quantity: number;
  baseUnitCode: string;
  actor: { appUserId: string; name: string | null } | null;
  purchaseDocument: { id: string; documentNumber: string | null } | null;
  vendor: { id: string; name: string } | null;
  /** Dollars per base unit for THIS specific receiving line, derived from
   * line_total / posted_base_quantity server-side -- never a client-side
   * unit conversion. Null whenever the underlying invoice line's total
   * wasn't captured; the caller must omit the field, never show $0
   * (Part 6/7). */
  unitCost: number | null;
}

interface LastReceivedRow {
  out_movement_line_id: string;
  out_occurred_at: string;
  out_quantity: string | number;
  out_base_unit_code: string;
  out_performed_by_app_user_id: string | null;
  out_purchase_document_id: string | null;
  out_document_number: string | null;
  out_vendor_id: string | null;
  out_vendor_name: string | null;
  out_unit_cost: string | number | null;
}

/**
 * Overview's "Last Received" section. Null when this item has never had a
 * PURCHASE_RECEIPT movement at this exact location -- never manufactured
 * from opening stock/legacy allocation (Part 6).
 */
export async function getInventoryItemLastReceived(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  locationId: string
): Promise<InventoryItemLastReceived | null> {
  const { data, error } = await supabase.rpc("get_inventory_item_last_received", {
    p_organization_id: organizationId,
    p_inventory_item_id: inventoryItemId,
    p_location_id: locationId,
  });
  if (error) throw new Error(error.message);

  const row = (Array.isArray(data) ? data[0] : data) as LastReceivedRow | undefined;
  if (!row) return null;

  const names = row.out_performed_by_app_user_id ? await resolveEmployeeDisplayNames(supabase, [row.out_performed_by_app_user_id]) : new Map<string, string>();

  return {
    occurredAt: row.out_occurred_at,
    quantity: Number(row.out_quantity),
    baseUnitCode: row.out_base_unit_code,
    actor: row.out_performed_by_app_user_id
      ? { appUserId: row.out_performed_by_app_user_id, name: names.get(row.out_performed_by_app_user_id) || null }
      : null,
    purchaseDocument: row.out_purchase_document_id ? { id: row.out_purchase_document_id, documentNumber: row.out_document_number } : null,
    vendor: row.out_vendor_id && row.out_vendor_name ? { id: row.out_vendor_id, name: row.out_vendor_name } : null,
    unitCost: row.out_unit_cost === null ? null : Number(row.out_unit_cost),
  };
}

export interface InventoryItemUsageTotals {
  baseUnitCode: string;
  today: number;
  sevenDay: number;
  thirtyDay: number;
}

interface UsageTotalsRow {
  out_base_unit_code: string | null;
  out_today_quantity: string | number;
  out_seven_day_quantity: string | number;
  out_thirty_day_quantity: string | number;
}

/**
 * Overview's compact "Recent Withdrawals" summary -- ISSUE_TO_STATION
 * only (Part 10). Always returns zeros rather than null (a real, known
 * zero is a legitimate, immediately-renderable fact, unlike an unproven
 * cost -- Part 33's "do not flash 0 before load" is about the LOADING
 * state, not about a genuinely-zero result once loaded).
 */
export async function getInventoryItemUsageTotals(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  locationId: string
): Promise<InventoryItemUsageTotals> {
  const { data, error } = await supabase.rpc("get_inventory_item_usage_totals", {
    p_organization_id: organizationId,
    p_inventory_item_id: inventoryItemId,
    p_location_id: locationId,
  });
  if (error) throw new Error(error.message);

  const row = (Array.isArray(data) ? data[0] : data) as UsageTotalsRow | undefined;
  return {
    baseUnitCode: row?.out_base_unit_code ?? "",
    today: Number(row?.out_today_quantity ?? 0),
    sevenDay: Number(row?.out_seven_day_quantity ?? 0),
    thirtyDay: Number(row?.out_thirty_day_quantity ?? 0),
  };
}
