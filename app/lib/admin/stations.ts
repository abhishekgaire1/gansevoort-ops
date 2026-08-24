import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapAdminRpcError } from "@/app/lib/admin/errors";

/**
 * Admin Foundation milestone -- Stations administration. Wraps
 * list_admin_stations / get_admin_station / create_station /
 * update_station_name / set_station_status (20260811100094). Stations
 * are never hard-deleted (Part 24/49) -- deactivate/reactivate only, and
 * deactivation is blocked server-side while active employees still
 * reference the station as their default (Part 25).
 */

export interface AdminStationSummary {
  stationId: string;
  name: string;
  code: string | null;
  isActive: boolean;
  defaultEmployeeCount: number;
}

interface AdminStationRow {
  out_station_id: string;
  out_name: string;
  out_code: string | null;
  out_is_active: boolean;
  out_default_employee_count: number;
}

function mapStationRow(row: AdminStationRow): AdminStationSummary {
  return {
    stationId: row.out_station_id,
    name: row.out_name,
    code: row.out_code,
    isActive: row.out_is_active,
    defaultEmployeeCount: row.out_default_employee_count,
  };
}

export interface ListAdminStationsInput {
  organizationId: string;
  search?: string | null;
  status?: "active" | "inactive" | null;
}

export async function listAdminStations(supabase: SupabaseClient, input: ListAdminStationsInput): Promise<AdminStationSummary[]> {
  const { data, error } = await supabase.rpc("list_admin_stations", {
    p_organization_id: input.organizationId,
    p_search: input.search?.trim() ? input.search.trim() : null,
    p_status: input.status ?? null,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as AdminStationRow[]).map(mapStationRow);
}

export async function getAdminStation(supabase: SupabaseClient, organizationId: string, stationId: string): Promise<AdminStationSummary | null> {
  const { data, error } = await supabase.rpc("get_admin_station", { p_organization_id: organizationId, p_station_id: stationId });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as AdminStationRow | undefined;
  return row ? mapStationRow(row) : null;
}

export async function createStation(supabase: SupabaseClient, organizationId: string, actorAppUserId: string, name: string): Promise<string> {
  const { data, error } = await supabase.rpc("create_station", { p_organization_id: organizationId, p_actor_app_user_id: actorAppUserId, p_name: name });
  if (error) throw mapAdminRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_station_id: string } | undefined;
  if (!row) throw new Error("create_station returned no result");
  return row.out_station_id;
}

export async function updateStationName(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  stationId: string,
  newName: string
): Promise<void> {
  const { error } = await supabase.rpc("update_station_name", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_station_id: stationId,
    p_new_name: newName,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function setStationStatus(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  stationId: string,
  isActive: boolean
): Promise<void> {
  const { error } = await supabase.rpc("set_station_status", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_station_id: stationId,
    p_is_active: isActive,
  });
  if (error) throw mapAdminRpcError(error);
}
