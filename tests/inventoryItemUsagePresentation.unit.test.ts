import { describe, expect, it } from "vitest";
import {
  todayDateStringInTimezone,
  usagePeriodDateSequence,
  dateSequenceBetween,
  daysBetweenInclusive,
  zeroFillUsageTrend,
  formatTrendPointLabel,
  formatCurrency,
  USAGE_PERIOD_LABEL,
} from "@/app/manager/(app)/inventory/_lib/usagePresentation";

describe("todayDateStringInTimezone", () => {
  it("returns YYYY-MM-DD for a known instant/timezone pair", () => {
    // 2026-08-19T02:30:00Z is still 2026-08-18T22:30 in America/New_York (UTC-4 in August).
    const instant = new Date("2026-08-19T02:30:00.000Z");
    expect(todayDateStringInTimezone(instant, "America/New_York")).toBe("2026-08-18");
    expect(todayDateStringInTimezone(instant, "UTC")).toBe("2026-08-19");
  });
});

describe("usagePeriodDateSequence", () => {
  it("returns 7 consecutive dates ending at the given date, oldest first", () => {
    const seq = usagePeriodDateSequence("SEVEN_DAYS", "2026-08-19");
    expect(seq).toEqual(["2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19"]);
  });

  it("returns 30 consecutive dates for THIRTY_DAYS", () => {
    const seq = usagePeriodDateSequence("THIRTY_DAYS", "2026-08-19");
    expect(seq).toHaveLength(30);
    expect(seq[0]).toBe("2026-07-21");
    expect(seq[29]).toBe("2026-08-19");
  });

  it("returns an empty sequence for TODAY (no trend for Today, Part 19)", () => {
    expect(usagePeriodDateSequence("TODAY", "2026-08-19")).toEqual([]);
  });

  it("correctly spans a month boundary", () => {
    const seq = usagePeriodDateSequence("SEVEN_DAYS", "2026-09-02");
    expect(seq).toEqual(["2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  });
});

describe("dateSequenceBetween", () => {
  it("returns every date from start to end inclusive", () => {
    expect(dateSequenceBetween("2026-08-17", "2026-08-19")).toEqual(["2026-08-17", "2026-08-18", "2026-08-19"]);
  });

  it("returns a single date when start equals end", () => {
    expect(dateSequenceBetween("2026-08-17", "2026-08-17")).toEqual(["2026-08-17"]);
  });

  it("returns an empty sequence when end precedes start, never a reversed/negative-length one", () => {
    expect(dateSequenceBetween("2026-08-19", "2026-08-17")).toEqual([]);
  });

  it("spans a month boundary correctly", () => {
    expect(dateSequenceBetween("2026-08-30", "2026-09-02")).toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  });
});

describe("daysBetweenInclusive", () => {
  it("is 1 for the same day", () => {
    expect(daysBetweenInclusive("2026-08-17", "2026-08-17")).toBe(1);
  });

  it("counts inclusively across a range", () => {
    expect(daysBetweenInclusive("2026-08-17", "2026-08-19")).toBe(3);
  });

  it("is negative/non-positive when end precedes start (an invalid Custom selection)", () => {
    expect(daysBetweenInclusive("2026-08-19", "2026-08-17")).toBeLessThanOrEqual(0);
  });
});

describe("zeroFillUsageTrend", () => {
  it("fills missing dates with zero, preserving the requested date order", () => {
    const filled = zeroFillUsageTrend(
      [
        { date: "2026-08-17", quantity: 5 },
        { date: "2026-08-19", quantity: 3 },
      ],
      ["2026-08-17", "2026-08-18", "2026-08-19"]
    );
    expect(filled).toEqual([
      { date: "2026-08-17", quantity: 5 },
      { date: "2026-08-18", quantity: 0 },
      { date: "2026-08-19", quantity: 3 },
    ]);
  });

  it("returns all zeros for genuinely zero usage, never an empty/missing series", () => {
    const filled = zeroFillUsageTrend([], ["2026-08-18", "2026-08-19"]);
    expect(filled).toEqual([
      { date: "2026-08-18", quantity: 0 },
      { date: "2026-08-19", quantity: 0 },
    ]);
  });
});

describe("formatTrendPointLabel", () => {
  it("uses a short weekday for 7-day trend points", () => {
    // 2026-08-17 is a Monday.
    expect(formatTrendPointLabel("2026-08-17", "SEVEN_DAYS")).toMatch(/Mon/);
  });

  it("uses a short month/day for 30-day trend points", () => {
    expect(formatTrendPointLabel("2026-08-17", "THIRTY_DAYS")).toMatch(/Aug/);
  });

  it("uses a short month/day for Custom trend points too", () => {
    expect(formatTrendPointLabel("2026-08-17", "CUSTOM")).toMatch(/Aug/);
  });
});

describe("formatCurrency", () => {
  it("formats a dollar amount with two decimals", () => {
    expect(formatCurrency(4.18)).toBe("$4.18");
    expect(formatCurrency(5)).toBe("$5.00");
  });
});

describe("USAGE_PERIOD_LABEL", () => {
  it("has a human label for every period", () => {
    expect(USAGE_PERIOD_LABEL.TODAY).toBe("Today");
    expect(USAGE_PERIOD_LABEL.SEVEN_DAYS).toBe("7 Days");
    expect(USAGE_PERIOD_LABEL.THIRTY_DAYS).toBe("30 Days");
    expect(USAGE_PERIOD_LABEL.CUSTOM).toBe("Custom");
  });
});
