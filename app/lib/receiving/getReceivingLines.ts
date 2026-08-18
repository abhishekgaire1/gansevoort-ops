import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

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
    .select("line_key, status, disposition, inventory_item_id")
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

  const { data: itemUnits } =
    itemIds.length > 0
      ? await supabase
          .from("inventory_item_units")
          .select("inventory_item_id, unit_id, conversion_factor, requires_actual_measurement, is_default_entry_unit, units(code)")
          .in("inventory_item_id", itemIds)
      : { data: [] };
  type ItemUnitRow = NonNullable<typeof itemUnits>[number];
  const unitsByItemId = new Map<string, ItemUnitRow[]>();
  for (const row of itemUnits ?? []) {
    const key = row.inventory_item_id as string;
    if (!unitsByItemId.has(key)) unitsByItemId.set(key, []);
    unitsByItemId.get(key)!.push(row);
  }

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

    const rows = unitsByItemId.get(classification.inventory_item_id as string) ?? [];
    const purchaseUnitRow = rows.find((r) => (r!.unit_id as string) !== baseUnitId);
    const purchaseUnit = purchaseUnitRow ? (Array.isArray(purchaseUnitRow!.units) ? purchaseUnitRow!.units[0] : purchaseUnitRow!.units) : null;

    let receivingBehavior: ReceivingBehavior | null = "SAME_UNIT";
    let fixedConversionFactor: number | null = null;
    if (purchaseUnitRow) {
      if (purchaseUnitRow.requires_actual_measurement) {
        // COUNT vs MEASURE distinguished purely by the base unit's own
        // unit_type -- no separate schema column needed (see
        // 20260811100044's design note).
        receivingBehavior = baseUnit?.unit_type === "COUNT" ? "COUNT_EACH_DELIVERY" : "MEASURE_EACH_DELIVERY";
      } else {
        receivingBehavior = "FIXED_CONVERSION";
        fixedConversionFactor = purchaseUnitRow.conversion_factor as number | null;
      }
    }

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
      purchaseUnitCode: (purchaseUnit?.code as string | undefined) ?? null,
      receivingBehavior,
      fixedConversionFactor,
      requiresVerifiedMeasurement: receivingBehavior === "MEASURE_EACH_DELIVERY" || receivingBehavior === "COUNT_EACH_DELIVERY",
      defaultReceivingLocationId: (item?.default_receiving_location_id as string | undefined) ?? null,
      confirmedInvoiceUnitCode: resolveConfirmedInvoiceUnitCode(lineKey, vendorSku),
    };
  });
}
