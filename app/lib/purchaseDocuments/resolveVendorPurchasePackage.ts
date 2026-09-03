import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResolvedVendorPurchasePackage {
  unitCode: string;
  unitName: string;
  receivingBehavior: "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY";
  conversionFactor: number | null;
  requiresActualMeasurement: boolean;
}

export interface VendorPurchasePackageLookupEntry {
  /** Caller's own identifier for this line/classification (e.g. lineKey) --
   * the returned map is keyed by this, not by inventoryItemId, since two
   * different classifications for the same item could in principle carry
   * different vendor_item_purchase_unit_id pointers. */
  key: string;
  inventoryItemId: string;
  /** This classification's own resolved pointer, or null (e.g. every
   * VENDOR_SKU_MAPPING-auto-classified line -- see this module's own doc
   * comment for why that's never populated by design). */
  vendorItemPurchaseUnitId: string | null;
}

/**
 * Resolves the effective, vendor-specific confirmed purchase package for a
 * batch of CONFIRMED INVENTORY classifications, in priority order:
 *
 *   1. The classification's OWN resolved vendor_item_purchase_unit_id --
 *      set by a manual approve/re-approve RPC (approveLineClassification*),
 *      the most authoritative, current-model source.
 *   2. A live lookup in vendor_item_purchase_units by
 *      (organization_id, vendor_id, inventory_item_id, is_active) -- covers
 *      a line auto-classified via VENDOR_SKU_MAPPING
 *      (system_classification_resolution_rpcs, 20260811100042), which BY
 *      DESIGN never writes vendor_item_purchase_unit_id onto the
 *      classification it creates, even when a real, already-confirmed
 *      vendor package exists for that exact vendor+item (the common,
 *      expected case for any returning vendor/SKU -- not an edge case).
 *      Relying on the classification's own pointer alone silently loses
 *      this for every auto-matched repeat line.
 *   3. The pre-vendor-package-model combination of
 *      vendor_item_mappings.confirmed_invoice_unit_id (vendor+SKU-scoped --
 *      never the bare, shared-across-every-vendor inventory_item_units row
 *      the original pre-100123 bug used) cross-referenced with that item's
 *      own inventory_item_units row for that unit -- covers an item whose
 *      original approval predates (or, for whatever historical reason,
 *      never actually populated) vendor_item_purchase_units.
 *
 * A line missing from the returned map (or mapped to null) means none of
 * 1-3 resolved anything -- the caller's own SAME_UNIT/base-unit fallback
 * applies. This function never fabricates a fixed conversion that wasn't
 * actually confirmed somewhere.
 */
export async function resolveVendorPurchasePackages(
  supabase: SupabaseClient,
  organizationId: string,
  vendorId: string | null,
  entries: VendorPurchasePackageLookupEntry[]
): Promise<Map<string, ResolvedVendorPurchasePackage>> {
  const result = new Map<string, ResolvedVendorPurchasePackage>();
  if (entries.length === 0 || !vendorId) return result;

  const itemIds = Array.from(new Set(entries.map((e) => e.inventoryItemId)));
  const pointerIds = Array.from(new Set(entries.map((e) => e.vendorItemPurchaseUnitId).filter((id): id is string => Boolean(id))));

  // Layers 1+2 in one query: every ACTIVE package for this vendor across
  // the referenced items, plus (via `.or`) any specific historical package
  // a classification's own pointer names even if no longer active --
  // covers both "auto-matched, no pointer, use the active one" and "a
  // pointer was explicitly set" in a single round trip.
  const orClauses = [`is_active.eq.true`, ...(pointerIds.length > 0 ? [`id.in.(${pointerIds.join(",")})`] : [])];
  const { data: packages } = await supabase
    .from("vendor_item_purchase_units")
    .select("id, inventory_item_id, purchase_unit_id, conversion_factor, receiving_behavior, requires_actual_measurement, is_active, units(code, name)")
    .eq("organization_id", organizationId)
    .eq("vendor_id", vendorId)
    .in("inventory_item_id", itemIds)
    .or(orClauses.join(","));

  const packageById = new Map((packages ?? []).map((p) => [p.id as string, p]));
  const activePackageByItemId = new Map((packages ?? []).filter((p) => p.is_active).map((p) => [p.inventory_item_id as string, p]));

  // Layer 3: legacy pre-vendor-package-model config -- only fetched for
  // items still unresolved after layers 1-2, to avoid the extra round
  // trips on the common (already-migrated) case.
  const unresolvedItemIds = itemIds.filter((id) => {
    const entry = entries.find((e) => e.inventoryItemId === id);
    const pointerHit = entry?.vendorItemPurchaseUnitId ? packageById.get(entry.vendorItemPurchaseUnitId) : undefined;
    return !pointerHit && !activePackageByItemId.has(id);
  });

  const legacyByItemId = new Map<string, ResolvedVendorPurchasePackage>();
  if (unresolvedItemIds.length > 0) {
    const { data: mappings } = await supabase
      .from("vendor_item_mappings")
      .select("inventory_item_id, confirmed_invoice_unit_id")
      .eq("organization_id", organizationId)
      .eq("vendor_id", vendorId)
      .eq("is_active", true)
      .in("inventory_item_id", unresolvedItemIds)
      .not("confirmed_invoice_unit_id", "is", null);

    const unitIdByItemId = new Map((mappings ?? []).map((m) => [m.inventory_item_id as string, m.confirmed_invoice_unit_id as string]));
    if (unitIdByItemId.size > 0) {
      const { data: legacyUnits } = await supabase
        .from("inventory_item_units")
        .select("inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, units(code, name)")
        .in("inventory_item_id", Array.from(unitIdByItemId.keys()));
      for (const row of legacyUnits ?? []) {
        const itemId = row.inventory_item_id as string;
        const confirmedUnitId = unitIdByItemId.get(itemId);
        if (!confirmedUnitId || row.unit_id !== confirmedUnitId) continue;
        const unit = Array.isArray(row.units) ? row.units[0] : row.units;
        if (!unit) continue;
        const requiresMeasurement = Boolean(row.requires_actual_measurement);
        legacyByItemId.set(itemId, {
          unitCode: unit.code as string,
          unitName: unit.name as string,
          receivingBehavior: requiresMeasurement ? "MEASURE_EACH_DELIVERY" : "FIXED_CONVERSION",
          conversionFactor: requiresMeasurement ? null : (row.conversion_factor as number | null),
          requiresActualMeasurement: requiresMeasurement,
        });
      }
    }
  }

  function toResolved(row: NonNullable<typeof packages>[number]): ResolvedVendorPurchasePackage {
    const unit = Array.isArray(row.units) ? row.units[0] : row.units;
    return {
      unitCode: unit?.code as string,
      unitName: unit?.name as string,
      receivingBehavior: row.receiving_behavior as ResolvedVendorPurchasePackage["receivingBehavior"],
      conversionFactor: row.conversion_factor as number | null,
      requiresActualMeasurement: Boolean(row.requires_actual_measurement),
    };
  }

  for (const entry of entries) {
    const pointerHit = entry.vendorItemPurchaseUnitId ? packageById.get(entry.vendorItemPurchaseUnitId) : undefined;
    if (pointerHit) {
      result.set(entry.key, toResolved(pointerHit));
      continue;
    }
    const activeHit = activePackageByItemId.get(entry.inventoryItemId);
    if (activeHit) {
      result.set(entry.key, toResolved(activeHit));
      continue;
    }
    const legacyHit = legacyByItemId.get(entry.inventoryItemId);
    if (legacyHit) {
      result.set(entry.key, legacyHit);
    }
  }

  return result;
}
