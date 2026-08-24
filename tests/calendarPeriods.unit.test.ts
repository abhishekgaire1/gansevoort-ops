import { describe, expect, it } from "vitest";
import { todayRange, thisWeekRange, thisMonthRange, customRange } from "@/app/lib/dateRanges/calendarPeriods";

// CI-safe: pure date math, no network/DB. Proves the AI Usage & Cost
// milestone's Today/This Week/This Month/Custom boundaries are computed
// deterministically in a given IANA timezone (Part 31-35), not UTC or
// server-local time.

const NY = "America/New_York"; // UTC-5 (EST) in January
const TOKYO = "Asia/Tokyo"; // UTC+9, no DST

describe("todayRange", () => {
  it("returns local-midnight-to-local-midnight in the given timezone", () => {
    // 2026-01-15T03:00:00Z is 2026-01-14 22:00 in New York (still the 14th).
    const now = new Date("2026-01-15T03:00:00Z");
    const { start, end } = todayRange(now, NY);
    expect(start.toISOString()).toBe("2026-01-14T05:00:00.000Z"); // 2026-01-14T00:00 EST = 05:00Z
    expect(end.toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("a different timezone can disagree about which calendar day 'now' falls on", () => {
    const now = new Date("2026-01-15T03:00:00Z"); // 12:00 in Tokyo on the 15th
    const { start } = todayRange(now, TOKYO);
    expect(start.toISOString()).toBe("2026-01-14T15:00:00.000Z"); // 2026-01-15T00:00 JST = previous day 15:00Z
  });

  it("end is exactly 24 hours after start (no DST in these two zones at this date)", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { start, end } = todayRange(now, NY);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("thisWeekRange", () => {
  it("starts on Monday local time, regardless of which weekday 'now' is", () => {
    // 2026-01-15 is a Thursday.
    const now = new Date("2026-01-15T12:00:00Z");
    const { start, end } = thisWeekRange(now, NY);
    // Monday 2026-01-12, 00:00 EST = 05:00Z.
    expect(start.toISOString()).toBe("2026-01-12T05:00:00.000Z");
    // Following Monday 2026-01-19, 00:00 EST = 05:00Z.
    expect(end.toISOString()).toBe("2026-01-19T05:00:00.000Z");
  });

  it("a Monday itself is the start of its own week (0 days back)", () => {
    const monday = new Date("2026-01-12T15:00:00Z"); // midday Monday in NY
    const { start } = thisWeekRange(monday, NY);
    expect(start.toISOString()).toBe("2026-01-12T05:00:00.000Z");
  });

  it("a Sunday belongs to the PRECEDING Monday's week, not the next one", () => {
    const sunday = new Date("2026-01-18T15:00:00Z"); // midday Sunday in NY
    const { start, end } = thisWeekRange(sunday, NY);
    expect(start.toISOString()).toBe("2026-01-12T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-19T05:00:00.000Z");
  });
});

describe("thisMonthRange", () => {
  it("spans local calendar-month boundaries", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { start, end } = thisMonthRange(now, NY);
    expect(start.toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-02-01T05:00:00.000Z");
  });

  it("rolls over the year at December", () => {
    const now = new Date("2026-12-15T12:00:00Z");
    const { start, end } = thisMonthRange(now, NY);
    expect(start.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });
});

describe("customRange", () => {
  it("is inclusive of both the start and end calendar dates", () => {
    const result = customRange("2026-08-01", "2026-08-20", NY);
    expect(result).not.toBe("INVALID_DATE");
    expect(result).not.toBe("START_AFTER_END");
    const { start, end } = result as { start: Date; end: Date };
    expect(start.toISOString()).toBe("2026-08-01T04:00:00.000Z"); // EDT (UTC-4) in August
    // exclusive end is the day AFTER Aug 20, so anything on Aug 20 local is included
    expect(end.toISOString()).toBe("2026-08-21T04:00:00.000Z");
  });

  it("a single-day range (start === end) is valid", () => {
    const result = customRange("2026-08-01", "2026-08-01", NY);
    expect(result).not.toBe("INVALID_DATE");
    expect(result).not.toBe("START_AFTER_END");
  });

  it("rejects start after end", () => {
    expect(customRange("2026-08-20", "2026-08-01", NY)).toBe("START_AFTER_END");
  });

  it("rejects malformed date strings", () => {
    expect(customRange("not-a-date", "2026-08-01", NY)).toBe("INVALID_DATE");
    expect(customRange("2026-08-01", "08/01/2026", NY)).toBe("INVALID_DATE");
  });
});
