import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeDescription } from "./normalizeDescription";

export interface DeterministicClassificationInput {
  organizationId: string;
  vendorId: string | null;
  vendorSku: string | null;
  description: string | null;
}

export interface DeterministicClassificationMatch {
  inventoryItemId: string;
  resolutionSource: "VENDOR_SKU_MAPPING" | "VENDOR_DESCRIPTION_MAPPING" | "NORMALIZED_NAME_MATCH";
}

/** Priority-order deterministic lookup, run before any AI call, on every
 * unresolved line -- zero AI calls for anything already known:
 *   1. confirmed vendor_item_mappings row, match_basis=VENDOR_SKU
 *   2. confirmed vendor_item_mappings row, match_basis=NORMALIZED_DESCRIPTION
 *   3. a CONFIRMED Item Master entry whose name exactly matches (case-
 *      insensitive) the line's own description
 * Returns null if none of the three tiers resolve -- the caller should
 * fall through to AI (or leave it unresolved, awaiting AI). */
export async function resolveDeterministicClassification(
  supabase: SupabaseClient,
  input: DeterministicClassificationInput
): Promise<DeterministicClassificationMatch | null> {
  if (input.vendorId && input.vendorSku) {
    const { data } = await supabase
      .from("vendor_item_mappings")
      .select("inventory_item_id")
      .eq("organization_id", input.organizationId)
      .eq("vendor_id", input.vendorId)
      .eq("match_basis", "VENDOR_SKU")
      .eq("vendor_sku", input.vendorSku)
      .eq("is_active", true)
      .maybeSingle();
    if (data) {
      return { inventoryItemId: data.inventory_item_id as string, resolutionSource: "VENDOR_SKU_MAPPING" };
    }
  }

  if (input.vendorId && input.description) {
    const normalized = normalizeDescription(input.description);
    const { data } = await supabase
      .from("vendor_item_mappings")
      .select("inventory_item_id")
      .eq("organization_id", input.organizationId)
      .eq("vendor_id", input.vendorId)
      .eq("match_basis", "NORMALIZED_DESCRIPTION")
      .eq("normalized_description", normalized)
      .eq("is_active", true)
      .maybeSingle();
    if (data) {
      return { inventoryItemId: data.inventory_item_id as string, resolutionSource: "VENDOR_DESCRIPTION_MAPPING" };
    }
  }

  if (input.description) {
    const { data } = await supabase
      .from("inventory_items")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("approval_status", "CONFIRMED")
      .ilike("name", input.description.trim())
      .limit(1)
      .maybeSingle();
    if (data) {
      return { inventoryItemId: data.id as string, resolutionSource: "NORMALIZED_NAME_MATCH" };
    }
  }

  return null;
}
