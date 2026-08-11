import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Framework-agnostic core for the kiosk's station picker. Takes an
 * already-authenticated SupabaseClient rather than constructing its own,
 * mirroring the split used throughout app/lib/** (verifyPinCore,
 * recordInventoryWithdrawal).
 */

export interface KioskStation {
  id: string;
  name: string;
  code: string | null;
}

export async function listActiveStationsForOrganization(
  supabase: SupabaseClient,
  organizationId: string
): Promise<KioskStation[]> {
  const { data, error } = await supabase
    .from("stations")
    .select("id, name, code")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("name");

  if (error) {
    throw new Error(`listActiveStationsForOrganization failed: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    code: (row.code as string | null) ?? null,
  }));
}
