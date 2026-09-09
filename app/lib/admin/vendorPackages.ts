import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapAdminRpcError } from "@/app/lib/admin/errors";
import { mapInventoryRpcError } from "@/app/lib/inventory/errors";

/**
 * Safe editing of confirmed items -- standalone vendor-purchase-package
 * management for an already-CONFIRMED item, independent of any specific
 * purchase document. Read side is a plain org-scoped read (two queries
 * joined in TS, matching this codebase's existing style rather than
 * fighting PostgREST embedding syntax for a reverse relation) -- no
 * business logic, service-role bypasses RLS safely, same posture as the
 * pre-existing vendor-mapping read this replaces. Write side delegates to
 * manager_set_vendor_purchase_package (20260811100140), which itself
 * delegates to the existing, already-versioned upsert_vendor_item_
 * purchase_unit helper -- no supersede logic is duplicated here.
 */

export type ReceivingBehavior = "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY";

export interface VendorPackageConfig {
  vendorItemPurchaseUnitId: string;
  purchaseUnitId: string;
  purchaseUnitCode: string;
  receivingBehavior: ReceivingBehavior;
  conversionFactor: number | null;
  requiresActualMeasurement: boolean;
  effectiveFrom: string;
}

export interface VendorPackageSummary {
  vendorItemMappingId: string;
  vendorId: string;
  vendorName: string;
  matchBasis: "VENDOR_SKU" | "NORMALIZED_DESCRIPTION";
  vendorSku: string | null;
  normalizedDescription: string | null;
  confirmedAt: string;
  /** Null when this vendor/SKU has never had an explicit package
   * registered for it (a receiving default that was never overridden). */
  package: VendorPackageConfig | null;
}

interface MappingRow {
  id: string;
  vendor_id: string;
  match_basis: "VENDOR_SKU" | "NORMALIZED_DESCRIPTION";
  vendor_sku: string | null;
  normalized_description: string | null;
  confirmed_at: string;
  vendors: { name: string } | { name: string }[] | null;
}

interface PackageRow {
  id: string;
  vendor_item_mapping_id: string;
  purchase_unit_id: string;
  receiving_behavior: ReceivingBehavior;
  conversion_factor: number | null;
  requires_actual_measurement: boolean;
  effective_from: string;
  units: { code: string } | { code: string }[] | null;
}

export async function listItemVendorPackages(supabase: SupabaseClient, organizationId: string, itemId: string): Promise<VendorPackageSummary[]> {
  const { data: mappingRows, error: mappingError } = await supabase
    .from("vendor_item_mappings")
    .select("id, vendor_id, match_basis, vendor_sku, normalized_description, confirmed_at, vendors(name)")
    .eq("organization_id", organizationId)
    .eq("inventory_item_id", itemId)
    .eq("is_active", true)
    .order("confirmed_at", { ascending: false });
  if (mappingError) throw new Error(mappingError.message);
  const mappings = (mappingRows ?? []) as unknown as MappingRow[];
  if (mappings.length === 0) return [];

  const mappingIds = mappings.map((m) => m.id);
  const { data: packageRows, error: packageError } = await supabase
    .from("vendor_item_purchase_units")
    .select("id, vendor_item_mapping_id, purchase_unit_id, receiving_behavior, conversion_factor, requires_actual_measurement, effective_from, units(code)")
    .eq("organization_id", organizationId)
    .in("vendor_item_mapping_id", mappingIds)
    .eq("is_active", true);
  if (packageError) throw new Error(packageError.message);
  const packagesByMappingId = new Map<string, PackageRow>();
  for (const row of (packageRows ?? []) as unknown as PackageRow[]) {
    packagesByMappingId.set(row.vendor_item_mapping_id, row);
  }

  return mappings.map((m) => {
    const vendor = Array.isArray(m.vendors) ? m.vendors[0] : m.vendors;
    const pkg = packagesByMappingId.get(m.id);
    const unit = pkg ? (Array.isArray(pkg.units) ? pkg.units[0] : pkg.units) : null;
    return {
      vendorItemMappingId: m.id,
      vendorId: m.vendor_id,
      vendorName: vendor?.name ?? "Unknown vendor",
      matchBasis: m.match_basis,
      vendorSku: m.vendor_sku,
      normalizedDescription: m.normalized_description,
      confirmedAt: m.confirmed_at,
      package: pkg
        ? {
            vendorItemPurchaseUnitId: pkg.id,
            purchaseUnitId: pkg.purchase_unit_id,
            purchaseUnitCode: unit?.code ?? "",
            receivingBehavior: pkg.receiving_behavior,
            conversionFactor: pkg.conversion_factor,
            requiresActualMeasurement: pkg.requires_actual_measurement,
            effectiveFrom: pkg.effective_from,
          }
        : null,
    };
  });
}

export interface SetVendorPurchasePackageResult {
  vendorItemPurchaseUnitId: string;
}

export async function setVendorPurchasePackage(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  vendorItemMappingId: string,
  purchaseUnitCode: string,
  receivingBehavior: ReceivingBehavior,
  conversionFactor: number | null,
  requiresActualMeasurement: boolean
): Promise<SetVendorPurchasePackageResult> {
  const { data, error } = await supabase.rpc("manager_set_vendor_purchase_package", {
    p_organization_id: organizationId,
    p_app_user_id: actorAppUserId,
    p_vendor_item_mapping_id: vendorItemMappingId,
    p_purchase_unit_code: purchaseUnitCode,
    p_receiving_behavior: receivingBehavior,
    p_conversion_factor: conversionFactor,
    p_requires_actual_measurement: requiresActualMeasurement,
  });
  if (error) throw mapAdminRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_vendor_item_purchase_unit_id: string } | undefined;
  if (!row) throw new Error("manager_set_vendor_purchase_package returned no result");
  return { vendorItemPurchaseUnitId: row.out_vendor_item_purchase_unit_id };
}

export interface ReceiptUsingPackageVersion {
  postingLineId: string;
  purchaseDocumentId: string;
  documentNumber: string | null;
  documentDate: string;
  locationId: string;
  locationName: string;
  originalReceivedPackageQuantity: number | null;
  originalPackageUnit: string | null;
  originalNormalizedBaseQuantity: number;
  baseUnitCode: string;
}

export async function listReceiptsUsingVendorPackage(supabase: SupabaseClient, organizationId: string, vendorItemPurchaseUnitId: string): Promise<ReceiptUsingPackageVersion[]> {
  const { data, error } = await supabase.rpc("list_receipts_using_vendor_package_version", {
    p_organization_id: organizationId,
    p_vendor_item_purchase_unit_id: vendorItemPurchaseUnitId,
  });
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as {
      out_posting_line_id: string;
      out_purchase_document_id: string;
      out_document_number: string | null;
      out_document_date: string;
      out_location_id: string;
      out_location_name: string;
      out_original_received_package_quantity: number | null;
      out_original_package_unit: string | null;
      out_original_normalized_base_quantity: number;
      out_base_unit_code: string;
    }[]
  ).map((row) => ({
    postingLineId: row.out_posting_line_id,
    purchaseDocumentId: row.out_purchase_document_id,
    documentNumber: row.out_document_number,
    documentDate: row.out_document_date,
    locationId: row.out_location_id,
    locationName: row.out_location_name,
    originalReceivedPackageQuantity: row.out_original_received_package_quantity,
    originalPackageUnit: row.out_original_package_unit,
    originalNormalizedBaseQuantity: row.out_original_normalized_base_quantity,
    baseUnitCode: row.out_base_unit_code,
  }));
}

export interface CorrectReceiptPackageFactorResult {
  correctionIds: string[];
  replayed: boolean;
}

export async function correctReceiptPackageFactor(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  postingLineIds: string[],
  newVendorItemPurchaseUnitId: string,
  reason: string,
  clientRequestId: string
): Promise<CorrectReceiptPackageFactorResult> {
  const { data, error } = await supabase.rpc("correct_receipt_package_factor", {
    p_app_user_id: actorAppUserId,
    p_organization_id: organizationId,
    p_posting_line_ids: postingLineIds,
    p_new_vendor_item_purchase_unit_id: newVendorItemPurchaseUnitId,
    p_reason: reason,
    p_client_request_id: clientRequestId,
  });
  if (error) throw mapInventoryRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_correction_ids: string[]; out_replayed: boolean } | undefined;
  if (!row) throw new Error("correct_receipt_package_factor returned no result");
  return { correctionIds: row.out_correction_ids, replayed: row.out_replayed };
}
