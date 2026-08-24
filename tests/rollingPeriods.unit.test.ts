import { describe, expect, it } from "vitest";
import { todayDateRange, rollingDaysRange, customDateRange } from "@/app/lib/dateRanges/rollingPeriods";

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
