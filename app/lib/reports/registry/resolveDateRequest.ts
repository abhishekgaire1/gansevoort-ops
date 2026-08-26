import "server-only";
import {
  todayDateRange,
  yesterdayDateRange,
  rollingDaysRange,
  currentWeekDateRange,
  previousWeekDateRange,
  currentMonthDateRange,
  previousMonthDateRange,
  calendarMonthDateRange,
  customDateRange,
  type RollingDateRange,
} from "@/app/lib/dateRanges/rollingPeriods";
import type { DateRequest, DateRequestKind, ResolvedDateRange } from "@/app/lib/reports/registry/types";

/**
 * General Report Builder -- the ONE place a DateRequest (Section 8) is
 * turned into concrete calendar dates. The model only ever supplies the
 * request's KIND plus the couple of literal values a manager actually
 * named (a day count, a month/year, or two explicit dates it was told);
 * every actual date boundary is computed here, server-side, by reusing
 * the existing rollingPeriods.ts helpers -- never by the model doing its
 * own date arithmetic.
 */

export type DateResolutionFailureReason = "unsupported_date_kind" | "missing_argument" | "invalid_date" | "reversed_range" | "range_too_large" | "future_month";

export type DateResolutionResult = { ok: true; range: ResolvedDateRange } | { ok: false; reason: DateResolutionFailureReason; message: string };

function inclusiveDaySpan(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

export function resolveDateRequest(
  request: DateRequest,
  now: Date,
  timeZone: string,
  options: { isPointInTime: boolean; maxRangeDays: number | null; supportedDateKinds: readonly DateRequestKind[] }
): DateResolutionResult {
  if (options.isPointInTime) {
    if (request.kind !== "point_in_time") {
      return { ok: false, reason: "unsupported_date_kind", message: "This report is a current, point-in-time snapshot -- it does not accept a date range." };
    }
    return { ok: true, range: { startDate: "", endDate: "", isPointInTime: true } };
  }

  if (request.kind === "point_in_time") {
    return { ok: false, reason: "unsupported_date_kind", message: "This report requires a date range; it is not a point-in-time report." };
  }
  if (!options.supportedDateKinds.includes(request.kind)) {
    return { ok: false, reason: "unsupported_date_kind", message: `This report does not support the "${request.kind}" date request.` };
  }

  let range: RollingDateRange;
  switch (request.kind) {
    case "today":
      range = todayDateRange(now, timeZone);
      break;
    case "yesterday":
      range = yesterdayDateRange(now, timeZone);
      break;
    case "last_n_days": {
      if (typeof request.days !== "number" || !Number.isInteger(request.days) || request.days < 1) {
        return { ok: false, reason: "missing_argument", message: "last_n_days requires a positive integer 'days' value." };
      }
      range = rollingDaysRange(now, timeZone, request.days);
      break;
    }
    case "current_week":
      range = currentWeekDateRange(now, timeZone);
      break;
    case "previous_week":
      range = previousWeekDateRange(now, timeZone);
      break;
    case "current_month":
      range = currentMonthDateRange(now, timeZone);
      break;
    case "previous_month":
      range = previousMonthDateRange(now, timeZone);
      break;
    case "calendar_month": {
      if (typeof request.month !== "number" || typeof request.year !== "number") {
        return { ok: false, reason: "missing_argument", message: "calendar_month requires both 'month' and 'year'." };
      }
      const result = calendarMonthDateRange(now, timeZone, request.year, request.month);
      if (result === "INVALID_MONTH") return { ok: false, reason: "invalid_date", message: "The requested month is invalid." };
      if (result === "FUTURE_MONTH") return { ok: false, reason: "future_month", message: "The requested month hasn't started yet, so there is no data for it." };
      range = result;
      break;
    }
    case "custom_range": {
      if (!request.startDate || !request.endDate) {
        return { ok: false, reason: "missing_argument", message: "custom_range requires both 'startDate' and 'endDate'." };
      }
      const result = customDateRange(request.startDate, request.endDate);
      if (result === "INVALID_DATE") return { ok: false, reason: "invalid_date", message: "The requested date range is invalid." };
      if (result === "START_AFTER_END") return { ok: false, reason: "reversed_range", message: "The start date must be on or before the end date." };
      range = result;
      break;
    }
    default: {
      const exhaustiveCheck: never = request.kind;
      return { ok: false, reason: "unsupported_date_kind", message: `Unrecognized date request kind: ${exhaustiveCheck as string}` };
    }
  }

  if (options.maxRangeDays !== null && inclusiveDaySpan(range.startDate, range.endDate) > options.maxRangeDays) {
    return { ok: false, reason: "range_too_large", message: `This report supports a maximum range of ${options.maxRangeDays} days.` };
  }

  return { ok: true, range: { startDate: range.startDate, endDate: range.endDate, isPointInTime: false } };
}
