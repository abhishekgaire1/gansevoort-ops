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

/** ISO weekday (1=Monday..7=Sunday) of a plain "YYYY-MM-DD" string --
 * day-of-week is a property of the calendar date alone, so no timezone
 * is needed here (only computing "today"'s date string needs one). */
function isoWeekdayOfDateString(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun..6=Sat
  return jsDay === 0 ? 7 : jsDay;
}

/** General Report Builder milestone -- additional relative-date requests
 * (Section 8's DateRequest union) beyond the original Today/7D/30D/Custom
 * set above. Same date-STRING convention (not UTC instants) so every
 * existing report loader (which all take plain dateFrom/dateTo strings)
 * can consume these directly with no new conversion step. */

export function yesterdayDateRange(now: Date, timeZone: string): RollingDateRange {
  const yesterday = addDaysToDateString(todayDateStringInTimezone(now, timeZone), -1);
  return { startDate: yesterday, endDate: yesterday };
}

/** Monday of the current ISO week through today (week-to-date) -- a
 * report can never show data for days later this week that haven't
 * happened yet. */
export function currentWeekDateRange(now: Date, timeZone: string): RollingDateRange {
  const today = todayDateStringInTimezone(now, timeZone);
  const monday = addDaysToDateString(today, -(isoWeekdayOfDateString(today) - 1));
  return { startDate: monday, endDate: today };
}

/** The full prior ISO week (Monday through Sunday). */
export function previousWeekDateRange(now: Date, timeZone: string): RollingDateRange {
  const today = todayDateStringInTimezone(now, timeZone);
  const thisMonday = addDaysToDateString(today, -(isoWeekdayOfDateString(today) - 1));
  return { startDate: addDaysToDateString(thisMonday, -7), endDate: addDaysToDateString(thisMonday, -1) };
}

/** The 1st of the current calendar month through today (month-to-date). */
export function currentMonthDateRange(now: Date, timeZone: string): RollingDateRange {
  const today = todayDateStringInTimezone(now, timeZone);
  const [year, month] = today.split("-");
  return { startDate: `${year}-${month}-01`, endDate: today };
}

/** The full prior calendar month (1st through its last day). */
export function previousMonthDateRange(now: Date, timeZone: string): RollingDateRange {
  const today = todayDateStringInTimezone(now, timeZone);
  const [year, month] = today.split("-").map(Number);
  const lastDayOfPrevMonth = addDaysToDateString(`${year}-${String(month).padStart(2, "0")}-01`, -1);
  const [prevYear, prevMonth] = lastDayOfPrevMonth.split("-");
  return { startDate: `${prevYear}-${prevMonth}-01`, endDate: lastDayOfPrevMonth };
}

export type CalendarMonthDateRangeError = "INVALID_MONTH" | "FUTURE_MONTH";

/** A NAMED calendar month (e.g. "August 2026"), in full -- 1st through
 * its last day, capped at today if the named month is the current month
 * (never claims data for days that haven't happened yet). A month that
 * hasn't started at all is rejected as FUTURE_MONTH rather than silently
 * returning an empty/nonsensical range. */
export function calendarMonthDateRange(now: Date, timeZone: string, year: number, month: number): RollingDateRange | CalendarMonthDateRangeError {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) return "INVALID_MONTH";
  const firstOfMonth = `${year}-${String(month).padStart(2, "0")}-01`;
  const today = todayDateStringInTimezone(now, timeZone);
  if (firstOfMonth > today) return "FUTURE_MONTH";
  const nextMonthFirst = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastOfMonth = addDaysToDateString(nextMonthFirst, -1);
  return { startDate: firstOfMonth, endDate: lastOfMonth > today ? today : lastOfMonth };
}
