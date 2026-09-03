import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Read-only mirror of migration 20260811100132's own guard inside
 * post_purchase_document_inventory: an amendment lineage may post
 * inventory at most once. Used to tell the manager UP FRONT, on the
 * combined Confirm Items & Receiving step, that this amendment will not
 * post inventory again -- never letting them reach the final screen still
 * expecting a posting that the server would reject.
 */
export async function hasSiblingRevisionAlreadyPosted(supabase: SupabaseClient, purchaseDocumentId: string, organizationId: string): Promise<boolean> {
  const { data: purchaseDocument } = await supabase
    .from("purchase_documents")
    .select("revision_group_id")
    .eq("id", purchaseDocumentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const revisionGroupId = purchaseDocument?.revision_group_id as string | undefined;
  if (!revisionGroupId) return false;

  const { data: siblingRevisions } = await supabase
    .from("purchase_documents")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("revision_group_id", revisionGroupId)
    .neq("id", purchaseDocumentId);
  const siblingIds = (siblingRevisions ?? []).map((r) => r.id as string);
  if (siblingIds.length === 0) return false;

  const { count } = await supabase
    .from("purchase_document_inventory_postings")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("purchase_document_id", siblingIds);
  return Boolean(count && count > 0);
}
