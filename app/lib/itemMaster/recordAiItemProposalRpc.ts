import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export interface RecordAiItemProposalInput {
  organizationId: string;
  purchaseDocumentId: string;
  lineKey: string;
  proposedName: string;
  proposedDisposition: "INVENTORY" | "NON_INVENTORY" | null;
  /** A canonical inventory_categories.id, already validated against this
   * organization's ACTIVE candidate list in validate.ts -- never a free-text
   * name resolved by fuzzy/exact matching. */
  proposedCategoryId: string | null;
  /** A canonical spend_categories.id, same candidate-id-only resolution. */
  proposedSpendCategoryId: string | null;
  proposedBaseUnitCode: string | null;
  aiConfidence: number | null;
  proposedVendorPurchaseUnitCode?: string | null;
  proposedReceivingBehavior?: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  proposedFixedConversionFactor?: number | null;
}

export interface RecordAiItemProposalResult {
  inventoryItemId: string;
}

/** AI found no good existing-item match -- creates a PENDING_REVIEW
 * inventory_items row itself (best-effort category/spend-category pre-fill
 * by id, base-unit pre-fill by code, never a hard failure since a
 * PENDING_REVIEW row structurally needs none of them) plus the
 * PENDING_REVIEW classification row pointing at it. No audit event -- the
 * manager's later approval (ITEM_PROPOSAL_APPROVED) is what makes this
 * authoritative. */
export async function recordAiItemProposalRpc(
  supabase: SupabaseClient,
  input: RecordAiItemProposalInput
): Promise<RecordAiItemProposalResult> {
  const { data, error } = await supabase.rpc("record_ai_item_proposal", {
    p_organization_id: input.organizationId,
    p_purchase_document_id: input.purchaseDocumentId,
    p_line_key: input.lineKey,
    p_proposed_name: input.proposedName,
    p_proposed_disposition: input.proposedDisposition,
    p_proposed_category_id: input.proposedCategoryId,
    p_proposed_spend_category_id: input.proposedSpendCategoryId,
    p_proposed_base_unit_code: input.proposedBaseUnitCode,
    p_ai_confidence: input.aiConfidence,
    p_proposed_vendor_purchase_unit_code: input.proposedVendorPurchaseUnitCode ?? null,
    p_proposed_receiving_behavior: input.proposedReceivingBehavior ?? null,
    p_proposed_fixed_conversion_factor: input.proposedFixedConversionFactor ?? null,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as { out_inventory_item_id: string } | undefined;
  if (!row) {
    throw new Error("record_ai_item_proposal returned no result row");
  }

  return { inventoryItemId: row.out_inventory_item_id };
}
