import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export interface CorrectDocumentDeliveryVerifierInput {
  documentId: string;
  organizationId: string;
  appUserId: string;
  newEmployeeId: string;
  reason?: string | null;
}

/** Any manager/admin may correct a mistakenly-selected delivery verifier --
 * never restricted to the uploader. Append-only-logged, fully audited. */
export async function correctDocumentDeliveryVerifierRpc(
  supabase: SupabaseClient,
  input: CorrectDocumentDeliveryVerifierInput
): Promise<void> {
  const { error } = await supabase.rpc("correct_document_delivery_verifier", {
    p_document_id: input.documentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_new_employee_id: input.newEmployeeId,
    p_reason: input.reason ?? null,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }
}
