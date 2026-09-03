import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveVendorPurchasePackages } from "@/app/lib/purchaseDocuments/resolveVendorPurchasePackage";
import { resolveLineMismatchFields } from "@/app/lib/purchaseDocuments/packageUnitMismatch";

/**
 * Shared purchase-package-mismatch lookup -- the SAME resolution
 * (resolveVendorPurchasePackages' 3-layer priority + resolveLineMismatchFields,
 * exactly as app/actions/itemClassification.ts's getPurchaseDocumentLineClassifications
 * computes hasPackageMismatch per line) but as a lighter, standalone query
 * for callers that only need the yes/no mismatch fact per line, never a
 * second, independently-reimplemented comparison.
 *
 * Introduced because getPreparationStatus.ts (Step 3's readiness gate and
 * Step 2's own eager wizard-progress refresh) previously had NO awareness
 * of purchase-package mismatch at all -- a line could show "ready" there
 * while Step 2's own combinedLineReadiness.ts correctly still called it
 * needs_attention, letting "Send for Second Review" enable (and the
 * Stepper mark Step 2 done) despite a genuine unresolved mismatch.
 */
export async function getPackageMismatchByLineKey(supabase: SupabaseClient, purchaseDocumentId: string, organizationId: string): Promise<Map<string, boolean>> {
  const [{ data: lines }, { data: classifications }, { data: allUnits }] = await Promise.all([
    supabase.from("purchase_document_lines").select("line_key, package_unit").eq("purchase_document_id", purchaseDocumentId).eq("organization_id", organizationId),
    supabase
      .from("purchase_document_line_classifications")
      // The explicit !constraint_name hint disambiguates this table's TWO
      // FKs into inventory_items (the confirmed item vs. ai_suggested_
      // inventory_item_id) -- without it, PostgREST's embed is ambiguous
      // and silently returns no item/unit data, which is exactly what let
      // this helper's first version report "no mismatch" for every line.
      .select("line_key, status, disposition, inventory_item_id, vendor_item_purchase_unit_id, inventory_items!purchase_document_line_classifications_item_org_fk(base_unit_id, units(code, name))")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("organization_id", organizationId),
    supabase.from("units").select("code"),
  ]);

  const recognizedUnitCodes = new Set((allUnits ?? []).map((u) => (u.code as string).trim().toUpperCase()));
  const packageUnitByLineKey = new Map((lines ?? []).map((l) => [l.line_key as string, l.package_unit as string | null]));
  const classificationByLineKey = new Map((classifications ?? []).map((c) => [c.line_key as string, c]));

  const { data: purchaseDocument } = await supabase.from("purchase_documents").select("vendor_id").eq("id", purchaseDocumentId).eq("organization_id", organizationId).maybeSingle();

  const vendorPackageByLineKey = await resolveVendorPurchasePackages(
    supabase,
    organizationId,
    (purchaseDocument?.vendor_id as string | null) ?? null,
    (classifications ?? [])
      .filter((c) => c.status === "CONFIRMED" && c.disposition === "INVENTORY" && c.inventory_item_id)
      .map((c) => ({ key: c.line_key as string, inventoryItemId: c.inventory_item_id as string, vendorItemPurchaseUnitId: c.vendor_item_purchase_unit_id as string | null }))
  );

  const result = new Map<string, boolean>();
  for (const [lineKey, c] of classificationByLineKey) {
    if (c.status !== "CONFIRMED" || c.disposition !== "INVENTORY") {
      result.set(lineKey, false);
      continue;
    }
    const item = Array.isArray(c.inventory_items) ? c.inventory_items[0] : c.inventory_items;
    const itemUnit = item ? (Array.isArray(item.units) ? item.units[0] : item.units) : null;
    const { hasPackageMismatch } = resolveLineMismatchFields({
      status: c.status as "CONFIRMED",
      disposition: c.disposition as "INVENTORY",
      invoicePackageUnitText: packageUnitByLineKey.get(lineKey) ?? null,
      vendorPackage: vendorPackageByLineKey.get(lineKey) ?? null,
      itemBaseUnit: itemUnit ? { code: (itemUnit.code as string | undefined) ?? null, name: (itemUnit.name as string | undefined) ?? null } : null,
      recognizedUnitCodes,
    });
    result.set(lineKey, hasPackageMismatch);
  }
  return result;
}
