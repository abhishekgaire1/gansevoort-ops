import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export interface RecordAiSuggestedCandidateInput {
  organizationId: string;
  purchaseDocumentId: string;
  lineKey: string;
  candidateInventoryItemId: string;
  aiConfidence: number | null;
}

/** AI proposed an EXISTING confirmed item as the match -- writes
 * PENDING_REVIEW, no audit event (nothing authoritative has happened yet;
 * the manager's approval is what makes it a fact). */
export async function recordAiSuggestedCandidateRpc(supabase: SupabaseClient, input: RecordAiSuggestedCandidateInput): Promise<void> {
  const { error } = await supabase.rpc("record_ai_suggested_candidate", {
    p_organization_id: input.organizationId,
    p_purchase_document_id: input.purchaseDocumentId,
    p_line_key: input.lineKey,
    p_candidate_inventory_item_id: input.candidateInventoryItemId,
    p_ai_confidence: input.aiConfidence,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }
}
