/**
 * Calendar-aligned Today/This Week/This Month/Custom period boundaries,
 * computed in a given organization's own timezone so grouping is
 * deterministic. Pure date math only, no network/DB access, so it's fully
 * unit-testable and reusable by any caller that needs calendar-aligned
 * (as opposed to rolling, see rollingPeriods.ts) reporting windows --
 * originally built for the AI Usage & Cost milestone, generalized here
 * since nothing about it is AI-specific.
 *
 * No new timezone system: this reuses the SAME convention already
 * established for business_date logic across the app (locations.timezone,
 * an IANA zone -- see app/lib/inventory/itemActivity.ts's own comment).
 * There is no per-organization timezone column, so "the organization's
 * timezone" is resolved elsewhere (organizationTimezone.ts) as its
 * primary location's timezone -- this module only does the calendar math
 * once a timezone string is known.
 *
 * No date library exists in this project and pulling one in isn't
 * warranted -- Intl.DateTimeFormat (built into Node) is sufficient for the
 * offset-lookup trick used below. Week starts Monday (ISO 8601) -- no
 * prior "This Week" convention existed anywhere in this codebase to
 * match, so this is a fresh, explicit choice.
 */

export interface DateRange {
  /** Inclusive start, UTC instant. */
  start: Date;
  /** Exclusive end, UTC instant. */
  end: Date;
}

interface LocalDateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/** The timezone's UTC offset, in minutes, AT the given instant (add this
 * many minutes to a UTC instant to get local wall-clock time). Computed
 * via the standard formatToParts round-trip trick -- accurate for
 * ordinary reporting purposes; like most such helpers, it does not
 * specially handle the rare case where a period boundary falls exactly
 * within a DST transition's skipped/repeated hour. */
function offsetMinutesAt(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});

  const asIfUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return (asIfUTC - date.getTime()) / 60000;
}

function localDatePartsAt(date: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** The UTC instant corresponding to local midnight (00:00:00) on the
 * given calendar date, in the given timezone. */
function startOfLocalDate(parts: LocalDateParts, timeZone: string): Date {
  // Two-pass: the offset can differ by up to ~an hour depending on which
  // instant we sample it at near a DST boundary. Sampling at the naive
  // midnight-as-UTC guess and re-deriving is accurate for every ordinary
  // (non-transition-day) case and self-corrects for most transition days.
  const naiveGuess = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const offset = offsetMinutesAt(new Date(naiveGuess), timeZone);
  return new Date(naiveGuess - offset * 60000);
}

function addDays(parts: LocalDateParts, days: number): LocalDateParts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** ISO weekday: 1=Monday .. 7=Sunday, computed from calendar date alone
 * (day-of-week is a property of the calendar date, not of a timezone). */
function isoWeekday(parts: LocalDateParts): number {
  const jsDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(); // 0=Sun..6=Sat
  return jsDay === 0 ? 7 : jsDay;
}

export function todayRange(now: Date, timeZone: string): DateRange {
  const today = localDatePartsAt(now, timeZone);
  const start = startOfLocalDate(today, timeZone);
  const end = startOfLocalDate(addDays(today, 1), timeZone);
  return { start, end };
}

export function thisWeekRange(now: Date, timeZone: string): DateRange {
  const today = localDatePartsAt(now, timeZone);
  const monday = addDays(today, -(isoWeekday(today) - 1));
  const start = startOfLocalDate(monday, timeZone);
  const end = startOfLocalDate(addDays(monday, 7), timeZone);
  return { start, end };
}

export function thisMonthRange(now: Date, timeZone: string): DateRange {
  const today = localDatePartsAt(now, timeZone);
  const firstOfMonth: LocalDateParts = { year: today.year, month: today.month, day: 1 };
  const nextMonth: LocalDateParts = today.month === 12 ? { year: today.year + 1, month: 1, day: 1 } : { year: today.year, month: today.month + 1, day: 1 };
  return { start: startOfLocalDate(firstOfMonth, timeZone), end: startOfLocalDate(nextMonth, timeZone) };
}

export type CustomRangeError = "INVALID_DATE" | "START_AFTER_END";

/** startDateStr/endDateStr: "YYYY-MM-DD", both inclusive from the caller's
 * perspective (Part 35's "Aug 1, 2026 -> Aug 20, 2026" example) -- the
 * returned range's `end` is the exclusive UTC instant just after the end
 * date's local midnight, so a request landing anywhere on Aug 20 local
 * time is included. */
export function customRange(startDateStr: string, endDateStr: string, timeZone: string): DateRange | CustomRangeError {
  const startParts = parseDateStr(startDateStr);
  const endParts = parseDateStr(endDateStr);
  if (!startParts || !endParts) return "INVALID_DATE";

  const start = startOfLocalDate(startParts, timeZone);
  const end = startOfLocalDate(addDays(endParts, 1), timeZone);
  if (start >= end) return "START_AFTER_END";
  return { start, end };
}

function parseDateStr(value: string): LocalDateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}
