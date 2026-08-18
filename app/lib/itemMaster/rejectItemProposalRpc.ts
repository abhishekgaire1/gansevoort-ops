import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export interface RejectItemProposalInput {
  inventoryItemId: string;
  organizationId: string;
  appUserId: string;
  reason?: string | null;
}

/** Hard-deletes the PENDING_REVIEW row if unreferenced by any
 * classification/vendor mapping (GA010 if still referenced -- reassign
 * that line first). The audit event's before_state preserves the full
 * proposal even after deletion. */
export async function rejectItemProposalRpc(supabase: SupabaseClient, input: RejectItemProposalInput): Promise<void> {
  const { error } = await supabase.rpc("reject_item_proposal", {
    p_inventory_item_id: input.inventoryItemId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_reason: input.reason ?? null,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }
}
