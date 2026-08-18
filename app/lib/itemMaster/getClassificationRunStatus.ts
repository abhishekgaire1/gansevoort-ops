import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ClassificationRunStatus {
  /** True while the most recent run for this document has been claimed
   * but not yet finished (purchase_document_classification_runs.completed_at
   * IS NULL) -- the one real signal this system has for "AI item matching
   * is currently in progress." Never a fabricated percentage or fake
   * sub-phase; this table has no such granularity, so the UI built on top
   * of this shows a single honest "in progress" state, not an invented
   * multi-step checklist. */
  active: boolean;
  outcome: "SUCCEEDED" | "FAILED" | "ABANDONED" | null;
}

export async function getClassificationRunStatus(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  organizationId: string
): Promise<ClassificationRunStatus> {
  const { data } = await supabase
    .from("purchase_document_classification_runs")
    .select("completed_at, outcome")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("organization_id", organizationId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { active: false, outcome: null };
  return { active: data.completed_at === null, outcome: (data.outcome as ClassificationRunStatus["outcome"]) ?? null };
}
