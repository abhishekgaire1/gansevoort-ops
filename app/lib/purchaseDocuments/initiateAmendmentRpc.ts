import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";

/**
 * Typed wrapper around initiate_purchase_document_amendment. Creates a new
 * revision (DRAFT, sharing revision_group_id, previous_revision_id pointing
 * back) from the CURRENT verified revision -- never mutates the row it
 * amends. Any manager/admin may initiate (there's no "who may amend"
 * restriction beyond that); the resulting revision's own preparer becomes
 * the initiator, so the ordinary save/submit/verify/return RPCs then
 * enforce maker-checker against THIS revision's own creator, unchanged.
 */

export interface InitiateAmendmentInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  reason: string;
}

export interface InitiateAmendmentResult {
  purchaseDocumentId: string;
  revisionNumber: number;
}

interface InitiateAmendmentRow {
  out_purchase_document_id: string;
  out_revision_number: number;
}

export async function initiateAmendmentRpc(
  supabase: SupabaseClient,
  input: InitiateAmendmentInput
): Promise<InitiateAmendmentResult> {
  const { data, error } = await supabase.rpc("initiate_purchase_document_amendment", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_reason: input.reason,
  });

  if (error) {
    throw mapPurchaseDocumentRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as InitiateAmendmentRow | undefined;
  if (!row) {
    throw new Error("initiate_purchase_document_amendment returned no result row");
  }

  return { purchaseDocumentId: row.out_purchase_document_id, revisionNumber: row.out_revision_number };
}
