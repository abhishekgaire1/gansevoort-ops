import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Framework-agnostic core for the kiosk's station picker. Takes an
 * already-authenticated SupabaseClient rather than constructing its own,
 * mirroring the split used throughout app/lib/** (verifyPinCore,
 * recordInventoryWithdrawal).
 *
 * Kiosk station assignment enforcement (20260811100130): this is now the
 * ONLY station list the kiosk ever shows -- an employee's ACTIVE
 * assignments to ACTIVE stations in their OWN organization, via
 * list_employee_station_assignments. An unassigned, inactive, deleted,
 * cross-organization, or fixture station can never appear here, because
 * both the assignment row and the station row are required active AND
 * same-organization at the database level. This function is a UX/display
 * concern only -- the actual authorization boundary is
 * record_inventory_withdrawal's own independent re-check.
 */

export interface KioskStation {
  id: string;
  name: string;
  code: string | null;
}

interface EmployeeStationAssignmentRow {
  out_station_id: string;
  out_station_name: string;
  out_station_code: string | null;
}

export async function listAssignedActiveStationsForEmployee(
  supabase: SupabaseClient,
  organizationId: string,
  employeeId: string
): Promise<KioskStation[]> {
  const { data, error } = await supabase.rpc("list_employee_station_assignments", {
    p_organization_id: organizationId,
    p_employee_id: employeeId,
  });

  if (error) {
    throw new Error(`listAssignedActiveStationsForEmployee failed: ${error.message}`);
  }

  return ((data ?? []) as EmployeeStationAssignmentRow[]).map((row) => ({
    id: row.out_station_id,
    name: row.out_station_name,
    code: row.out_station_code,
  }));
}

/** Every active station in the organization, with NO per-employee
 * filtering -- used only for Admin surfaces where the manager is choosing
 * WHICH stations to assign an employee to (the full set of valid options),
 * never for anything the kiosk itself shows an employee. Do not use this
 * for kiosk station display/authorization -- that must always go through
 * listAssignedActiveStationsForEmployee above. */
export async function listAllActiveStationsForOrganization(supabase: SupabaseClient, organizationId: string): Promise<KioskStation[]> {
  const { data, error } = await supabase
    .from("stations")
    .select("id, name, code")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("name");

  if (error) {
    throw new Error(`listAllActiveStationsForOrganization failed: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    code: (row.code as string | null) ?? null,
  }));
}
