import { describe, expect, it } from "vitest";
import { computeStockGauge } from "@/app/lib/inventory/stockLevel";

/**
 * The tank-gauge math for the inventory page: percentage is the main
 * numerical truth; the fill is clamped 0-100; color/label are derived.
 * Thresholds per the 2A.4 spec: 100 Full, 75-99 Healthy, 35-74 Medium,
 * 1-34 Low, 0 Empty; over-reference shows the REAL percentage with an
 * "Over Full" label while the gauge caps at 100.
 */
describe("computeStockGauge", () => {
  it("72/72 is 100% Full", () => {
    const g = computeStockGauge(72, 72);
    expect(g).toMatchObject({ percent: 100, fillPercent: 100, level: "FULL", label: "Full", overFull: false });
  });

  it("54/72 is 75% Healthy; 36/72 is 50% Medium; 18/72 is 25% Low; 0/72 is 0% Empty", () => {
    expect(computeStockGauge(54, 72)).toMatchObject({ percent: 75, level: "HEALTHY", label: "Healthy" });
    expect(computeStockGauge(36, 72)).toMatchObject({ percent: 50, level: "MEDIUM", label: "Medium" });
    expect(computeStockGauge(18, 72)).toMatchObject({ percent: 25, level: "LOW", label: "Low" });
    expect(computeStockGauge(0, 72)).toMatchObject({ percent: 0, fillPercent: 0, level: "EMPTY", label: "Empty" });
  });

  it("72/80 after a manager override is 90% Healthy", () => {
    expect(computeStockGauge(72, 80)).toMatchObject({ percent: 90, level: "HEALTHY" });
  });

  it("42/80 is 52.5% Medium -- fractional percentages are kept, not floored away", () => {
    expect(computeStockGauge(42, 80)).toMatchObject({ percent: 52.5, level: "MEDIUM" });
  });

  it("over-reference: 90/80 reports the REAL 112.5% and Over Full, with the gauge fill capped at 100", () => {
    const g = computeStockGauge(90, 80);
    expect(g.percent).toBe(112.5);
    expect(g.fillPercent).toBe(100);
    expect(g.overFull).toBe(true);
    expect(g.label).toBe("Over Full");
  });

  it("no reference yet: never computes 0/0 -- distinguishes 'no stock received yet' from 'no reference set'", () => {
    expect(computeStockGauge(0, null)).toMatchObject({ percent: null, fillPercent: 0, level: null, label: "No stock received yet" });
    expect(computeStockGauge(12, null)).toMatchObject({ percent: null, fillPercent: 0, level: null, label: "No reference set" });
    expect(computeStockGauge(5, 0)).toMatchObject({ percent: null, level: null });
  });

  it("a negative derived balance clamps the fill to 0 and reads Empty", () => {
    const g = computeStockGauge(-3, 72);
    expect(g.fillPercent).toBe(0);
    expect(g.level).toBe("EMPTY");
  });
});
