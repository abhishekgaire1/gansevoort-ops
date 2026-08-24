import { todayDateRange, rollingDaysRange, customDateRange, type RollingDateRange } from "@/app/lib/dateRanges/rollingPeriods";

/**
 * V1 Reports foundation -- the ONE shared period selector every report
 * page uses (Section 26/56 "shared date/filter patterns"). Deliberately
 * built on rollingPeriods.ts (Today/7 Days/30 Days rolling windows ending
 * today, plain YYYY-MM-DD strings) since every report filters on
 * purchase_documents.document_date / a similar plain `date` column, not a
 * timestamptz -- the same reasoning already established for Expense
 * Category reporting.
 */

export type ReportPeriodKey = "TODAY" | "7D" | "30D" | "CUSTOM";

export const REPORT_PERIOD_OPTIONS: { key: ReportPeriodKey; label: string }[] = [
  { key: "TODAY", label: "Today" },
  { key: "7D", label: "7 Days" },
  { key: "30D", label: "30 Days" },
  { key: "CUSTOM", label: "Custom" },
];

export interface ResolvedReportPeriod extends RollingDateRange {
  key: ReportPeriodKey;
  /** True only when a CUSTOM period was requested but the supplied dates
   * were invalid/reversed -- callers show a truthful inline notice and
   * fall back to Today rather than silently rendering a wrong range. */
  customError: "INVALID_DATE" | "START_AFTER_END" | null;
}

export function resolveReportPeriod(now: Date, timeZone: string, periodKey: string | undefined, customFrom: string | undefined, customTo: string | undefined): ResolvedReportPeriod {
  if (periodKey === "7D") return { key: "7D", ...rollingDaysRange(now, timeZone, 7), customError: null };
  if (periodKey === "30D") return { key: "30D", ...rollingDaysRange(now, timeZone, 30), customError: null };
  if (periodKey === "CUSTOM" && customFrom && customTo) {
    const result = customDateRange(customFrom, customTo);
    if (typeof result === "string") {
      return { key: "CUSTOM", ...todayDateRange(now, timeZone), customError: result };
    }
    return { key: "CUSTOM", ...result, customError: null };
  }
  return { key: "TODAY", ...todayDateRange(now, timeZone), customError: null };
}
