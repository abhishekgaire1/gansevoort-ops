import { describe, expect, it } from "vitest";
import { resolveReportPeriod } from "@/app/manager/(app)/reports/_lib/reportPeriod";

// CI-safe: pure date math, no network, no database.

const TZ = "America/New_York";
const NOW = new Date("2026-08-21T18:00:00Z"); // 2:00pm Eastern

describe("resolveReportPeriod", () => {
  it("defaults to Today when no period key is given", () => {
    const period = resolveReportPeriod(NOW, TZ, undefined, undefined, undefined);
    expect(period).toEqual({ key: "TODAY", startDate: "2026-08-21", endDate: "2026-08-21", customError: null });
  });

  it("7D is a rolling 7-day window ending today (inclusive)", () => {
    const period = resolveReportPeriod(NOW, TZ, "7D", undefined, undefined);
    expect(period.key).toBe("7D");
    expect(period.endDate).toBe("2026-08-21");
    expect(period.startDate).toBe("2026-08-15");
  });

  it("30D is a rolling 30-day window ending today (inclusive)", () => {
    const period = resolveReportPeriod(NOW, TZ, "30D", undefined, undefined);
    expect(period.key).toBe("30D");
    expect(period.endDate).toBe("2026-08-21");
    expect(period.startDate).toBe("2026-07-23");
  });

  it("CUSTOM uses the supplied from/to dates verbatim when valid", () => {
    const period = resolveReportPeriod(NOW, TZ, "CUSTOM", "2026-08-01", "2026-08-10");
    expect(period).toEqual({ key: "CUSTOM", startDate: "2026-08-01", endDate: "2026-08-10", customError: null });
  });

  it("CUSTOM with a reversed range falls back to Today and reports the error truthfully", () => {
    const period = resolveReportPeriod(NOW, TZ, "CUSTOM", "2026-08-10", "2026-08-01");
    expect(period.key).toBe("CUSTOM");
    expect(period.customError).toBe("START_AFTER_END");
    expect(period.startDate).toBe("2026-08-21");
    expect(period.endDate).toBe("2026-08-21");
  });

  it("CUSTOM with missing from/to falls back to Today without an error (not yet submitted)", () => {
    const period = resolveReportPeriod(NOW, TZ, "CUSTOM", undefined, undefined);
    expect(period.key).toBe("TODAY");
    expect(period.customError).toBeNull();
  });

  it("an unrecognized period key falls back to Today", () => {
    const period = resolveReportPeriod(NOW, TZ, "NONSENSE", undefined, undefined);
    expect(period.key).toBe("TODAY");
  });
});
