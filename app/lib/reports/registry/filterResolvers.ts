import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FilterResolutionOutcome } from "@/app/lib/reports/registry/types";

/**
 * General Report Builder -- shared name-to-id filter resolution
 * (Section 8 "Filters"). Mirrors the EXACT pattern already established
 * by itemPurchaseCost.ts's resolveItemByName: an exact, case-insensitive
 * match against the organization's own master-data table wins outright
 * (item/vendor/category/location/station names are effectively unique
 * per organization in practice); a substring fallback only applies when
 * no exact match exists, and any multi-match result is reported as
 * ambiguous rather than silently guessed. The model only ever supplies a
 * raw search string -- it never sees or supplies an id.
 *
 * Master-data tables (vendors/items/categories/locations/stations) are
 * bounded by realistic per-organization size, so a flat organization-
 * scoped select is the same accepted convention already used for item
 * resolution -- this is NOT the kind of potentially-unbounded scan
 * vendor purchase-history discovery guards against.
 */
async function resolveByName(supabase: SupabaseClient, organizationId: string, table: string, rawQuery: string): Promise<FilterResolutionOutcome> {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return { status: "not_found" };

  const { data } = await supabase.from(table).select("id, name").eq("organization_id", organizationId);
  const rows = (data ?? []) as { id: string; name: string }[];

  const exact = rows.filter((r) => r.name.trim().toLowerCase() === query);
  if (exact.length === 1) return { status: "resolved", id: exact[0].id, name: exact[0].name };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact.map((r) => ({ id: r.id, name: r.name })) };

  const substring = rows.filter((r) => {
    const name = r.name.toLowerCase();
    return name.includes(query) || query.includes(name);
  });
  if (substring.length === 1) return { status: "resolved", id: substring[0].id, name: substring[0].name };
  if (substring.length > 1) return { status: "ambiguous", candidates: substring.slice(0, 5).map((r) => ({ id: r.id, name: r.name })) };

  return { status: "not_found" };
}

export function resolveVendorByName(supabase: SupabaseClient, organizationId: string, rawQuery: string): Promise<FilterResolutionOutcome> {
  return resolveByName(supabase, organizationId, "vendors", rawQuery);
}

export function resolveInventoryItemByName(supabase: SupabaseClient, organizationId: string, rawQuery: string): Promise<FilterResolutionOutcome> {
  return resolveByName(supabase, organizationId, "inventory_items", rawQuery);
}

export function resolveInventoryCategoryByName(supabase: SupabaseClient, organizationId: string, rawQuery: string): Promise<FilterResolutionOutcome> {
  return resolveByName(supabase, organizationId, "inventory_categories", rawQuery);
}

export function resolveLocationByName(supabase: SupabaseClient, organizationId: string, rawQuery: string): Promise<FilterResolutionOutcome> {
  return resolveByName(supabase, organizationId, "locations", rawQuery);
}

export function resolveStationByName(supabase: SupabaseClient, organizationId: string, rawQuery: string): Promise<FilterResolutionOutcome> {
  return resolveByName(supabase, organizationId, "stations", rawQuery);
}
