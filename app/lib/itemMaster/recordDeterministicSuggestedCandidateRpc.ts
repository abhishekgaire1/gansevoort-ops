import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export interface RecordDeterministicSuggestedCandidateInput {
  organizationId: string;
  purchaseDocumentId: string;
  lineKey: string;
  candidateInventoryItemId: string;
}

/** Tier 3 (NORMALIZED_NAME_MATCH) -- an exact org-wide item-name match with
 * no vendor scoping, so it is never auto-confirmed. Writes PENDING_REVIEW,
 * exactly like an AI-suggested candidate, requiring the same explicit
 * manager confirmation before it becomes authoritative. See
 * 20260811100058 for why this is a separate function from
 * record_ai_suggested_candidate rather than a shared one. */
export async function recordDeterministicSuggestedCandidateRpc(
  supabase: SupabaseClient,
  input: RecordDeterministicSuggestedCandidateInput
): Promise<void> {
  const { error } = await supabase.rpc("record_deterministic_suggested_candidate", {
    p_organization_id: input.organizationId,
    p_purchase_document_id: input.purchaseDocumentId,
    p_line_key: input.lineKey,
    p_candidate_inventory_item_id: input.candidateInventoryItemId,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }
}
