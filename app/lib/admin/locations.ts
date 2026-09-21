import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapAdminRpcError } from "@/app/lib/admin/errors";

/**
 * Storage-location administration (20260811100180). Wraps
 * list_admin_locations / create_location / update_location_name /
 * set_location_storage_eligible / set_location_status /
 * set_default_location.
 *
 * Storage locations are the SAME public.locations dimension used by
 * stations, inventory_movements, and receipts -- not a new concept. A
 * location is a valid receiving destination only when isActive AND
 * isStorageEligible. Locations are never hard-deleted (deactivate only),
 * and the server blocks deactivating/de-eligibility of a location that
 * holds stock or is the org default.
 */

export interface AdminLocationSummary {
  locationId: string;
  name: string;
  isActive: boolean;
  isStorageEligible: boolean;
  isDefault: boolean;
  hasStock: boolean;
  movementCount: number;
  stationCount: number;
  receiptCount: number;
}

interface AdminLocationRow {
  out_id: string;
  out_name: string;
  out_is_active: boolean;
  out_is_storage_eligible: boolean;
  out_is_default: boolean;
  out_has_stock: boolean;
  out_movement_count: number;
  out_station_count: number;
  out_receipt_count: number;
}

function mapRow(row: AdminLocationRow): AdminLocationSummary {
  return {
    locationId: row.out_id,
    name: row.out_name,
    isActive: row.out_is_active,
    isStorageEligible: row.out_is_storage_eligible,
    isDefault: row.out_is_default,
    hasStock: row.out_has_stock,
    movementCount: Number(row.out_movement_count),
    stationCount: Number(row.out_station_count),
    receiptCount: Number(row.out_receipt_count),
  };
}

export async function listAdminLocations(supabase: SupabaseClient, organizationId: string): Promise<AdminLocationSummary[]> {
  const { data, error } = await supabase.rpc("list_admin_locations", { p_organization_id: organizationId });
  if (error) throw new Error(error.message);
  return ((data ?? []) as AdminLocationRow[]).map(mapRow);
}

export async function getAdminLocation(supabase: SupabaseClient, organizationId: string, locationId: string): Promise<AdminLocationSummary | null> {
  const all = await listAdminLocations(supabase, organizationId);
  return all.find((l) => l.locationId === locationId) ?? null;
}

export async function createLocation(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  name: string,
  isStorageEligible: boolean
): Promise<string> {
  const { data, error } = await supabase.rpc("create_location", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_name: name,
    p_is_storage_eligible: isStorageEligible,
  });
  if (error) throw mapAdminRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_location_id: string } | undefined;
  if (!row) throw new Error("create_location returned no result");
  return row.out_location_id;
}

export async function updateLocationName(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  locationId: string,
  name: string
): Promise<void> {
  const { error } = await supabase.rpc("update_location_name", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_location_id: locationId,
    p_name: name,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function setLocationStorageEligible(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  locationId: string,
  isStorageEligible: boolean
): Promise<void> {
  const { error } = await supabase.rpc("set_location_storage_eligible", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_location_id: locationId,
    p_is_storage_eligible: isStorageEligible,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function setLocationStatus(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  locationId: string,
  isActive: boolean
): Promise<void> {
  const { error } = await supabase.rpc("set_location_status", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_location_id: locationId,
    p_is_active: isActive,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function setDefaultLocation(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  locationId: string
): Promise<void> {
  const { error } = await supabase.rpc("set_default_location", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_location_id: locationId,
  });
  if (error) throw mapAdminRpcError(error);
}
