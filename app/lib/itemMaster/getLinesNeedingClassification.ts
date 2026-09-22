import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface LineNeedingClassification {
  lineKey: string;
  vendorSku: string | null;
  description: string | null;
  packageQuantity: number | null;
  packageUnit: string | null;
  measuredQuantity: number | null;
  measuredUnit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
}

/**
 * The corrected, set-based "does this document need a classification run"
 * signal (see the 2A.3 plan §4/§13) -- deliberately NOT a count comparison.
 * Intentionally-retained orphaned classification rows (whose line_key no
 * longer matches any CURRENT line) can inflate a naive count enough to
 * make it falsely equal even when a genuinely new, unclassified current
 * line exists. This instead looks up every CURRENT line's own
 * classification status directly:
 *   - no matching row, or a row with status='STALE' -> needs (re-)resolution
 *   - a PENDING_REVIEW row the MANAGER re-opened as an inventory purchase
 *     (line_treatment INVENTORY_PURCHASE, resolution_source MANUAL, no item
 *     and no candidate yet) -> needs an item match
 *   - status='PENDING_REVIEW' otherwise -> correctly awaiting manager
 *     approval, excluded from every AUTOMATIC trigger (submit, review-
 *     correction, page-load recovery) -- a manager mid-review must never
 *     have their pending suggestion silently swapped out from under them.
 *     Pass includeUnconfirmedAiProposals for the one path where re-touching
 *     a PENDING_REVIEW line is explicitly desired and manager-initiated: the
 *     "Run Item Matching" button refreshing an OLD AI/rule proposal against
 *     the current classifier.
 *   - status='CONFIRMED' -> complete, always excluded
 */
export async function getLinesNeedingClassification(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  organizationId: string,
  options?: { includeUnconfirmedAiProposals?: boolean }
): Promise<LineNeedingClassification[]> {
  const { data: lines } = await supabase
    .from("purchase_document_lines")
    .select("line_key, vendor_sku, description, package_quantity, package_unit, measured_quantity, measured_unit, unit_price, line_total")
    .eq("purchase_document_id", purchaseDocumentId);

  const { data: classifications } = await supabase
    .from("purchase_document_line_classifications")
    .select("line_key, status, resolution_source, line_treatment, inventory_item_id, ai_suggested_inventory_item_id")
    .eq("purchase_document_id", purchaseDocumentId)
    .eq("organization_id", organizationId);

  const classificationByLineKey = new Map((classifications ?? []).map((c) => [c.line_key as string, c]));

  return (lines ?? [])
    .filter((l) => {
      const classification = classificationByLineKey.get(l.line_key as string);
      if (!classification || classification.status === "STALE") return true;
      if (classification.status !== "PENDING_REVIEW") return false;
      if (
        classification.resolution_source === "MANUAL" &&
        classification.line_treatment === "INVENTORY_PURCHASE" &&
        !classification.inventory_item_id &&
        !classification.ai_suggested_inventory_item_id
      ) {
        return true;
      }
      if (options?.includeUnconfirmedAiProposals && (classification.resolution_source === "AI_SUGGESTED" || classification.resolution_source === "VENDOR_TREATMENT_RULE")) {
        return true;
      }
      return false;
    })
    .map((l) => ({
      lineKey: l.line_key as string,
      vendorSku: l.vendor_sku as string | null,
      description: l.description as string | null,
      packageQuantity: (l.package_quantity as number | null) ?? null,
      packageUnit: l.package_unit as string | null,
      measuredQuantity: (l.measured_quantity as number | null) ?? null,
      measuredUnit: l.measured_unit as string | null,
      unitPrice: (l.unit_price as number | null) ?? null,
      lineTotal: (l.line_total as number | null) ?? null,
    }));
}
