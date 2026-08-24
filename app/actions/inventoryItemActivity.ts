"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import {
  getInventoryItemLocationSummary,
  listInventoryItemActivity,
  type InventoryItemLocationSummary,
  type InventoryItemActivityPage,
  type ActivityTypeFilter,
} from "@/app/lib/inventory/itemActivity";
import { getInventoryItemLastReceived, getInventoryItemUsageTotals, type InventoryItemLastReceived, type InventoryItemUsageTotals } from "@/app/lib/inventory/itemOverview";
import { getInventoryItemUsageByStation, getInventoryItemUsageTrend, type InventoryItemUsageByStation, type RawUsageTrendPoint } from "@/app/lib/inventory/itemUsage";
import type { UsagePeriod, CustomUsageRange } from "@/app/lib/inventory/usagePeriods";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export type GetInventoryItemSummaryResult = { ok: true; summary: InventoryItemLocationSummary } | AuthFailure | { ok: false; reason: "not_found"; message: string };

export async function getInventoryItemSummaryAction(inventoryItemId: string, locationId: string): Promise<GetInventoryItemSummaryResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const summary = await getInventoryItemLocationSummary(getServiceRoleClient(), auth.manager.organizationId, inventoryItemId, locationId);
  if (!summary) return { ok: false, reason: "not_found", message: "Inventory item not found." };
  return { ok: true, summary };
}

export type ListInventoryItemActivityResult = { ok: true; page: InventoryItemActivityPage } | AuthFailure;

export async function listInventoryItemActivityAction(
  inventoryItemId: string,
  locationId: string,
  filter: ActivityTypeFilter,
  cursor: { occurredAt: string; id: string } | null
): Promise<ListInventoryItemActivityResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const page = await listInventoryItemActivity(getServiceRoleClient(), {
    organizationId: auth.manager.organizationId,
    inventoryItemId,
    locationId,
    filter,
    beforeOccurredAt: cursor?.occurredAt ?? null,
    beforeId: cursor?.id ?? null,
  });
  return { ok: true, page };
}

export interface InventoryItemOverviewExtras {
  lastReceived: InventoryItemLastReceived | null;
  usageTotals: InventoryItemUsageTotals;
}

export type GetInventoryItemOverviewExtrasResult = { ok: true; extras: InventoryItemOverviewExtras } | AuthFailure;

/** The Overview tab's two sections beyond the always-fetched stock
 * summary (Last Received, Recent Withdrawals) -- kept as one action so
 * the tab issues one round-trip, not two, but still isolated from the
 * summary/activity actions so a failure here never blocks Current Stock
 * (Part 34). */
export async function getInventoryItemOverviewExtrasAction(inventoryItemId: string, locationId: string): Promise<GetInventoryItemOverviewExtrasResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const [lastReceived, usageTotals] = await Promise.all([
    getInventoryItemLastReceived(supabase, auth.manager.organizationId, inventoryItemId, locationId),
    getInventoryItemUsageTotals(supabase, auth.manager.organizationId, inventoryItemId, locationId),
  ]);
  return { ok: true, extras: { lastReceived, usageTotals } };
}

export interface InventoryItemUsageData {
  byStation: InventoryItemUsageByStation;
  trend: RawUsageTrendPoint[];
}

export type GetInventoryItemUsageResult =
  | { ok: true; usage: InventoryItemUsageData }
  | AuthFailure
  | { ok: false; reason: "invalid_range"; message: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export async function getInventoryItemUsageAction(
  inventoryItemId: string,
  locationId: string,
  period: UsagePeriod,
  customRange?: CustomUsageRange | null
): Promise<GetInventoryItemUsageResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (period === "CUSTOM") {
    if (!customRange || !DATE_ONLY.test(customRange.start) || !DATE_ONLY.test(customRange.end)) {
      return { ok: false, reason: "invalid_range", message: "Choose a start and end date." };
    }
    if (customRange.start > customRange.end) {
      return { ok: false, reason: "invalid_range", message: "The start date must be on or before the end date." };
    }
  }

  const supabase = getServiceRoleClient();
  const [byStation, trend] = await Promise.all([
    getInventoryItemUsageByStation(supabase, auth.manager.organizationId, inventoryItemId, locationId, period, customRange),
    period === "TODAY" ? Promise.resolve([]) : getInventoryItemUsageTrend(supabase, auth.manager.organizationId, inventoryItemId, locationId, period, customRange),
  ]);
  return { ok: true, usage: { byStation, trend } };
}
