"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listStorageEligibleLocations, type StorageEligibleLocation } from "@/app/lib/inventory/cycleCounts";
import {
  listInventoryActivity,
  getInventoryActivityDetail,
  type InventoryActivityPage,
  type GlobalActivityDetail,
} from "@/app/lib/inventory/globalActivity";
import type { ActivityTypeFilter } from "@/app/lib/inventory/activityTypeFilters";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export interface InventoryActivityFilters {
  search?: string | null;
  filter?: ActivityTypeFilter;
  locationId?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
}

export type ListInventoryActivityResult = { ok: true; page: InventoryActivityPage } | AuthFailure;

export async function listInventoryActivityAction(
  filters: InventoryActivityFilters,
  cursor: { occurredAt: string; id: string } | null
): Promise<ListInventoryActivityResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const page = await listInventoryActivity(getServiceRoleClient(), {
    organizationId: auth.manager.organizationId,
    search: filters.search,
    filter: filters.filter,
    locationId: filters.locationId,
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    beforeOccurredAt: cursor?.occurredAt ?? null,
    beforeId: cursor?.id ?? null,
  });
  return { ok: true, page };
}

export type GetInventoryActivityDetailResult = { ok: true; detail: GlobalActivityDetail } | AuthFailure | { ok: false; reason: "not_found"; message: string };

export async function getInventoryActivityDetailAction(movementLineId: string): Promise<GetInventoryActivityDetailResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const detail = await getInventoryActivityDetail(getServiceRoleClient(), auth.manager.organizationId, movementLineId);
  if (!detail) return { ok: false, reason: "not_found", message: "Inventory activity not found." };
  return { ok: true, detail };
}

export type ListActivityLocationsResult = { ok: true; locations: StorageEligibleLocation[] } | AuthFailure;

export async function listActivityLocationsAction(): Promise<ListActivityLocationsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const locations = await listStorageEligibleLocations(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, locations };
}
