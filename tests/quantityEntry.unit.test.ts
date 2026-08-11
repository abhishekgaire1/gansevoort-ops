import { describe, expect, it } from "vitest";
import {
  computeConversionPreview,
  isQuantityEntryComplete,
  resolveQuantityEntryLayout,
} from "@/app/kiosk/_lib/quantityEntry";

// CI-safe: pure logic, no network, no database.

describe("resolveQuantityEntryLayout", () => {
  it("requiresActualMeasurement=true -> actual_measurement, regardless of conversionFactor", () => {
    expect(resolveQuantityEntryLayout({ requiresActualMeasurement: true, conversionFactor: null })).toEqual({
      kind: "actual_measurement",
    });
  });

  it("requiresActualMeasurement=false with a conversionFactor -> fixed_conversion", () => {
    expect(resolveQuantityEntryLayout({ requiresActualMeasurement: false, conversionFactor: "360" })).toEqual({
      kind: "fixed_conversion",
      conversionFactor: "360",
    });
  });

  it("defensive: requiresActualMeasurement=false with no conversionFactor degrades to simple_count instead of crashing", () => {
    expect(resolveQuantityEntryLayout({ requiresActualMeasurement: false, conversionFactor: null })).toEqual({
      kind: "simple_count",
    });
  });
});

describe("computeConversionPreview", () => {
  it("multiplies entered quantity by the conversion factor", () => {
    expect(computeConversionPreview("2", "360")).toBe(720);
  });

  it("supports fractional entered quantities (half-box)", () => {
    expect(computeConversionPreview("0.5", "360")).toBe(180);
  });

  it("returns null for a non-numeric or empty entered quantity", () => {
    expect(computeConversionPreview("", "360")).toBeNull();
    expect(computeConversionPreview("abc", "360")).toBeNull();
  });
});

describe("isQuantityEntryComplete", () => {
  it("simple_count: complete once enteredQuantity is a positive number", () => {
    expect(isQuantityEntryComplete({ kind: "simple_count" }, "210", null)).toBe(true);
    expect(isQuantityEntryComplete({ kind: "simple_count" }, "0", null)).toBe(false);
    expect(isQuantityEntryComplete({ kind: "simple_count" }, "", null)).toBe(false);
  });

  it("fixed_conversion: complete once enteredQuantity is a positive number, measured field irrelevant", () => {
    expect(isQuantityEntryComplete({ kind: "fixed_conversion", conversionFactor: "10" }, "2", null)).toBe(true);
  });

  it("actual_measurement: requires BOTH enteredQuantity and measuredBaseQuantity to be positive numbers", () => {
    const layout = { kind: "actual_measurement" as const };
    expect(isQuantityEntryComplete(layout, "2", "43.6")).toBe(true);
    expect(isQuantityEntryComplete(layout, "2", null)).toBe(false);
    expect(isQuantityEntryComplete(layout, "2", "")).toBe(false);
    expect(isQuantityEntryComplete(layout, "2", "0")).toBe(false);
    expect(isQuantityEntryComplete(layout, "", "43.6")).toBe(false);
  });
});
