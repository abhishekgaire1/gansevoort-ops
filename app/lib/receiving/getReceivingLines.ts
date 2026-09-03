import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveVendorPurchasePackages } from "@/app/lib/purchaseDocuments/resolveVendorPurchasePackage";

export type ReceivingBehavior = "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY";

export interface ReceivingLineInfo {
  lineKey: string;
  description: string | null;
  vendorSku: string | null;
  invoicePackageQuantity: number | null;
  invoicePackageUnit: string | null;
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  inventoryItemId: string | null;
  baseUnitCode: string | null;
  baseUnitId: string | null;
  purchaseUnitCode: string | null;
  receivingBehavior: ReceivingBehavior | null;
  fixedConversionFactor: number | null;
  /** True only for MEASURE_EACH_DELIVERY/COUNT_EACH_DELIVERY -- the
   * receiving UI must require this field and NEVER auto-fill it from
   * "Everything Received As Invoiced" (plan: no fixed BOX->LB conversion
   * is ever learned or fabricated for a genuinely variable item). */
  requiresVerifiedMeasurement: boolean;
  /** Where this item was most recently confirmed received -- the
   * receiving UI's own item-specific location prefill, taking priority
   * over any delivery-level default. Null when the item has never had a
   * receipt confirmed with a location, or there's no confirmed item at
   * all (not yet classified, or NON_INVENTORY). */
  defaultReceivingLocationId: string | null;
  /** What unit this invoice's bare quantity is actually expressed in,
   * when the invoice itself didn't state one (or as the comparison
   * baseline when it did, to detect a genuine conflict) -- distinct from
   * the item's purchase/packaging unit (a CASE-of-12 config doesn't mean
   * the vendor's invoice quantity is counted in CASE; see
   * computeReceivingPrefill's doc comment for the real Bartlett Heavy
   * Cream case this guards against). Resolved with priority: (1) this
   * EXACT invoice line's own permanent confirmation (see
   * purchase_document_line_invoice_unit_confirmations /
   * confirm_receiving_line_invoice_unit) -- a manager already resolved
   * this specific line, and that meaning must never drift even if the
   * vendor's remembered default later changes -- else (2) the vendor's
   * remembered default for this SKU (vendor_item_mappings.
   * confirmed_invoice_unit_id), else null (genuinely never confirmed,
   * requires the manager to resolve it now). */
  confirmedInvoiceUnitCode: string | null;
}

/**
 * Per-line receiving configuration for the ReceivingPanel -- derived from
 * each CONFIRMED INVENTORY line's actual inventory_item_units
 * configuration (set atomically at new-item approval time, see
 * 20260811100045), never re-guessed here. A line with no CONFIRMED
 * INVENTORY classification (still pending, or NON_INVENTORY) gets no
 * receiving-behavior fields at all -- it is never blocked by irrelevant
 * inventory concepts.
 */
export async function getReceivingLines(supabase: SupabaseClient, purchaseDocumentId: string, organizationId: string): Promise<ReceivingLineInfo[]> {
  const { data: lines } = await supabase
    .from("purchase_document_lines")
    .select("line_key, description, vendor_sku, package_quantity, package_unit")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("organization_id", organizationId)
    .order("line_number");

  const { data: purchaseDocument } = await supabase
    .from("purchase_documents")
    .select("vendor_id")
    .eq("id", purchaseDocumentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const vendorId = (purchaseDocument?.vendor_id as string | undefined) ?? null;

  const vendorSkus = Array.from(new Set((lines ?? []).map((l) => l.vendor_sku as string | null).filter((s): s is string => Boolean(s))));

  const { data: vendorMappings } =
    vendorId && vendorSkus.length > 0
      ? await supabase
          .from("vendor_item_mappings")
          .select("vendor_sku, confirmed_invoice_unit_id, units(code)")
          .eq("organization_id", organizationId)
          .eq("vendor_id", vendorId)
          .eq("match_basis", "VENDOR_SKU")
          .eq("is_active", true)
          .in("vendor_sku", vendorSkus)
      : { data: [] };
  type VendorMappingRow = NonNullable<typeof vendorMappings>[number];
  const vendorUnitCodeBySku = new Map<string, string>();
  for (const row of (vendorMappings ?? []) as VendorMappingRow[]) {
    if (!row.confirmed_invoice_unit_id) continue;
    const unit = Array.isArray(row.units) ? row.units[0] : row.units;
    const code = unit?.code as string | undefined;
    if (code) vendorUnitCodeBySku.set(row.vendor_sku as string, code);
  }

  // Ascending order so the LAST write into the map is the most recent
  // confirmation -- append-only history, "most recent wins" per line.
  const { data: lineConfirmations } = await supabase
    .from("purchase_document_line_invoice_unit_confirmations")
    .select("line_key, confirmed_at, units(code)")
    .eq("organization_id", organizationId)
    .eq("purchase_document_id", purchaseDocumentId)
    .order("confirmed_at", { ascending: true });
  type LineConfirmationRow = NonNullable<typeof lineConfirmations>[number];
  const lineUnitCodeByLineKey = new Map<string, string>();
  for (const row of (lineConfirmations ?? []) as LineConfirmationRow[]) {
    const unit = Array.isArray(row.units) ? row.units[0] : row.units;
    const code = unit?.code as string | undefined;
    if (code) lineUnitCodeByLineKey.set(row.line_key as string, code);
  }

  function resolveConfirmedInvoiceUnitCode(lineKey: string, vendorSku: string | null): string | null {
    return lineUnitCodeByLineKey.get(lineKey) ?? (vendorSku ? (vendorUnitCodeBySku.get(vendorSku) ?? null) : null);
  }

  const { data: classifications } = await supabase
    .from("purchase_document_line_classifications")
    .select("line_key, status, disposition, inventory_item_id, vendor_item_purchase_unit_id")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("organization_id", organizationId);
  const classificationByLineKey = new Map((classifications ?? []).map((c) => [c.line_key as string, c]));

  const itemIds = Array.from(
    new Set((classifications ?? []).map((c) => c.inventory_item_id as string | null).filter((id): id is string => Boolean(id)))
  );

  const { data: items } =
    itemIds.length > 0
      ? await supabase.from("inventory_items").select("id, base_unit_id, default_receiving_location_id, units(code, unit_type)").in("id", itemIds)
      : { data: [] };
  const itemById = new Map((items ?? []).map((i) => [i.id as string, i]));

  // Purchase-versus-usage unit model (20260811100123): the effective
  // purchase package for a CONFIRMED line comes from THAT classification's
  // OWN vendor package -- never the shared, global inventory_item_units
  // row alone (that was the exact pre-100123 bug: a second vendor/SKU's
  // approval could silently reprice an unrelated line). resolveVendor
  // PurchasePackages also covers a VENDOR_SKU_MAPPING-auto-classified line
  // (whose classification never gets vendor_item_purchase_unit_id set at
  // all, by design -- see that module's own doc comment) and an item whose
  // original approval predates full adoption of vendor_item_purchase_units
  // -- both still resolved vendor-specifically, never a blind "first
  // non-base row" guess. A line resolved by none of those falls back to
  // the item's own base unit, factor 1 -- exactly
  // coalesce(vpu.purchase_unit_id, ii.base_unit_id) in
  // post_purchase_document_inventory.
  const vendorPackageByLineKey = await resolveVendorPurchasePackages(
    supabase,
    organizationId,
    vendorId,
    (classifications ?? [])
      .filter((c) => c.status === "CONFIRMED" && c.disposition === "INVENTORY" && c.inventory_item_id)
      .map((c) => ({ key: c.line_key as string, inventoryItemId: c.inventory_item_id as string, vendorItemPurchaseUnitId: c.vendor_item_purchase_unit_id as string | null }))
  );

  return (lines ?? []).map((line) => {
    const lineKey = line.line_key as string;
    const vendorSku = line.vendor_sku as string | null;
    const classification = classificationByLineKey.get(lineKey);
    const isConfirmedInventory = classification?.status === "CONFIRMED" && classification.disposition === "INVENTORY" && classification.inventory_item_id;

    if (!isConfirmedInventory || !classification?.inventory_item_id) {
      return {
        lineKey,
        description: line.description as string | null,
        vendorSku,
        invoicePackageQuantity: line.package_quantity as number | null,
        invoicePackageUnit: line.package_unit as string | null,
        disposition: (classification?.disposition as "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED" | undefined) ?? "UNRESOLVED",
        inventoryItemId: null,
        baseUnitCode: null,
        baseUnitId: null,
        purchaseUnitCode: null,
        receivingBehavior: null,
        fixedConversionFactor: null,
        requiresVerifiedMeasurement: false,
        defaultReceivingLocationId: null,
        confirmedInvoiceUnitCode: resolveConfirmedInvoiceUnitCode(lineKey, vendorSku),
      };
    }

    const item = itemById.get(classification.inventory_item_id as string);
    const baseUnit = item ? (Array.isArray(item.units) ? item.units[0] : item.units) : null;
    const baseUnitId = (item?.base_unit_id as string | undefined) ?? null;

    const vendorPackage = vendorPackageByLineKey.get(lineKey) ?? null;

    // SAME_UNIT (no vendor package resolved) falls back to the base unit
    // itself, factor 1 -- receivingBehavior is read directly off the
    // resolved package, never re-derived from requires_actual_measurement +
    // base unit type.
    const receivingBehavior: ReceivingBehavior | null = vendorPackage ? vendorPackage.receivingBehavior : "SAME_UNIT";
    const fixedConversionFactor: number | null = vendorPackage && receivingBehavior === "FIXED_CONVERSION" ? vendorPackage.conversionFactor : null;

    return {
      lineKey,
      description: line.description as string | null,
      vendorSku,
      invoicePackageQuantity: line.package_quantity as number | null,
      invoicePackageUnit: line.package_unit as string | null,
      disposition: "INVENTORY",
      inventoryItemId: classification.inventory_item_id as string,
      baseUnitCode: (baseUnit?.code as string | undefined) ?? null,
      baseUnitId,
      purchaseUnitCode: vendorPackage?.unitCode ?? null,
      receivingBehavior,
      fixedConversionFactor,
      requiresVerifiedMeasurement: receivingBehavior === "MEASURE_EACH_DELIVERY" || receivingBehavior === "COUNT_EACH_DELIVERY",
      defaultReceivingLocationId: (item?.default_receiving_location_id as string | undefined) ?? null,
      confirmedInvoiceUnitCode: resolveConfirmedInvoiceUnitCode(lineKey, vendorSku),
    };
  });
}
