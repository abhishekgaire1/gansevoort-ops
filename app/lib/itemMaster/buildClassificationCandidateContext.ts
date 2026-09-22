import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClassificationCandidateContext } from "@/app/lib/ai/tasks/itemClassification/types";
import { flattenSpendCategoryPaths } from "@/app/lib/itemMaster/spendCategoryPaths";

/** The closed treatment vocabulary, with meaning, exactly as the model may
 * return it (mirrors the database CHECK constraint). */
export const LINE_TREATMENT_VOCABULARY: ClassificationCandidateContext["lineTreatments"] = [
  { value: "INVENTORY_PURCHASE", meaning: "A physical product the business stocks and counts." },
  { value: "EXPENSE", meaning: "A service, repair, subscription or untracked supply -- needs an expense category." },
  { value: "FREIGHT_FEE", meaning: "Delivery, freight, fuel surcharge, handling, minimum-order or service charge -- needs an expense category." },
  { value: "TAX", meaning: "Sales tax -- document-level, no category." },
  { value: "DISCOUNT", meaning: "A promotional, volume, early-payment or allowance discount -- totals only." },
  { value: "CREDIT_RETURN", meaning: "A vendor credit, returned-container credit, or merchandise physically returned." },
  { value: "UNRESOLVED", meaning: "The line cannot be classified from its text and amount." },
];

export const CREDIT_SUBTYPE_VOCABULARY: ClassificationCandidateContext["creditSubtypes"] = [
  { value: "FINANCIAL_CREDIT", meaning: "Invoice correction, allowance or account credit; nothing physically moved." },
  { value: "RETURNABLE_CONTAINER_CREDIT", meaning: "Crates, cases, kegs, pallets or bottle deposits returned; no tracked stock moved." },
  { value: "INVENTORY_RETURN", meaning: "Tracked merchandise physically returned to the vendor; inventory decreases." },
];

/**
 * The ground-truth candidate lists a classification AI call must choose
 * FROM, by id/code -- never asked to invent free-text names that then have
 * to survive an exact-match lookup against this same data. ACTIVE-only,
 * since an inactive category is never a valid choice. Built once per
 * classification batch (org-wide, not per line -- unlike the per-line item
 * shortlist, these lists are small and identical for every line).
 */
export async function buildClassificationCandidateContext(supabase: SupabaseClient, organizationId: string, vendorId: string | null = null): Promise<ClassificationCandidateContext> {
  const [{ data: categoryRows }, { data: spendCategoryRows }, { data: unitRows }] = await Promise.all([
    supabase.from("inventory_categories").select("id, name").eq("organization_id", organizationId).eq("is_active", true).order("name"),
    supabase.from("spend_categories").select("id, name, parent_id, description").eq("organization_id", organizationId).eq("is_active", true).order("name"),
    supabase.from("units").select("code, name").order("code"),
  ]);

  let vendor: ClassificationCandidateContext["vendor"] = null;
  if (vendorId) {
    try {
      const { data: vendorRow } = await supabase.from("vendors").select("name, classification").eq("id", vendorId).eq("organization_id", organizationId).maybeSingle();
      if (vendorRow) {
        vendor = { name: (vendorRow.name as string | null) ?? null, classification: ((vendorRow.classification as string | null) ?? null) as "INVENTORY" | "NON_INVENTORY" | null };
      }
    } catch {
      vendor = null; // vendor context is a hint; its absence never blocks classification
    }
  }

  const descriptionById = new Map((spendCategoryRows ?? []).map((c) => [c.id as string, (c.description as string | null) ?? null]));
  const spendCategories = flattenSpendCategoryPaths(
    (spendCategoryRows ?? []).map((c) => ({ id: c.id as string, name: c.name as string, parentId: c.parent_id as string | null }))
  );

  return {
    vendor,
    inventoryCategories: (categoryRows ?? []).map((c) => ({ id: c.id as string, name: c.name as string })),
    // The AI needs id + path + the Admin's description to match on meaning;
    // requiresExplanation is a manager-UI concern, deliberately not sent.
    spendCategories: spendCategories.map((s) => ({ id: s.id, path: s.path, description: descriptionById.get(s.id) ?? null })),
    units: (unitRows ?? []).map((u) => ({ code: u.code as string, name: u.name as string })),
    lineTreatments: LINE_TREATMENT_VOCABULARY,
    creditSubtypes: CREDIT_SUBTYPE_VOCABULARY,
  };
}
