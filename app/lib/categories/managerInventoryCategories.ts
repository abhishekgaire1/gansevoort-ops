import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listInventoryBalances } from "@/app/lib/inventory/listInventoryBalances";
import { computeStockGauge, type StockLevel } from "@/app/lib/inventory/stockLevel";

/**
 * Manager Categories milestone -- Inventory Category list/detail read
 * model. Reuses the EXISTING authoritative balance logic
 * (listInventoryBalances / computeStockGauge, the same ones Current
 * Inventory itself uses) rather than inventing a second inventory-balance
 * formula (Part 20/46). Never sums quantities across incompatible units
 * (Part 21/44) -- every item keeps its own unit-qualified balance; there
 * is no category-level "total stock" number anywhere here.
 */

export interface ManagerInventoryCategorySummary {
  categoryId: string;
  name: string;
  itemCount: number;
}

export async function listManagerInventoryCategories(supabase: SupabaseClient, organizationId: string): Promise<ManagerInventoryCategorySummary[]> {
  const [{ data: categories, error: catError }, { data: countRows, error: countError }] = await Promise.all([
    supabase.from("inventory_categories").select("id, name").eq("organization_id", organizationId).eq("is_active", true).order("name"),
    supabase.rpc("get_inventory_category_item_counts", { p_organization_id: organizationId }),
  ]);
  if (catError) throw new Error(catError.message);
  if (countError) throw new Error(countError.message);

  const countByCategoryId = new Map(((countRows ?? []) as { out_category_id: string; out_item_count: number }[]).map((r) => [r.out_category_id, Number(r.out_item_count)]));

  return (categories ?? []).map((c) => ({
    categoryId: c.id as string,
    name: c.name as string,
    itemCount: countByCategoryId.get(c.id as string) ?? 0,
  }));
}

export interface ManagerInventoryCategoryDetail {
  categoryId: string;
  name: string;
  isActive: boolean;
}

export async function getManagerInventoryCategory(supabase: SupabaseClient, organizationId: string, categoryId: string): Promise<ManagerInventoryCategoryDetail | null> {
  const { data, error } = await supabase.from("inventory_categories").select("id, name, is_active").eq("organization_id", organizationId).eq("id", categoryId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { categoryId: data.id as string, name: data.name as string, isActive: data.is_active as boolean };
}

export interface ManagerInventoryCategoryItem {
  itemId: string;
  itemNumber: string | null;
  name: string;
  locationId: string;
  locationName: string;
  baseUnitCode: string;
  balance: number;
  fullReferenceQuantity: number | null;
  level: StockLevel | null;
  levelLabel: string;
}

/** Active, CONFIRMED, INVENTORY-disposition items only -- the actual
 * Item Master catalog for this category, matching what Admin -> Item
 * Master and Receiving both already treat as "the catalog." Balances
 * come from the SAME org-wide listInventoryBalances() every other
 * inventory read uses, filtered down to this category's item ids in
 * TypeScript rather than a second query per item (no N+1). */
export async function listManagerInventoryCategoryItems(supabase: SupabaseClient, organizationId: string, categoryId: string): Promise<ManagerInventoryCategoryItem[]> {
  const { data: items, error } = await supabase
    .from("inventory_items")
    .select("id, item_number, name")
    .eq("organization_id", organizationId)
    .eq("category_id", categoryId)
    .eq("disposition", "INVENTORY")
    .eq("approval_status", "CONFIRMED")
    .eq("status", "active")
    .order("name");
  if (error) throw new Error(error.message);
  if (!items || items.length === 0) return [];

  const itemMetaById = new Map(items.map((i) => [i.id as string, { itemNumber: i.item_number as string | null, name: i.name as string }]));
  const balances = await listInventoryBalances(supabase, organizationId);

  const rows: ManagerInventoryCategoryItem[] = [];
  for (const balance of balances) {
    const meta = itemMetaById.get(balance.inventoryItemId);
    if (!meta) continue;
    const gauge = computeStockGauge(balance.balance, balance.fullReferenceQuantity);
    rows.push({
      itemId: balance.inventoryItemId,
      itemNumber: meta.itemNumber,
      name: meta.name,
      locationId: balance.locationId,
      locationName: balance.locationName,
      baseUnitCode: balance.baseUnitCode,
      balance: balance.balance,
      fullReferenceQuantity: balance.fullReferenceQuantity,
      level: gauge.level,
      levelLabel: gauge.label,
    });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
