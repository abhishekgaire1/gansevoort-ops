import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapItemMasterRpcError } from "@/app/lib/itemMaster/errors";
import type { DeterministicClassificationMatch } from "@/app/lib/itemMaster/resolveDeterministicClassification";

export interface ResolveLineClassificationDeterministicInput {
  organizationId: string;
  purchaseDocumentId: string;
  lineKey: string;
  inventoryItemId: string;
  resolutionSource: DeterministicClassificationMatch["resolutionSource"];
}

/** Zero-AI-call tier -- reapplies a mapping/name match a manager has
 * already confirmed previously. Audited as LINE_CLASSIFICATION_AUTO_RESOLVED
 * (no actor -- a system decision, not a manager click). */
export async function resolveLineClassificationDeterministicRpc(
  supabase: SupabaseClient,
  input: ResolveLineClassificationDeterministicInput
): Promise<void> {
  const { error } = await supabase.rpc("resolve_line_classification_deterministic", {
    p_organization_id: input.organizationId,
    p_purchase_document_id: input.purchaseDocumentId,
    p_line_key: input.lineKey,
    p_inventory_item_id: input.inventoryItemId,
    p_resolution_source: input.resolutionSource,
  });

  if (error) {
    throw mapItemMasterRpcError(error);
  }
}
