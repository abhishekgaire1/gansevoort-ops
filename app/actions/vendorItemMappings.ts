"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export interface VendorItemMappingRow {
  id: string;
  vendorId: string;
  matchBasis: "VENDOR_SKU" | "NORMALIZED_DESCRIPTION";
  vendorSku: string | null;
  normalizedDescription: string | null;
  inventoryItemId: string;
  inventoryItemName: string | null;
  isActive: boolean;
  confirmedAt: string | null;
}

export type ListVendorItemMappingsResult = { ok: true; mappings: VendorItemMappingRow[] } | AuthFailure;

/** Active mappings for one vendor -- read-only, for display alongside the
 * vendor's own detail/history. Remapping happens implicitly via
 * upsert_vendor_item_mapping (called from the approve-classification RPCs),
 * never as a standalone edit here. */
export async function listVendorItemMappings(vendorId: string): Promise<ListVendorItemMappingsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const { data } = await supabase
    .from("vendor_item_mappings")
    .select("id, vendor_id, match_basis, vendor_sku, normalized_description, inventory_item_id, is_active, confirmed_at, inventory_items(name)")
    .eq("organization_id", auth.manager.organizationId)
    .eq("vendor_id", vendorId)
    .eq("is_active", true)
    .order("confirmed_at", { ascending: false });

  const mappings: VendorItemMappingRow[] = (data ?? []).map((row) => {
    const item = Array.isArray(row.inventory_items) ? row.inventory_items[0] : row.inventory_items;
    return {
      id: row.id as string,
      vendorId: row.vendor_id as string,
      matchBasis: row.match_basis as "VENDOR_SKU" | "NORMALIZED_DESCRIPTION",
      vendorSku: row.vendor_sku as string | null,
      normalizedDescription: row.normalized_description as string | null,
      inventoryItemId: row.inventory_item_id as string,
      inventoryItemName: (item?.name as string | undefined) ?? null,
      isActive: row.is_active as boolean,
      confirmedAt: row.confirmed_at as string | null,
    };
  });

  return { ok: true, mappings };
}
