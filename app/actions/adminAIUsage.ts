"use server";

import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getAIUsageReport, type AIUsageReport } from "@/app/lib/ai/usage";
import { resolveOrganizationTimezone } from "@/app/lib/dateRanges/organizationTimezone";
import { todayRange, thisWeekRange, thisMonthRange, customRange, type DateRange } from "@/app/lib/dateRanges/calendarPeriods";

/**
 * AI Configuration + Usage/Cost Tracking milestone -- Admin-only Server
 * Action backing the Usage & Cost tab. Admin-only visibility (Part 45):
 * gates on requireAdmin(), same as every other action in this milestone --
 * normal Managers/Employees never see AI spend anywhere.
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as an Admin." };

export type AIUsagePeriodKind = "TODAY" | "THIS_WEEK" | "THIS_MONTH" | "CUSTOM";

export type GetAIUsageReportResult =
  | { ok: true; report: AIUsageReport; periodStart: string; periodEnd: string; timezone: string }
  | AuthFailure
  | { ok: false; reason: "invalid_range"; message: string };

export async function getAIUsageReportAction(period: AIUsagePeriodKind, customStartDate?: string, customEndDate?: string): Promise<GetAIUsageReportResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const timezone = await resolveOrganizationTimezone(supabase, auth.manager.organizationId);
  const now = new Date();

  let range: DateRange;
  if (period === "TODAY") {
    range = todayRange(now, timezone);
  } else if (period === "THIS_WEEK") {
    range = thisWeekRange(now, timezone);
  } else if (period === "THIS_MONTH") {
    range = thisMonthRange(now, timezone);
  } else {
    if (!customStartDate || !customEndDate) {
      return { ok: false, reason: "invalid_range", message: "Choose a start and end date." };
    }
    const result = customRange(customStartDate, customEndDate, timezone);
    if (result === "INVALID_DATE") return { ok: false, reason: "invalid_range", message: "Enter valid dates." };
    if (result === "START_AFTER_END") return { ok: false, reason: "invalid_range", message: "The start date must be on or before the end date." };
    range = result;
  }

  const report = await getAIUsageReport(supabase, auth.manager.organizationId, range.start, range.end);
  return { ok: true, report, periodStart: range.start.toISOString(), periodEnd: range.end.toISOString(), timezone };
}
