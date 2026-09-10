import { describe, expect, it } from "vitest";
import {
  computeChartGeometry,
  computePriceChange,
  conversionLabel,
  periodStartDate,
  priceHistoryPeriodFromParam,
  priceUnavailableCopy,
  VENDOR_COLOR_CLASSES,
} from "@/app/lib/inventory/priceHistoryPresentation";

/**
 * Vendor-aware Price History -- pure presentation/computation helpers.
 * The invalid-input branches here are the client half of the spec's
 * "handle invalid data safely / never display $0.00 merely because the
 * calculation could not be completed" rule; the server half lives in
 * get_item_price_history's own reason codes (itemPriceHistory.rpc.test.ts).
 */

describe("computePriceChange", () => {
  it("computes dollar and percent change", () => {
    const change = computePriceChange(4.38, 4.22);
    expect(change).not.toBeNull();
    expect(change!.dollarChange).toBeCloseTo(0.16, 10);
    expect(change!.percentChange).toBeCloseTo(3.791, 2);
  });

  it("computes negative change", () => {
    const change = computePriceChange(4.1, 4.38);
    expect(change!.dollarChange).toBeCloseTo(-0.28, 10);
    expect(change!.percentChange).toBeLessThan(0);
  });

  it("returns null when either price is missing -- never a fabricated $0.00 change", () => {
    expect(computePriceChange(null, 4.22)).toBeNull();
    expect(computePriceChange(4.38, null)).toBeNull();
    expect(computePriceChange(null, null)).toBeNull();
  });

  it("returns null for NaN or infinite inputs", () => {
    expect(computePriceChange(Number.NaN, 4.22)).toBeNull();
    expect(computePriceChange(4.38, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("returns null percent (not Infinity) when the previous price is zero", () => {
    const change = computePriceChange(4.38, 0);
    expect(change).not.toBeNull();
    expect(change!.percentChange).toBeNull();
  });
});

describe("periodStartDate / priceHistoryPeriodFromParam", () => {
  const now = new Date("2026-09-10T12:00:00Z");

  it("resolves 30d/90d/1y to inclusive start dates", () => {
    expect(periodStartDate("30d", now)).toBe("2026-08-11");
    expect(periodStartDate("90d", now)).toBe("2026-06-12");
    expect(periodStartDate("1y", now)).toBe("2025-09-10");
  });

  it("resolves 'all' to unbounded", () => {
    expect(periodStartDate("all", now)).toBeNull();
  });

  it("defaults unknown params to 90d", () => {
    expect(priceHistoryPeriodFromParam(undefined)).toBe("90d");
    expect(priceHistoryPeriodFromParam("bogus")).toBe("90d");
    expect(priceHistoryPeriodFromParam("30d")).toBe("30d");
    expect(priceHistoryPeriodFromParam("all")).toBe("all");
  });
});

describe("conversionLabel", () => {
  it("renders a fixed vendor-package conversion", () => {
    expect(
      conversionLabel({ snapshotPurchaseUnitCode: "CASE", snapshotConversionFactor: 24, packageUnit: "CS", baseUnitCode: "PIECE" })
    ).toBe("1 CASE = 24 PIECE");
  });

  it("renders fractional factors without float noise", () => {
    expect(
      conversionLabel({ snapshotPurchaseUnitCode: "CASE", snapshotConversionFactor: 2.5, packageUnit: null, baseUnitCode: "LB" })
    ).toBe("1 CASE = 2.5 LB");
  });

  it("falls back to the invoice package unit, then the base unit -- never a guessed conversion", () => {
    expect(conversionLabel({ snapshotPurchaseUnitCode: null, snapshotConversionFactor: null, packageUnit: "CS", baseUnitCode: "PIECE" })).toBe(
      "CS"
    );
    expect(conversionLabel({ snapshotPurchaseUnitCode: null, snapshotConversionFactor: null, packageUnit: null, baseUnitCode: "PIECE" })).toBe(
      "PIECE"
    );
  });
});

describe("priceUnavailableCopy", () => {
  it("has specific copy for every server reason code and a generic fallback", () => {
    for (const reason of ["MISSING_LINE_AMOUNT", "NON_POSITIVE_LINE_AMOUNT", "NON_POSITIVE_QUANTITY", "QUANTITY_MISMATCH"]) {
      const copy = priceUnavailableCopy(reason);
      expect(copy).toContain("Price unavailable");
      expect(copy).not.toBe("Price unavailable.");
    }
    expect(priceUnavailableCopy(null)).toBe("Price unavailable.");
    expect(priceUnavailableCopy("SOMETHING_NEW")).toBe("Price unavailable.");
  });

  it("never renders a $0.00 price for an unavailable calculation", () => {
    for (const reason of ["MISSING_LINE_AMOUNT", "NON_POSITIVE_LINE_AMOUNT", "NON_POSITIVE_QUANTITY", "QUANTITY_MISMATCH", null]) {
      expect(priceUnavailableCopy(reason)).not.toContain("$0.00");
    }
  });
});

describe("computeChartGeometry", () => {
  const point = (id: string, receivedAt: string, vendorId: string | null, price: number, corrected = false) => ({
    id,
    receivedAt,
    vendorId,
    price,
    corrected,
  });

  it("returns null for no points -- never fabricates a zero-value chart", () => {
    expect(computeChartGeometry([])).toBeNull();
    expect(computeChartGeometry([point("a", "2026-08-01T00:00:00Z", "v1", Number.NaN)])).toBeNull();
  });

  it("splits vendors into separate series -- two vendors never share a connecting segment", () => {
    const geometry = computeChartGeometry([
      point("a", "2026-08-01T00:00:00Z", "v1", 4.0),
      point("b", "2026-08-05T00:00:00Z", "v2", 4.5),
      point("c", "2026-08-10T00:00:00Z", "v1", 4.2),
      point("d", "2026-08-15T00:00:00Z", "v2", 4.4),
    ]);
    expect(geometry).not.toBeNull();
    expect(geometry!.series).toHaveLength(2);
    const v1 = geometry!.series.find((s) => s.vendorId === "v1")!;
    const v2 = geometry!.series.find((s) => s.vendorId === "v2")!;
    expect(v1.points.map((p) => p.id)).toEqual(["a", "c"]);
    expect(v2.points.map((p) => p.id)).toEqual(["b", "d"]);
    expect(v1.colorIndex).not.toBe(v2.colorIndex);
  });

  it("renders a single point mid-chart, never collapsed to an edge", () => {
    const geometry = computeChartGeometry([point("only", "2026-08-25T00:00:00Z", "v1", 4.38)]);
    expect(geometry).not.toBeNull();
    const p = geometry!.series[0].points[0];
    expect(p.x).toBe(0.5);
    expect(p.y).toBeGreaterThan(0.2);
    expect(p.y).toBeLessThan(0.8);
    expect(geometry!.priceMin).toBe(4.38);
    expect(geometry!.priceMax).toBe(4.38);
  });

  it("pads the y-domain so real extremes never sit on the chart edge", () => {
    const geometry = computeChartGeometry([point("lo", "2026-08-01T00:00:00Z", "v1", 4.0), point("hi", "2026-08-10T00:00:00Z", "v1", 5.0)]);
    for (const p of geometry!.series[0].points) {
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(1);
    }
  });

  it("keeps vendor colors stable by first appearance and cycles the palette", () => {
    const many = Array.from({ length: VENDOR_COLOR_CLASSES.length + 2 }, (_, i) =>
      point(`p${i}`, `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`, `vendor-${i}`, 4 + i * 0.1)
    );
    const geometry = computeChartGeometry(many);
    expect(geometry!.series[0].colorIndex).toBe(0);
    expect(geometry!.series[VENDOR_COLOR_CLASSES.length].colorIndex).toBe(0);
  });

  it("plots unknown-vendor points as their own series", () => {
    const geometry = computeChartGeometry([point("a", "2026-08-01T00:00:00Z", null, 4.0), point("b", "2026-08-05T00:00:00Z", "v1", 4.5)]);
    expect(geometry!.series).toHaveLength(2);
    expect(geometry!.series.some((s) => s.vendorId === null)).toBe(true);
  });
});
