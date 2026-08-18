import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export interface BulkConfirmLineClassificationsInput {
  classificationIds: string[];
  organizationId: string;
  appUserId: string;
}

/** Only for high-confidence AI matches to an EXISTING confirmed item --
 * never offered for new-item proposals. Silently skips any id that isn't
 * a PENDING_REVIEW/AI_SUGGESTED-to-an-existing-item row (e.g. already
 * confirmed by someone else), and -- since 20260811100063 -- any id
 * belonging to a document that isn't the caller's own still-DRAFT
 * preparation (a document that has moved past DRAFT can never be
 * written to by this function regardless; the query now excludes it
 * outright instead of attempting the write and letting the DB-level lock
 * reject it, which would otherwise abort the WHOLE batch, not just that
 * one row). Returns the ids actually confirmed. */
export async function bulkConfirmLineClassificationsRpc(
  supabase: SupabaseClient,
  input: BulkConfirmLineClassificationsInput
): Promise<string[]> {
  const { data, error } = await supabase.rpc("bulk_confirm_line_classifications", {
    p_classification_ids: input.classificationIds,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }

  const rows = (data ?? []) as { out_classification_id: string }[];
  return rows.map((r) => r.out_classification_id);
}
