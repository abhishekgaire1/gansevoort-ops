"use server";

import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import {
  listAdminLocations,
  createLocation,
  updateLocationName,
  setLocationStorageEligible,
  setLocationStatus,
  setDefaultLocation,
  type AdminLocationSummary,
} from "@/app/lib/admin/locations";
import { AdminActionError } from "@/app/lib/admin/errors";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as an Admin." };

export type ListAdminLocationsResult = { ok: true; locations: AdminLocationSummary[] } | AuthFailure;

export async function listAdminLocationsAction(): Promise<ListAdminLocationsResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  const locations = await listAdminLocations(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, locations };
}

export type AdminLocationMutationResult =
  | { ok: true }
  | AuthFailure
  | { ok: false; reason: "error"; code: string; message: string; detail?: string };

function toMutationResult(err: unknown): AdminLocationMutationResult {
  if (err instanceof AdminActionError) {
    return { ok: false, reason: "error", code: err.code, message: err.message, detail: err.detail };
  }
  return { ok: false, reason: "error", code: "UNKNOWN", message: "Unable to save. Try again." };
}

export type CreateLocationActionResult =
  | { ok: true; locationId: string }
  | AuthFailure
  | { ok: false; reason: "error"; code: string; message: string; detail?: string };

export async function createLocationAction(name: string, isStorageEligible: boolean): Promise<CreateLocationActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    const locationId = await createLocation(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, name, isStorageEligible);
    return { ok: true, locationId };
  } catch (err) {
    const mapped = toMutationResult(err);
    if (mapped.ok) throw err;
    return mapped;
  }
}

export async function updateLocationNameAction(locationId: string, name: string): Promise<AdminLocationMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    await updateLocationName(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, locationId, name);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export async function setLocationStorageEligibleAction(locationId: string, isStorageEligible: boolean): Promise<AdminLocationMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    await setLocationStorageEligible(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, locationId, isStorageEligible);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export async function setLocationStatusAction(locationId: string, isActive: boolean): Promise<AdminLocationMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    await setLocationStatus(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, locationId, isActive);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export async function setDefaultLocationAction(locationId: string): Promise<AdminLocationMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    await setDefaultLocation(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, locationId);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}
