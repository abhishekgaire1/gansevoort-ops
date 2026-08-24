import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * AI Configuration milestone -- read-only lookup against the versioned,
 * platform-level ai_model_pricing catalog (see the migration's own
 * comment for why it's insert-only/never organization-scoped). Used by
 * the Admin Configuration page to warn when a selectable model has no
 * pricing configured yet (Part 28) -- actual cost calculation at AI-call
 * time happens server-side inside record_ai_usage_event, never here.
 */
export async function hasCurrentPricing(supabase: SupabaseClient, provider: string, model: string): Promise<boolean> {
  const { data } = await supabase
    .from("ai_model_pricing")
    .select("id")
    .eq("provider", provider)
    .eq("model", model)
    .lte("effective_from", new Date().toISOString())
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}
