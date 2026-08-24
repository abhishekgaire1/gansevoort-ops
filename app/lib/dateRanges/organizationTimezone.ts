import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const FALLBACK_TIMEZONE = "America/New_York";

/**
 * There is no per-organization timezone column -- only locations.timezone,
 * the existing convention every business_date RPC already uses.
 * Organization-wide reporting (AI usage/cost, expense-category totals) is
 * not tied to a specific location, so "the organization's timezone" is
 * resolved as its earliest-created location's timezone -- the same
 * de-facto single-location-per-org assumption already made elsewhere in
 * this codebase, never a second timezone system.
 */
export async function resolveOrganizationTimezone(supabase: SupabaseClient, organizationId: string): Promise<string> {
  const { data } = await supabase.from("locations").select("timezone").eq("organization_id", organizationId).order("created_at", { ascending: true }).limit(1).maybeSingle();

  return (data?.timezone as string | undefined) ?? FALLBACK_TIMEZONE;
}
