import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";

export type ClaimStatus = "CLAIMED" | "ALREADY_RUNNING";

export interface TryClaimClassificationRunInput {
  purchaseDocumentId: string;
  organizationId: string;
  staleAfterSeconds?: number;
}

export interface TryClaimClassificationRunResult {
  claimId: string | null;
  status: ClaimStatus;
}

/** Atomic claim acquisition -- see the migration for the full concurrency
 * reasoning. Two concurrent callers always resolve to exactly one CLAIMED
 * and one ALREADY_RUNNING, never two CLAIMEDs, never a raw constraint
 * error surfacing here. */
export async function tryClaimClassificationRunRpc(
  supabase: SupabaseClient,
  input: TryClaimClassificationRunInput
): Promise<TryClaimClassificationRunResult> {
  const { data, error } = await supabase.rpc("try_claim_purchase_document_classification_run", {
    p_purchase_document_id: input.purchaseDocumentId,
    p_organization_id: input.organizationId,
    p_stale_after_seconds: input.staleAfterSeconds ?? 300,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as { out_claim_id: string | null; out_status: ClaimStatus } | undefined;
  if (!row) {
    throw new Error("try_claim_purchase_document_classification_run returned no result row");
  }

  return { claimId: row.out_claim_id, status: row.out_status };
}

export async function finishClassificationRunRpc(
  supabase: SupabaseClient,
  input: { claimId: string; organizationId: string; outcome: "SUCCEEDED" | "FAILED" }
): Promise<void> {
  const { error } = await supabase.rpc("finish_purchase_document_classification_run", {
    p_claim_id: input.claimId,
    p_organization_id: input.organizationId,
    p_outcome: input.outcome,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }
}
