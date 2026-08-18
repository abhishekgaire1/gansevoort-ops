import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AiProposedPurchaseUnit {
  vendorPurchaseUnitCode: string | null;
  receivingBehavior: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  fixedConversionFactor: number | null;
}

export interface UnresolvedClassificationRow {
  classificationId: string;
  purchaseDocumentId: string;
  documentNumber: string | null;
  vendorName: string | null;
  lineKey: string;
  vendorSku: string | null;
  description: string | null;
  status: "PENDING_REVIEW" | "STALE";
  resolutionSource: string;
  inventoryItemId: string | null;
  inventoryItemName: string | null;
  aiSuggestedInventoryItemId: string | null;
  aiSuggestedInventoryItemName: string | null;
  aiSuggestedIsNewProposal: boolean;
  aiConfidence: number | null;
  aiProposedPurchaseUnit: AiProposedPurchaseUnit | null;
  aiNewItemProposal: {
    disposition: "INVENTORY" | "NON_INVENTORY";
    categoryId: string | null;
    baseUnitCode: string | null;
    spendCategoryId: string | null;
  } | null;
}

/**
 * The org-wide recovery queue: every CURRENT (purchase_document_id,
 * line_key) whose classification is PENDING_REVIEW or STALE, across every
 * purchase document -- not scoped to one document like
 * getPurchaseDocumentLineClassifications. Reuses the identical set-based
 * "is this row still current" check as getLinesNeedingClassification
 * (never a count comparison): a classification row is only included if its
 * line_key still matches a line on that SAME purchase_document right now.
 * Intentionally-retained orphaned rows (a removed line's old classification
 * -- kept for history, see 20260811100037) are structurally excluded by
 * this same check, never surfaced here. Discarded purchase documents are
 * excluded too -- there is nothing left to prepare on a discarded draft.
 */
export async function listUnresolvedClassifications(supabase: SupabaseClient, organizationId: string): Promise<UnresolvedClassificationRow[]> {
  const { data: classifications } = await supabase
    .from("purchase_document_line_classifications")
    .select("id, purchase_document_id, line_key, status, resolution_source, ai_confidence, ai_proposed_purchase_unit, inventory_item_id, ai_suggested_inventory_item_id")
    .eq("organization_id", organizationId)
    .in("status", ["PENDING_REVIEW", "STALE"]);

  const candidates = classifications ?? [];
  if (candidates.length === 0) {
    return [];
  }

  const purchaseDocumentIds = Array.from(new Set(candidates.map((c) => c.purchase_document_id as string)));

  const { data: purchaseDocuments } = await supabase
    .from("purchase_documents")
    .select("id, document_number, vendor_id, status")
    .in("id", purchaseDocumentIds)
    .eq("organization_id", organizationId)
    .neq("status", "DISCARDED");
  const purchaseDocumentById = new Map((purchaseDocuments ?? []).map((pd) => [pd.id as string, pd]));

  const { data: lines } = await supabase
    .from("purchase_document_lines")
    .select("purchase_document_id, line_key, vendor_sku, description")
    .in("purchase_document_id", purchaseDocumentIds);
  const lineByKey = new Map((lines ?? []).map((l) => [`${l.purchase_document_id}:${l.line_key}`, l]));

  const vendorIds = Array.from(new Set((purchaseDocuments ?? []).map((pd) => pd.vendor_id as string | null).filter((id): id is string => Boolean(id))));
  const { data: vendors } = vendorIds.length > 0 ? await supabase.from("vendors").select("id, name").in("id", vendorIds) : { data: [] };
  const vendorNameById = new Map((vendors ?? []).map((v) => [v.id as string, v.name as string]));

  const itemIds = Array.from(
    new Set(
      candidates
        .flatMap((c) => [c.inventory_item_id as string | null, c.ai_suggested_inventory_item_id as string | null])
        .filter((id): id is string => Boolean(id))
    )
  );
  const { data: items } =
    itemIds.length > 0
      ? await supabase.from("inventory_items").select("id, name, approval_status, disposition, category_id, spend_category_id, units(code)").in("id", itemIds)
      : { data: [] };
  const itemById = new Map((items ?? []).map((i) => [i.id as string, i]));

  const rows: UnresolvedClassificationRow[] = [];
  for (const c of candidates) {
    const purchaseDocumentId = c.purchase_document_id as string;
    const purchaseDocument = purchaseDocumentById.get(purchaseDocumentId);
    if (!purchaseDocument) continue; // discarded, or (defensively) not found

    const line = lineByKey.get(`${purchaseDocumentId}:${c.line_key}`);
    if (!line) continue; // orphaned -- line_key no longer current, deliberately excluded

    const item = c.inventory_item_id ? itemById.get(c.inventory_item_id as string) : undefined;
    const aiItem = c.ai_suggested_inventory_item_id ? itemById.get(c.ai_suggested_inventory_item_id as string) : undefined;
    const aiItemUnit = aiItem ? (Array.isArray(aiItem.units) ? aiItem.units[0] : aiItem.units) : null;
    const isNewProposal = aiItem?.approval_status === "PENDING_REVIEW";

    rows.push({
      classificationId: c.id as string,
      purchaseDocumentId,
      documentNumber: purchaseDocument.document_number as string | null,
      vendorName: purchaseDocument.vendor_id ? (vendorNameById.get(purchaseDocument.vendor_id as string) ?? null) : null,
      lineKey: c.line_key as string,
      vendorSku: line.vendor_sku as string | null,
      description: line.description as string | null,
      status: c.status as "PENDING_REVIEW" | "STALE",
      resolutionSource: c.resolution_source as string,
      inventoryItemId: (item?.id as string | undefined) ?? null,
      inventoryItemName: (item?.name as string | undefined) ?? null,
      aiSuggestedInventoryItemId: (aiItem?.id as string | undefined) ?? null,
      aiSuggestedInventoryItemName: (aiItem?.name as string | undefined) ?? null,
      aiSuggestedIsNewProposal: isNewProposal,
      aiConfidence: c.ai_confidence as number | null,
      aiProposedPurchaseUnit: (c.ai_proposed_purchase_unit as AiProposedPurchaseUnit | null) ?? null,
      aiNewItemProposal: isNewProposal
        ? {
            disposition: (aiItem?.disposition as "INVENTORY" | "NON_INVENTORY" | undefined) ?? "INVENTORY",
            categoryId: (aiItem?.category_id as string | null | undefined) ?? null,
            baseUnitCode: (aiItemUnit?.code as string | undefined) ?? null,
            spendCategoryId: (aiItem?.spend_category_id as string | null | undefined) ?? null,
          }
        : null,
    });
  }

  return rows;
}
