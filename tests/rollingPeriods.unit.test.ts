import { describe, expect, it } from "vitest";
import {
  todayDateRange,
  rollingDaysRange,
  customDateRange,
  yesterdayDateRange,
  currentWeekDateRange,
  previousWeekDateRange,
  currentMonthDateRange,
  previousMonthDateRange,
  calendarMonthDateRange,
} from "@/app/lib/dateRanges/rollingPeriods";

// CI-safe: pure date math, no network/DB. Proves the Manager Expense
// Category milestone's Today/7 Days/30 Days/Custom periods are ROLLING
// windows (deliberately different from calendarPeriods.ts's calendar
// Today/This Week/This Month -- Part 28).

const NY = "America/New_York";

describe("todayDateRange", () => {
  it("returns the same calendar date for both start and end, in the given timezone", () => {
    const now = new Date("2026-08-20T14:00:00Z"); // 10:00 EDT
    expect(todayDateRange(now, NY)).toEqual({ startDate: "2026-08-20", endDate: "2026-08-20" });
  });

  it("a timezone can disagree with UTC about which calendar day it is", () => {
    const now = new Date("2026-08-20T02:00:00Z"); // 2026-08-19T22:00 EDT -- still the 19th
    expect(todayDateRange(now, NY)).toEqual({ startDate: "2026-08-19", endDate: "2026-08-19" });
  });
});

describe("rollingDaysRange", () => {
  it("7 days is today AND the preceding 6 days -- 7 total, never 8", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    const { startDate, endDate } = rollingDaysRange(now, NY, 7);
    expect(endDate).toBe("2026-08-20");
    expect(startDate).toBe("2026-08-14");
  });

  it("30 days is today and the preceding 29 days", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    const { startDate, endDate } = rollingDaysRange(now, NY, 30);
    expect(endDate).toBe("2026-08-20");
    expect(startDate).toBe("2026-07-22");
  });

  it("rolls across a month boundary correctly", () => {
    const now = new Date("2026-03-03T14:00:00Z"); // Mar 3 EST
    const { startDate } = rollingDaysRange(now, NY, 7);
    expect(startDate).toBe("2026-02-25");
  });
});

describe("customDateRange", () => {
  it("accepts a valid inclusive range", () => {
    expect(customDateRange("2026-08-01", "2026-08-20")).toEqual({ startDate: "2026-08-01", endDate: "2026-08-20" });
  });

  it("accepts a single-day range", () => {
    expect(customDateRange("2026-08-01", "2026-08-01")).toEqual({ startDate: "2026-08-01", endDate: "2026-08-01" });
  });

  it("rejects start after end", () => {
    expect(customDateRange("2026-08-20", "2026-08-01")).toBe("START_AFTER_END");
  });

  it("rejects malformed dates", () => {
    expect(customDateRange("not-a-date", "2026-08-01")).toBe("INVALID_DATE");
    expect(customDateRange("2026-08-01", "08/01/2026")).toBe("INVALID_DATE");
  });
});

describe("yesterdayDateRange", () => {
  it("is exactly one calendar day before today, in the given timezone", () => {
    const now = new Date("2026-08-20T14:00:00Z"); // Aug 20 in NY
    expect(yesterdayDateRange(now, NY)).toEqual({ startDate: "2026-08-19", endDate: "2026-08-19" });
  });
});

describe("currentWeekDateRange / previousWeekDateRange (General Report Builder)", () => {
  // 2026-08-20 is a Thursday; its ISO week starts Monday 2026-08-17.
  it("current week is Monday through today (week-to-date)", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    expect(currentWeekDateRange(now, NY)).toEqual({ startDate: "2026-08-17", endDate: "2026-08-20" });
  });

  it("previous week is the full prior Monday-through-Sunday", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    expect(previousWeekDateRange(now, NY)).toEqual({ startDate: "2026-08-10", endDate: "2026-08-16" });
  });
});

describe("currentMonthDateRange / previousMonthDateRange (General Report Builder)", () => {
  it("current month is the 1st through today (month-to-date)", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    expect(currentMonthDateRange(now, NY)).toEqual({ startDate: "2026-08-01", endDate: "2026-08-20" });
  });

  it("previous month is the full prior calendar month", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    expect(previousMonthDateRange(now, NY)).toEqual({ startDate: "2026-07-01", endDate: "2026-07-31" });
  });

  it("previous month rolls across a year boundary correctly", () => {
    const now = new Date("2026-01-15T14:00:00Z");
    expect(previousMonthDateRange(now, NY)).toEqual({ startDate: "2025-12-01", endDate: "2025-12-31" });
  });
});

describe("calendarMonthDateRange (General Report Builder -- named month/year)", () => {
  it("returns the full named month, leap day included, for a past leap February", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    expect(calendarMonthDateRange(now, NY, 2024, 2)).toEqual({ startDate: "2024-02-01", endDate: "2024-02-29" });
  });

  it("rolls across a year boundary for a named December", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    expect(calendarMonthDateRange(now, NY, 2025, 12)).toEqual({ startDate: "2025-12-01", endDate: "2025-12-31" });
  });

  it("caps the end date at today when the named month IS the current month -- never claims future days", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    expect(calendarMonthDateRange(now, NY, 2026, 8)).toEqual({ startDate: "2026-08-01", endDate: "2026-08-20" });
  });

  it("rejects a month that has not started yet", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    expect(calendarMonthDateRange(now, NY, 2026, 12)).toBe("FUTURE_MONTH");
  });

  it("rejects an invalid month number", () => {
    const now = new Date("2026-08-20T14:00:00Z");
    expect(calendarMonthDateRange(now, NY, 2026, 13)).toBe("INVALID_MONTH");
    expect(calendarMonthDateRange(now, NY, 2026, 0)).toBe("INVALID_MONTH");
  });
});
