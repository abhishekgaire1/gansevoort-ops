import type { UsagePeriod } from "@/app/lib/inventory/usagePeriods";

/**
 * Pure, framework-agnostic helpers for the Item Usage tab (Inventory Item
 * Detail Overview + Usage milestone) -- date-bucket generation/zero-
 * filling and display formatting, kept separate from the rendering
 * component and independently unit-tested (same convention as
 * activityPresentation.ts).
 */

export const USAGE_PERIOD_LABEL: Record<UsagePeriod, string> = {
  TODAY: "Today",
  SEVEN_DAYS: "7 Days",
  THIRTY_DAYS: "30 Days",
  CUSTOM: "Custom",
};

/** "Today"'s calendar date, as YYYY-MM-DD, in the given IANA timezone --
 * pure calendar arithmetic from here on, never real timezone-aware
 * instants, which is what makes the rest of this file simple and
 * correct without a date library. */
export function todayDateStringInTimezone(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function addDaysToDateString(dateString: string, deltaDays: number): string {
  const [y, m, d] = dateString.split("-").map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  utcDate.setUTCDate(utcDate.getUTCDate() + deltaDays);
  return utcDate.toISOString().slice(0, 10);
}

/** The consecutive calendar dates from `startDateString` to
 * `endDateString`, both inclusive, oldest first. The general primitive
 * every period's date sequence (fixed or Custom) is built from. Returns
 * an empty array if end precedes start (an invalid/incomplete Custom
 * selection), never a negative-length or reversed sequence. */
export function dateSequenceBetween(startDateString: string, endDateString: string): string[] {
  const days = daysBetweenInclusive(startDateString, endDateString);
  if (days <= 0) return [];
  return Array.from({ length: days }, (_, i) => addDaysToDateString(startDateString, i));
}

/** Inclusive day count between two YYYY-MM-DD dates (1 when they're the
 * same day). Used both to build date sequences and to decide whether a
 * Custom range is short enough for a per-day trend chart to stay
 * readable (Part 19 -- "keep it simple," never hundreds of tiny bars). */
export function daysBetweenInclusive(startDateString: string, endDateString: string): number {
  const [sy, sm, sd] = startDateString.split("-").map(Number);
  const [ey, em, ed] = endDateString.split("-").map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  return Math.round((end - start) / 86_400_000) + 1;
}

/** The consecutive calendar dates covering a FIXED usage period, oldest
 * first, ending at `endDateString` inclusive -- matches the SAME window
 * the get_inventory_item_usage_trend RPC computes server-side (Part 14:
 * "Use clear date boundaries consistent with the app's current timezone
 * behavior"). TODAY has no trend (Part 19); CUSTOM uses
 * dateSequenceBetween directly with its own explicit start/end instead
 * of this function (it has no fixed length to derive from an end date
 * alone). */
export function usagePeriodDateSequence(period: "TODAY" | "SEVEN_DAYS" | "THIRTY_DAYS", endDateString: string): string[] {
  const days = period === "SEVEN_DAYS" ? 7 : period === "THIRTY_DAYS" ? 30 : 0;
  if (days === 0) return [];
  return dateSequenceBetween(addDaysToDateString(endDateString, -(days - 1)), endDateString);
}

export interface UsageTrendPoint {
  date: string;
  quantity: number;
}

/** Fills in zero-quantity days the (sparse -- GROUP BY only emits rows
 * with real activity) RPC result omits, so the trend is a continuous,
 * gap-free series matching `dateSequence`. */
export function zeroFillUsageTrend(sparse: UsageTrendPoint[], dateSequence: string[]): UsageTrendPoint[] {
  const byDate = new Map(sparse.map((p) => [p.date, p.quantity]));
  return dateSequence.map((date) => ({ date, quantity: byDate.get(date) ?? 0 }));
}

/** "Mon"/"Tue" for a 7-day trend (Part 19's own example), a short
 * month/day for 30-day/Custom (avoids ambiguous repeated weekday labels
 * across a longer span). */
export function formatTrendPointLabel(dateString: string, period: "SEVEN_DAYS" | "THIRTY_DAYS" | "CUSTOM"): string {
  const [y, m, d] = dateString.split("-").map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  if (period === "SEVEN_DAYS") {
    return utcDate.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
  }
  return utcDate.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** $ formatting for the narrowly-scoped cost figures this milestone
 * allows (Last Purchase Cost only -- see itemOverview.ts's own
 * comment for why nothing broader is computed here). */
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
}
