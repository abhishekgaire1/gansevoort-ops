import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClassificationCandidateContext } from "@/app/lib/ai/tasks/itemClassification/types";
import { flattenSpendCategoryPaths } from "@/app/lib/itemMaster/spendCategoryPaths";

/**
 * The ground-truth candidate lists a new-item classification AI call must
 * choose FROM, by id/code -- never asked to invent free-text category names
 * that then have to survive an exact-match lookup against this same data
 * (that brittleness, e.g. AI saying "Dairy" against a canonical "Dairy &
 * Eggs", is exactly what previously left category_id/spend_category_id
 * null on a real invoice line). ACTIVE-only, since an inactive category is
 * never a valid choice for a brand-new item either. Built once per
 * classification batch (org-wide, not per line -- unlike the per-line item
 * shortlist, these lists are small and identical for every line in the
 * batch).
 */
export async function buildClassificationCandidateContext(supabase: SupabaseClient, organizationId: string): Promise<ClassificationCandidateContext> {
  const [{ data: categoryRows }, { data: spendCategoryRows }, { data: unitRows }] = await Promise.all([
    supabase.from("inventory_categories").select("id, name").eq("organization_id", organizationId).eq("is_active", true).order("name"),
    supabase.from("spend_categories").select("id, name, parent_id").eq("organization_id", organizationId).eq("is_active", true).order("name"),
    supabase.from("units").select("code, name").order("code"),
  ]);

  const spendCategories = flattenSpendCategoryPaths(
    (spendCategoryRows ?? []).map((c) => ({ id: c.id as string, name: c.name as string, parentId: c.parent_id as string | null }))
  );

  return {
    inventoryCategories: (categoryRows ?? []).map((c) => ({ id: c.id as string, name: c.name as string })),
    spendCategories,
    units: (unitRows ?? []).map((u) => ({ code: u.code as string, name: u.name as string })),
  };
}
