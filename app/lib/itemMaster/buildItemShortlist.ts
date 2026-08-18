import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ItemShortlistCandidate } from "@/app/lib/ai/tasks/itemClassification/types";

const SHORTLIST_LIMIT = 25;

/** A simple, non-AI, org-scoped text-similarity search over CONFIRMED
 * Item Master entries -- never the whole item master, never a
 * PENDING_REVIEW row (a proposal must never become a candidate merely
 * because a second invoice arrives before the first is approved). Capped
 * at SHORTLIST_LIMIT candidates. Deliberately simple: split the vendor's
 * free-text description into significant words and match any of them
 * against inventory_items.name, falling back to the organization's most
 * common items by name if the description yields nothing usable (e.g. an
 * abbreviation-only vendor SKU with no readable words). This is NOT a
 * fuzzy/AI match -- it only narrows the candidate pool the AI (or a
 * manager) chooses from; it never decides anything on its own. */
export async function buildItemShortlist(
  supabase: SupabaseClient,
  organizationId: string,
  description: string | null
): Promise<ItemShortlistCandidate[]> {
  const words = (description ?? "")
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3)
    .slice(0, 5);

  let query = supabase
    .from("inventory_items")
    .select("id, name, base_unit_id, inventory_categories(name), units(code)")
    .eq("organization_id", organizationId)
    .eq("approval_status", "CONFIRMED")
    .order("name")
    .limit(SHORTLIST_LIMIT);

  if (words.length > 0) {
    query = query.or(words.map((w) => `name.ilike.%${w}%`).join(","));
  }

  const { data } = await query;
  const rows = data ?? [];

  return rows.map((row) => {
    const category = Array.isArray(row.inventory_categories) ? row.inventory_categories[0] : row.inventory_categories;
    const unit = Array.isArray(row.units) ? row.units[0] : row.units;
    return {
      id: row.id as string,
      name: row.name as string,
      categoryName: (category?.name as string | undefined) ?? null,
      baseUnitCode: (unit?.code as string | undefined) ?? null,
    };
  });
}
