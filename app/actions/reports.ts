"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import {
  getPurchasingReport,
  getPurchasingReportPriceChanges,
  type PurchasingReportFilters,
  type PurchasingReportSummary,
  type PurchasingPriceChanges,
} from "@/app/lib/reports/purchasingReport";
import { getUsageReport, type UsageReport, type UsageReportFilters } from "@/app/lib/reports/usageReport";
import { getWasteReport, type WasteReport, type WasteReportFilters } from "@/app/lib/reports/wasteReport";
import { getReceivingReport, type ReceivingReport } from "@/app/lib/reports/receivingReport";
import { getInventoryStatusReport, type InventoryStatusReport, type InventoryStatusFilters } from "@/app/lib/reports/inventoryStatusReport";
import { resolveOrganizationTimezone } from "@/app/lib/dateRanges/organizationTimezone";

/**
 * V1 Reports foundation -- every report action is Manager/Admin-only
 * (Section 38: no AP/accounting roles in V1, employee/kiosk never sees
 * Reports), server-scoped to the caller's own organization via
 * requireManagerOrAdmin()'s resolved organizationId, exactly the same
 * pattern as every other manager-facing action in this codebase.
 *
 * Bug fix (Reports closeout, live audit): every lib function throws on an
 * RPC failure (`if (error) throw new Error(...)`), but this file
 * previously had no try/catch anywhere -- a real RPC failure propagated
 * as an UNHANDLED server exception (Next.js's generic crash page), never
 * reaching each report page's own "Could not load the X report"
 * EmptyState, which can only render when the action returns `ok: false`.
 * The friendly error UI was dead code. Every action below now catches
 * the real error, logs full detail server-side, and returns a generic
 * LOAD_FAILED result -- the exact same "manager sees calm message,
 * developer log retains detail" boundary already used throughout this
 * codebase (e.g. item-matching's LOAD_FAILED-shaped results).
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

type LoadFailure = { ok: false; reason: "load_failed"; message: string };

// ============================================================
// TEMPORARY diagnostic instrumentation (Reports rapid-navigation
// investigation) -- pure logging, zero control-flow change. Pairs with
// the correlation-id/stage logging in requireManagerOrAdmin()
// (app/lib/auth/managerAuth.ts). Fields per Section 13's own request:
// correlation id, report name, organization id, date range, filters,
// stage, duration, success/failure, error message -- never secrets/PINs/
// tokens/cookies/raw invoice data. Remove once the investigation
// concludes.
// ============================================================
function shortCorrelationId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function logStage(correlationId: string, reportName: string, stage: string, extra: Record<string, unknown>) {
  console.log(`[reports:${correlationId}] report=${reportName} STAGE=${stage}`, extra);
}

function loadFailure(correlationId: string, reportName: string, organizationId: string, err: unknown): LoadFailure {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[reports:${correlationId}] report=${reportName} FAILED organizationId=${organizationId} error=${message}`);
  return { ok: false, reason: "load_failed", message: `Could not load the ${reportName}. Try again.` };
}

export type GetOrganizationTimezoneResult = { ok: true; timeZone: string } | AuthFailure | LoadFailure;

export async function getReportsTimezone(): Promise<GetOrganizationTimezoneResult> {
  const correlationId = shortCorrelationId();
  const authStartedAt = Date.now();
  const auth = await requireManagerOrAdmin();
  logStage(correlationId, "report timezone", "AUTH_CONTEXT", { duration: Date.now() - authStartedAt, ok: auth.ok });
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    const rpcStartedAt = Date.now();
    const timeZone = await resolveOrganizationTimezone(getServiceRoleClient(), auth.manager.organizationId);
    logStage(correlationId, "report timezone", "REPORT_RPC", { duration: Date.now() - rpcStartedAt, success: true });
    return { ok: true, timeZone };
  } catch (err) {
    return loadFailure(correlationId, "report timezone", auth.manager.organizationId, err);
  }
}

export type GetPurchasingReportResult = { ok: true; report: PurchasingReportSummary } | AuthFailure | LoadFailure;

export async function getPurchasingReportAction(dateFrom: string, dateTo: string, filters: PurchasingReportFilters = {}): Promise<GetPurchasingReportResult> {
  const correlationId = shortCorrelationId();
  const authStartedAt = Date.now();
  const auth = await requireManagerOrAdmin();
  logStage(correlationId, "purchasing report", "AUTH_CONTEXT", { duration: Date.now() - authStartedAt, ok: auth.ok, dateFrom, dateTo, filters });
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    const rpcStartedAt = Date.now();
    const report = await getPurchasingReport(getServiceRoleClient(), auth.manager.organizationId, dateFrom, dateTo, filters);
    logStage(correlationId, "purchasing report", "REPORT_RPC", { duration: Date.now() - rpcStartedAt, success: true, organizationId: auth.manager.organizationId });
    return { ok: true, report };
  } catch (err) {
    return loadFailure(correlationId, "purchasing report", auth.manager.organizationId, err);
  }
}

export type GetPurchasingPriceChangesResult = { ok: true; changes: PurchasingPriceChanges } | AuthFailure | LoadFailure;

export async function getPurchasingReportPriceChangesAction(
  dateFrom: string,
  dateTo: string,
  vendorId?: string | null,
  inventoryCategoryId?: string | null
): Promise<GetPurchasingPriceChangesResult> {
  const correlationId = shortCorrelationId();
  const authStartedAt = Date.now();
  const auth = await requireManagerOrAdmin();
  logStage(correlationId, "price changes", "AUTH_CONTEXT", { duration: Date.now() - authStartedAt, ok: auth.ok, dateFrom, dateTo, vendorId, inventoryCategoryId });
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    const rpcStartedAt = Date.now();
    const changes = await getPurchasingReportPriceChanges(getServiceRoleClient(), auth.manager.organizationId, dateFrom, dateTo, vendorId, inventoryCategoryId);
    logStage(correlationId, "price changes", "SECONDARY_RPC", { duration: Date.now() - rpcStartedAt, success: true, organizationId: auth.manager.organizationId });
    return { ok: true, changes };
  } catch (err) {
    return loadFailure(correlationId, "price changes", auth.manager.organizationId, err);
  }
}

export type GetUsageReportResult = { ok: true; report: UsageReport } | AuthFailure | LoadFailure;

export async function getUsageReportAction(dateFrom: string, dateTo: string, filters: UsageReportFilters = {}): Promise<GetUsageReportResult> {
  const correlationId = shortCorrelationId();
  const authStartedAt = Date.now();
  const auth = await requireManagerOrAdmin();
  logStage(correlationId, "usage report", "AUTH_CONTEXT", { duration: Date.now() - authStartedAt, ok: auth.ok, dateFrom, dateTo, filters });
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    const rpcStartedAt = Date.now();
    const report = await getUsageReport(getServiceRoleClient(), auth.manager.organizationId, dateFrom, dateTo, filters);
    logStage(correlationId, "usage report", "REPORT_RPC", { duration: Date.now() - rpcStartedAt, success: true, organizationId: auth.manager.organizationId });
    return { ok: true, report };
  } catch (err) {
    return loadFailure(correlationId, "usage report", auth.manager.organizationId, err);
  }
}

export type GetWasteReportResult = { ok: true; report: WasteReport } | AuthFailure | LoadFailure;

export async function getWasteReportAction(dateFrom: string, dateTo: string, filters: WasteReportFilters = {}): Promise<GetWasteReportResult> {
  const correlationId = shortCorrelationId();
  const authStartedAt = Date.now();
  const auth = await requireManagerOrAdmin();
  logStage(correlationId, "waste report", "AUTH_CONTEXT", { duration: Date.now() - authStartedAt, ok: auth.ok, dateFrom, dateTo, filters });
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    const rpcStartedAt = Date.now();
    const report = await getWasteReport(getServiceRoleClient(), auth.manager.organizationId, dateFrom, dateTo, filters);
    logStage(correlationId, "waste report", "REPORT_RPC", { duration: Date.now() - rpcStartedAt, success: true, organizationId: auth.manager.organizationId });
    return { ok: true, report };
  } catch (err) {
    return loadFailure(correlationId, "waste report", auth.manager.organizationId, err);
  }
}

export type GetReceivingReportResult = { ok: true; report: ReceivingReport } | AuthFailure | LoadFailure;

export async function getReceivingReportAction(dateFrom: string, dateTo: string, vendorId?: string | null): Promise<GetReceivingReportResult> {
  const correlationId = shortCorrelationId();
  const authStartedAt = Date.now();
  const auth = await requireManagerOrAdmin();
  logStage(correlationId, "receiving report", "AUTH_CONTEXT", { duration: Date.now() - authStartedAt, ok: auth.ok, dateFrom, dateTo, vendorId });
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    const rpcStartedAt = Date.now();
    const report = await getReceivingReport(getServiceRoleClient(), auth.manager.organizationId, dateFrom, dateTo, vendorId);
    logStage(correlationId, "receiving report", "REPORT_RPC", { duration: Date.now() - rpcStartedAt, success: true, organizationId: auth.manager.organizationId });
    return { ok: true, report };
  } catch (err) {
    return loadFailure(correlationId, "receiving report", auth.manager.organizationId, err);
  }
}

export type GetInventoryStatusReportResult = { ok: true; report: InventoryStatusReport } | AuthFailure | LoadFailure;

/** Not date-ranged -- current balances are a point-in-time truth, same as
 * Current Inventory itself (Section 33). */
export async function getInventoryStatusReportAction(filters: InventoryStatusFilters = {}): Promise<GetInventoryStatusReportResult> {
  const correlationId = shortCorrelationId();
  const authStartedAt = Date.now();
  const auth = await requireManagerOrAdmin();
  logStage(correlationId, "inventory status report", "AUTH_CONTEXT", { duration: Date.now() - authStartedAt, ok: auth.ok, filters });
  if (!auth.ok) return NOT_AUTHORIZED;
  try {
    const rpcStartedAt = Date.now();
    const report = await getInventoryStatusReport(getServiceRoleClient(), auth.manager.organizationId, filters);
    logStage(correlationId, "inventory status report", "REPORT_RPC", { duration: Date.now() - rpcStartedAt, success: true, organizationId: auth.manager.organizationId });
    return { ok: true, report };
  } catch (err) {
    return loadFailure(correlationId, "inventory status report", auth.manager.organizationId, err);
  }
}
