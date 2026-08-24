"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import {
  listManagerInventoryCategories,
  getManagerInventoryCategory,
  listManagerInventoryCategoryItems,
  type ManagerInventoryCategorySummary,
  type ManagerInventoryCategoryDetail,
  type ManagerInventoryCategoryItem,
} from "@/app/lib/categories/managerInventoryCategories";
import {
  listManagerExpenseCategories,
  getManagerExpenseCategory,
  getManagerExpenseCategorySummary,
  listManagerExpenseCategoryLines,
  type ManagerExpenseCategorySummary,
  type ManagerExpenseCategoryDetail,
  type ManagerExpenseCategorySummaryDetail,
  type ManagerExpenseCategoryLine,
} from "@/app/lib/categories/managerExpenseCategories";
import { resolveOrganizationTimezone } from "@/app/lib/dateRanges/organizationTimezone";
import { thisMonthRange } from "@/app/lib/dateRanges/calendarPeriods";
import { todayDateRange, rollingDaysRange, customDateRange, type RollingDateRange } from "@/app/lib/dateRanges/rollingPeriods";

/**
 * Manager Categories milestone -- the READ-ONLY operational drill-down
 * (Part 15-18). Gated on requireManagerOrAdmin() throughout, never
 * requireAdmin() -- Managers can VIEW/explore categories; only Admin ->
 * Categories can configure them (Part 6/47). No mutation of any kind is
 * exposed from this file.
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };

export type ListManagerInventoryCategoriesResult = { ok: true; categories: ManagerInventoryCategorySummary[] } | AuthFailure;

export async function listManagerInventoryCategoriesAction(): Promise<ListManagerInventoryCategoriesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const categories = await listManagerInventoryCategories(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, categories };
}

export type GetManagerInventoryCategoryResult =
  | { ok: true; category: ManagerInventoryCategoryDetail; items: ManagerInventoryCategoryItem[] }
  | AuthFailure
  | { ok: false; reason: "not_found"; message: string };

export async function getManagerInventoryCategoryAction(categoryId: string): Promise<GetManagerInventoryCategoryResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const category = await getManagerInventoryCategory(supabase, auth.manager.organizationId, categoryId);
  if (!category) return { ok: false, reason: "not_found", message: "Category not found." };

  const items = await listManagerInventoryCategoryItems(supabase, auth.manager.organizationId, categoryId);
  return { ok: true, category, items };
}

/** List-page totals always use the CURRENT calendar month (Part 23's own
 * mockup: a static "This Month" label, no period selector on the list
 * itself -- the detail page is where Today/7 Days/30 Days/Custom apply). */
export type ListManagerExpenseCategoriesResult = { ok: true; categories: ManagerExpenseCategorySummary[] } | AuthFailure;

export async function listManagerExpenseCategoriesAction(): Promise<ListManagerExpenseCategoriesResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const timezone = await resolveOrganizationTimezone(supabase, auth.manager.organizationId);
  const { start, end } = thisMonthRange(new Date(), timezone);
  // The expense RPCs filter on document_date (a plain date column) --
  // convert the calendar-month instant range to plain dates in the same
  // timezone.
  const startDate = start.toISOString().slice(0, 10);
  const endDateExclusive = new Date(end.getTime() - 1).toISOString().slice(0, 10);

  const categories = await listManagerExpenseCategories(supabase, auth.manager.organizationId, startDate, endDateExclusive);
  return { ok: true, categories };
}

export type ManagerExpensePeriodKind = "TODAY" | "SEVEN_DAYS" | "THIRTY_DAYS" | "CUSTOM";

export type GetManagerExpenseCategoryResult =
  | {
      ok: true;
      category: ManagerExpenseCategoryDetail;
      summary: ManagerExpenseCategorySummaryDetail;
      lines: ManagerExpenseCategoryLine[];
      periodStart: string;
      periodEnd: string;
    }
  | AuthFailure
  | { ok: false; reason: "not_found" | "invalid_range"; message: string };

export async function getManagerExpenseCategoryAction(
  categoryId: string,
  period: ManagerExpensePeriodKind,
  customStartDate?: string,
  customEndDate?: string,
  offset = 0
): Promise<GetManagerExpenseCategoryResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const category = await getManagerExpenseCategory(supabase, auth.manager.organizationId, categoryId);
  if (!category) return { ok: false, reason: "not_found", message: "Category not found." };

  const timezone = await resolveOrganizationTimezone(supabase, auth.manager.organizationId);
  const now = new Date();

  let range: RollingDateRange;
  if (period === "TODAY") {
    range = todayDateRange(now, timezone);
  } else if (period === "SEVEN_DAYS") {
    range = rollingDaysRange(now, timezone, 7);
  } else if (period === "THIRTY_DAYS") {
    range = rollingDaysRange(now, timezone, 30);
  } else {
    if (!customStartDate || !customEndDate) {
      return { ok: false, reason: "invalid_range", message: "Choose a start and end date." };
    }
    const result = customDateRange(customStartDate, customEndDate);
    if (result === "INVALID_DATE") return { ok: false, reason: "invalid_range", message: "Enter valid dates." };
    if (result === "START_AFTER_END") return { ok: false, reason: "invalid_range", message: "The start date must be on or before the end date." };
    range = result;
  }

  const [summary, lines] = await Promise.all([
    getManagerExpenseCategorySummary(supabase, auth.manager.organizationId, categoryId, range.startDate, range.endDate),
    listManagerExpenseCategoryLines(supabase, auth.manager.organizationId, categoryId, range.startDate, range.endDate, 25, offset),
  ]);

  return { ok: true, category, summary, lines, periodStart: range.startDate, periodEnd: range.endDate };
}
