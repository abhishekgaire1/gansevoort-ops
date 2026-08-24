/**
 * Manager Categories milestone -- Expense Category Today/7 Days/30 Days/
 * Custom periods (deliberately DIFFERENT semantics from
 * calendarPeriods.ts's Today/This Week/This Month): 7 Days and 30 Days
 * are ROLLING windows ending today, not calendar-week/month boundaries.
 * Returns plain "YYYY-MM-DD" calendar-date strings, not UTC instants --
 * expense reporting filters on purchase_documents.document_date (a plain
 * `date` column, not timestamptz), so there is no timezone-instant
 * conversion to do at the boundary itself; the only place a timezone
 * matters is determining what "today" IS in the organization's own zone.
 */

export interface RollingDateRange {
  /** Inclusive, "YYYY-MM-DD". */
  startDate: string;
  /** Inclusive, "YYYY-MM-DD". */
  endDate: string;
}

function todayDateStringInTimezone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function addDaysToDateString(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function todayDateRange(now: Date, timeZone: string): RollingDateRange {
  const today = todayDateStringInTimezone(now, timeZone);
  return { startDate: today, endDate: today };
}

/** days=7 means today and the preceding 6 days (a 7-day-inclusive window),
 * matching the plain-English "7 Days" label -- never an 8th day. */
export function rollingDaysRange(now: Date, timeZone: string, days: number): RollingDateRange {
  const today = todayDateStringInTimezone(now, timeZone);
  return { startDate: addDaysToDateString(today, -(days - 1)), endDate: today };
}

export type CustomDateRangeError = "INVALID_DATE" | "START_AFTER_END";

export function customDateRange(startDateStr: string, endDateStr: string): RollingDateRange | CustomDateRangeError {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(startDateStr.trim()) || !pattern.test(endDateStr.trim())) return "INVALID_DATE";
  if (startDateStr > endDateStr) return "START_AFTER_END";
  return { startDate: startDateStr, endDate: endDateStr };
}
