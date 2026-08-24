"use server";

import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listAdminStations, getAdminStation, createStation, updateStationName, setStationStatus, type AdminStationSummary } from "@/app/lib/admin/stations";
import { AdminActionError } from "@/app/lib/admin/errors";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as an Admin." };

export type ListAdminStationsResult = { ok: true; stations: AdminStationSummary[] } | AuthFailure;

export async function listAdminStationsAction(search: string | null, status: "active" | "inactive" | null): Promise<ListAdminStationsResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const stations = await listAdminStations(getServiceRoleClient(), { organizationId: auth.manager.organizationId, search, status });
  return { ok: true, stations };
}

export type GetAdminStationResult = { ok: true; station: AdminStationSummary } | AuthFailure | { ok: false; reason: "not_found"; message: string };

export async function getAdminStationAction(stationId: string): Promise<GetAdminStationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const station = await getAdminStation(getServiceRoleClient(), auth.manager.organizationId, stationId);
  if (!station) return { ok: false, reason: "not_found", message: "Station not found." };
  return { ok: true, station };
}

export type AdminStationMutationResult =
  | { ok: true }
  | AuthFailure
  | { ok: false; reason: "error"; code: string; message: string; detail?: string };

function toMutationResult(err: unknown): AdminStationMutationResult {
  if (err instanceof AdminActionError) {
    return { ok: false, reason: "error", code: err.code, message: err.message, detail: err.detail };
  }
  return { ok: false, reason: "error", code: "UNKNOWN", message: "Unable to save. Try again." };
}

export type CreateStationActionResult = { ok: true; stationId: string } | AuthFailure | { ok: false; reason: "error"; code: string; message: string; detail?: string };

export async function createStationAction(name: string): Promise<CreateStationActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    const stationId = await createStation(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, name);
    return { ok: true, stationId };
  } catch (err) {
    const mapped = toMutationResult(err);
    if (mapped.ok) throw err;
    return mapped;
  }
}

export async function updateStationNameAction(stationId: string, newName: string): Promise<AdminStationMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await updateStationName(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, stationId, newName);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export async function setStationStatusAction(stationId: string, isActive: boolean): Promise<AdminStationMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await setStationStatus(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, stationId, isActive);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}
