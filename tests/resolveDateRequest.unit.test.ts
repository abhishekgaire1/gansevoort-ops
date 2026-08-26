import { describe, expect, it } from "vitest";
import { resolveDateRequest } from "@/app/lib/reports/registry/resolveDateRequest";

// CI-safe: pure date math, no network/DB. Covers Section 20 items 10-19
// (dates) for the General Report Builder's DateRequest resolution --
// the ONE place a model-supplied {kind, days?, month?, year?,
// startDate?, endDate?} is turned into concrete calendar dates.

const NY = "America/New_York";
const NOW = new Date("2026-08-20T14:00:00Z"); // Aug 20, 2026 in NY (a Thursday)
const TRANSACTIONAL = { isPointInTime: false, maxRangeDays: 90, supportedDateKinds: ["today", "yesterday", "last_n_days", "current_week", "previous_week", "current_month", "previous_month", "calendar_month", "custom_range"] as const };
const POINT_IN_TIME = { isPointInTime: true, maxRangeDays: null, supportedDateKinds: ["point_in_time"] as const };

describe("resolveDateRequest -- last_n_days", () => {
  it("last 10 days is 10 calendar days inclusive of today", () => {
    const result = resolveDateRequest({ kind: "last_n_days", days: 10 }, NOW, NY, TRANSACTIONAL);
    expect(result).toEqual({ ok: true, range: { startDate: "2026-08-11", endDate: "2026-08-20", isPointInTime: false } });
  });

  it("requires a positive integer days value", () => {
    const result = resolveDateRequest({ kind: "last_n_days" }, NOW, NY, TRANSACTIONAL);
    expect(result).toEqual({ ok: false, reason: "missing_argument", message: expect.any(String) });
    expect(resolveDateRequest({ kind: "last_n_days", days: 0 }, NOW, NY, TRANSACTIONAL).ok).toBe(false);
    expect(resolveDateRequest({ kind: "last_n_days", days: 1.5 }, NOW, NY, TRANSACTIONAL).ok).toBe(false);
  });
});

describe("resolveDateRequest -- today/yesterday", () => {
  it("today", () => {
    expect(resolveDateRequest({ kind: "today" }, NOW, NY, TRANSACTIONAL)).toEqual({ ok: true, range: { startDate: "2026-08-20", endDate: "2026-08-20", isPointInTime: false } });
  });
  it("yesterday", () => {
    expect(resolveDateRequest({ kind: "yesterday" }, NOW, NY, TRANSACTIONAL)).toEqual({ ok: true, range: { startDate: "2026-08-19", endDate: "2026-08-19", isPointInTime: false } });
  });
});

describe("resolveDateRequest -- current/previous week and month", () => {
  it("current_week", () => {
    expect(resolveDateRequest({ kind: "current_week" }, NOW, NY, TRANSACTIONAL)).toEqual({ ok: true, range: { startDate: "2026-08-17", endDate: "2026-08-20", isPointInTime: false } });
  });
  it("previous_week", () => {
    expect(resolveDateRequest({ kind: "previous_week" }, NOW, NY, TRANSACTIONAL)).toEqual({ ok: true, range: { startDate: "2026-08-10", endDate: "2026-08-16", isPointInTime: false } });
  });
  it("current_month", () => {
    expect(resolveDateRequest({ kind: "current_month" }, NOW, NY, TRANSACTIONAL)).toEqual({ ok: true, range: { startDate: "2026-08-01", endDate: "2026-08-20", isPointInTime: false } });
  });
  it("previous_month", () => {
    expect(resolveDateRequest({ kind: "previous_month" }, NOW, NY, TRANSACTIONAL)).toEqual({ ok: true, range: { startDate: "2026-07-01", endDate: "2026-07-31", isPointInTime: false } });
  });
});

describe("resolveDateRequest -- calendar_month (named month/year, leap-day and year boundaries)", () => {
  it("a named leap February resolves with its 29th day included", () => {
    expect(resolveDateRequest({ kind: "calendar_month", year: 2024, month: 2 }, NOW, NY, TRANSACTIONAL)).toEqual({
      ok: true,
      range: { startDate: "2024-02-01", endDate: "2024-02-29", isPointInTime: false },
    });
  });
  it("a named December rolls across the year boundary correctly", () => {
    expect(resolveDateRequest({ kind: "calendar_month", year: 2025, month: 12 }, NOW, NY, TRANSACTIONAL)).toEqual({
      ok: true,
      range: { startDate: "2025-12-01", endDate: "2025-12-31", isPointInTime: false },
    });
  });
  it("requires both month and year", () => {
    expect(resolveDateRequest({ kind: "calendar_month", year: 2026 }, NOW, NY, TRANSACTIONAL).ok).toBe(false);
    expect(resolveDateRequest({ kind: "calendar_month", month: 8 }, NOW, NY, TRANSACTIONAL).ok).toBe(false);
  });
  it("rejects a month that hasn't started yet", () => {
    const result = resolveDateRequest({ kind: "calendar_month", year: 2026, month: 12 }, NOW, NY, TRANSACTIONAL);
    expect(result).toMatchObject({ ok: false, reason: "future_month" });
  });
});

describe("resolveDateRequest -- custom_range", () => {
  it("accepts a valid explicit range", () => {
    expect(resolveDateRequest({ kind: "custom_range", startDate: "2026-08-01", endDate: "2026-08-10" }, NOW, NY, TRANSACTIONAL)).toEqual({
      ok: true,
      range: { startDate: "2026-08-01", endDate: "2026-08-10", isPointInTime: false },
    });
  });
  it("rejects a reversed range", () => {
    const result = resolveDateRequest({ kind: "custom_range", startDate: "2026-08-10", endDate: "2026-08-01" }, NOW, NY, TRANSACTIONAL);
    expect(result).toMatchObject({ ok: false, reason: "reversed_range" });
  });
  it("rejects a malformed date", () => {
    const result = resolveDateRequest({ kind: "custom_range", startDate: "not-a-date", endDate: "2026-08-01" }, NOW, NY, TRANSACTIONAL);
    expect(result).toMatchObject({ ok: false, reason: "invalid_date" });
  });
  it("requires both startDate and endDate", () => {
    expect(resolveDateRequest({ kind: "custom_range", startDate: "2026-08-01" }, NOW, NY, TRANSACTIONAL).ok).toBe(false);
  });
});

describe("resolveDateRequest -- maximum range enforcement", () => {
  it("rejects a range longer than the report's own maxRangeDays", () => {
    const result = resolveDateRequest({ kind: "custom_range", startDate: "2026-01-01", endDate: "2026-08-20" }, NOW, NY, TRANSACTIONAL);
    expect(result).toMatchObject({ ok: false, reason: "range_too_large" });
  });
  it("accepts a range of exactly the maximum", () => {
    const result = resolveDateRequest({ kind: "last_n_days", days: 90 }, NOW, NY, TRANSACTIONAL);
    expect(result.ok).toBe(true);
  });
});

describe("resolveDateRequest -- point-in-time reports", () => {
  it("accepts point_in_time for a point-in-time report", () => {
    expect(resolveDateRequest({ kind: "point_in_time" }, NOW, NY, POINT_IN_TIME)).toEqual({ ok: true, range: { startDate: "", endDate: "", isPointInTime: true } });
  });
  it("rejects any other date kind for a point-in-time report", () => {
    const result = resolveDateRequest({ kind: "today" }, NOW, NY, POINT_IN_TIME);
    expect(result).toMatchObject({ ok: false, reason: "unsupported_date_kind" });
  });
  it("rejects point_in_time for a transactional (date-ranged) report", () => {
    const result = resolveDateRequest({ kind: "point_in_time" }, NOW, NY, TRANSACTIONAL);
    expect(result).toMatchObject({ ok: false, reason: "unsupported_date_kind" });
  });
});

describe("resolveDateRequest -- unsupported date kind per report", () => {
  it("rejects a date kind not in the report's own supportedDateKinds allowlist", () => {
    const limited = { isPointInTime: false, maxRangeDays: 90, supportedDateKinds: ["last_n_days"] as const };
    const result = resolveDateRequest({ kind: "current_month" }, NOW, NY, limited);
    expect(result).toMatchObject({ ok: false, reason: "unsupported_date_kind" });
  });
});
