import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPurchaseDocumentRpcError } from "@/app/lib/purchaseDocuments/errors";
import type { MappingProposals, ReceivingProposals } from "@/app/lib/purchaseDocuments/reviewProposals";

/**
 * Typed wrapper around save_purchase_document_review_proposals
 * (20260811100071) -- upserts Manager 2's PROVISIONAL correction overlay
 * for an in-review document. Non-preparer-only (GA004), READY_FOR_
 * VERIFICATION only (GA002). Persisting a proposal changes NO
 * authoritative state: effective receipts and confirmed classifications
 * are untouched until verify_purchase_document promotes the overlay
 * atomically. Passing two empty objects clears the overlay.
 */

export interface SaveReviewProposalsInput {
  purchaseDocumentId: string;
  organizationId: string;
  appUserId: string;
  /** Optimistic-concurrency token: 0 when no overlay exists yet (creation),
   * else the version the caller last loaded. A mismatch is rejected with
   * ReviewProposalsConflictError (GA018) -- never a silent last-write-wins
   * overwrite of another tab's proposals. */
  expectedVersion: number;
  mappingProposals: MappingProposals;
  receivingProposals: ReceivingProposals;
}

export interface SaveReviewProposalsResult {
  /** The overlay's new version (0 when the save cleared it). */
  version: number;
  mappingCount: number;
  receivingCount: number;
}

export async function saveReviewProposalsRpc(supabase: SupabaseClient, input: SaveReviewProposalsInput): Promise<SaveReviewProposalsResult> {
  const { data, error } = await supabase.rpc("save_purchase_document_review_proposals", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: input.organizationId,
    p_app_user_id: input.appUserId,
    p_expected_version: input.expectedVersion,
    p_mapping_proposals: input.mappingProposals,
    p_receiving_proposals: input.receivingProposals,
  });

  if (error) {
    throw mapPurchaseDocumentRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as { out_version: number; out_mapping_count: number; out_receiving_count: number } | undefined;
  if (!row) {
    throw new Error("save_purchase_document_review_proposals returned no result row");
  }

  return { version: Number(row.out_version), mappingCount: row.out_mapping_count, receivingCount: row.out_receiving_count };
}
