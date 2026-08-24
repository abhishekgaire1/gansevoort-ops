import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * V1 Reports foundation -- Purchasing report read model. Thin TS
 * wrappers over get_purchasing_report / get_purchasing_report_price_changes
 * (20260811100108) -- both single-round-trip, server-aggregated RPCs; this
 * file does no aggregation of its own, only shape mapping.
 */

export interface PurchasingReportBreakdownRow {
  id: string | null;
  name: string;
  totalValue: number;
}

export interface PurchasingReportSummary {
  totalPurchaseValue: number;
  documentCount: number;
  vendorCount: number;
  itemCount: number;
  byVendor: PurchasingReportBreakdownRow[];
  byCategory: PurchasingReportBreakdownRow[];
  byItem: PurchasingReportBreakdownRow[];
}

export interface PurchasingReportFilters {
  vendorId?: string | null;
  inventoryCategoryId?: string | null;
  inventoryItemId?: string | null;
}

export async function getPurchasingReport(
  supabase: SupabaseClient,
  organizationId: string,
  dateFrom: string,
  dateTo: string,
  filters: PurchasingReportFilters = {}
): Promise<PurchasingReportSummary> {
  const { data, error } = await supabase.rpc("get_purchasing_report", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_vendor_id: filters.vendorId ?? null,
    p_inventory_category_id: filters.inventoryCategoryId ?? null,
    p_inventory_item_id: filters.inventoryItemId ?? null,
  });
  if (error) throw new Error(error.message);

  const row = (data ?? {}) as Record<string, unknown>;
  const mapRows = (value: unknown): PurchasingReportBreakdownRow[] =>
    ((value as { vendorId?: string; categoryId?: string; itemId?: string; vendorName?: string; categoryName?: string; itemName?: string; totalValue: number }[]) ?? []).map((r) => ({
      id: r.vendorId ?? r.categoryId ?? r.itemId ?? null,
      name: r.vendorName ?? r.categoryName ?? r.itemName ?? "—",
      totalValue: Number(r.totalValue),
    }));

  return {
    totalPurchaseValue: Number(row.totalPurchaseValue ?? 0),
    documentCount: Number(row.documentCount ?? 0),
    vendorCount: Number(row.vendorCount ?? 0),
    itemCount: Number(row.itemCount ?? 0),
    byVendor: mapRows(row.byVendor),
    byCategory: mapRows(row.byCategory),
    byItem: mapRows(row.byItem),
  };
}

export interface PurchasingPriceChangeRow {
  itemId: string;
  itemName: string;
  vendorId: string;
  vendorName: string;
  baseUnitCode: string;
  currentUnitCost: number;
  previousUnitCost: number;
  deltaAbs: number;
  deltaPct: number;
  currentDocumentNumber: string | null;
  currentDocumentDate: string | null;
  previousDocumentNumber: string | null;
  previousDocumentDate: string | null;
}

export interface PurchasingPriceChanges {
  increases: PurchasingPriceChangeRow[];
  decreases: PurchasingPriceChangeRow[];
}

export async function getPurchasingReportPriceChanges(
  supabase: SupabaseClient,
  organizationId: string,
  dateFrom: string,
  dateTo: string,
  vendorId?: string | null,
  inventoryCategoryId?: string | null,
  limit = 10
): Promise<PurchasingPriceChanges> {
  const { data, error } = await supabase.rpc("get_purchasing_report_price_changes", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_vendor_id: vendorId ?? null,
    p_inventory_category_id: inventoryCategoryId ?? null,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);

  const row = (data ?? {}) as { increases?: PurchasingPriceChangeRow[]; decreases?: PurchasingPriceChangeRow[] };
  return { increases: row.increases ?? [], decreases: row.decreases ?? [] };
}
