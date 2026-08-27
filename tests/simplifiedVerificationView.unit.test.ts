import { describe, expect, it } from "vitest";
import {
  categoriesMatch,
  spendCategoryLeafName,
  derivePurchaseSummary,
  isReceivingBehaviorInferred,
  shouldShowDispositionControl,
  shouldAutoExpandAdvancedSettings,
  LOW_CONFIDENCE_THRESHOLD,
} from "@/app/lib/itemMaster/simplifiedVerificationView";

// CI-safe: no network, no database. Covers the simplified New Item
// Review screen's progressive-disclosure view logic -- pure functions
// only, since this repo has no component-rendering test infrastructure
// (see newItemVerification.ts's own header comment).

describe("spendCategoryLeafName", () => {
  it("returns the last path segment", () => {
    expect(spendCategoryLeafName("Food > Packaging & Disposables")).toBe("Packaging & Disposables");
  });

  it("returns the whole string when there is no path separator", () => {
    expect(spendCategoryLeafName("Packaging & Disposables")).toBe("Packaging & Disposables");
  });
});

describe("categoriesMatch", () => {
  it("soup cup scenario: matches case/whitespace-insensitively", () => {
    expect(categoriesMatch("Packaging & Disposables", "Food > Packaging & Disposables")).toBe(true);
    expect(categoriesMatch("packaging & disposables", "Food >  Packaging & Disposables  ")).toBe(true);
  });

  it("does not match when the names genuinely differ", () => {
    expect(categoriesMatch("Produce", "Food > Packaging & Disposables")).toBe(false);
  });

  it("does not match when either side is unresolved", () => {
    expect(categoriesMatch(null, "Food > Produce")).toBe(false);
    expect(categoriesMatch("Produce", null)).toBe(false);
    expect(categoriesMatch(null, null)).toBe(false);
  });
});

describe("derivePurchaseSummary", () => {
  it("soup cup scenario: fixed conversion renders as plain language", () => {
    const summary = derivePurchaseSummary({
      baseUnitCode: "PIECE",
      baseUnitName: "Piece",
      purchaseUnitCode: "CASE",
      purchaseUnitName: "Case",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: 500,
    });
    expect(summary).toEqual({ headline: "Purchased as: Case", detail: "500 pieces per case" });
  });

  it("SAME_UNIT collapses to a headline with no detail line", () => {
    const summary = derivePurchaseSummary({
      baseUnitCode: "PIECE",
      baseUnitName: "Piece",
      purchaseUnitCode: "PIECE",
      purchaseUnitName: "Piece",
      receivingBehavior: "SAME_UNIT",
      fixedConversionFactor: null,
    });
    expect(summary).toEqual({ headline: "Purchased as: Piece", detail: null });
  });

  it("MEASURE_EACH_DELIVERY summarizes without a numeric factor", () => {
    const summary = derivePurchaseSummary({
      baseUnitCode: "LB",
      baseUnitName: "Pound",
      purchaseUnitCode: "BOX",
      purchaseUnitName: "Box",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
      fixedConversionFactor: null,
    });
    expect(summary?.headline).toBe("Purchased as: Box");
    expect(summary?.detail).toMatch(/measured/i);
  });

  it("returns null when there is nothing safe to infer yet (distinct purchase unit, no resolved receiving behavior)", () => {
    const summary = derivePurchaseSummary({
      baseUnitCode: "LB",
      baseUnitName: "Pound",
      purchaseUnitCode: "BOX",
      purchaseUnitName: "Box",
      receivingBehavior: null,
      fixedConversionFactor: null,
    });
    expect(summary).toBeNull();
  });

  it("returns null when there is no base unit resolved at all", () => {
    expect(
      derivePurchaseSummary({ baseUnitCode: null, baseUnitName: null, purchaseUnitCode: null, purchaseUnitName: null, receivingBehavior: null, fixedConversionFactor: null })
    ).toBeNull();
  });
});

describe("isReceivingBehaviorInferred", () => {
  it("is inferred for SAME_UNIT", () => {
    expect(isReceivingBehaviorInferred({ baseUnitCode: "PIECE", purchaseUnitCode: "PIECE", receivingBehavior: "SAME_UNIT", fixedConversionFactor: null })).toBe(true);
  });

  it("is inferred for FIXED_CONVERSION only once a positive factor is resolved", () => {
    expect(isReceivingBehaviorInferred({ baseUnitCode: "PIECE", purchaseUnitCode: "CASE", receivingBehavior: "FIXED_CONVERSION", fixedConversionFactor: null })).toBe(false);
    expect(isReceivingBehaviorInferred({ baseUnitCode: "PIECE", purchaseUnitCode: "CASE", receivingBehavior: "FIXED_CONVERSION", fixedConversionFactor: 0 })).toBe(false);
    expect(isReceivingBehaviorInferred({ baseUnitCode: "PIECE", purchaseUnitCode: "CASE", receivingBehavior: "FIXED_CONVERSION", fixedConversionFactor: 500 })).toBe(true);
  });

  it("is inferred for MEASURE_EACH_DELIVERY and COUNT_EACH_DELIVERY", () => {
    expect(isReceivingBehaviorInferred({ baseUnitCode: "LB", purchaseUnitCode: "BOX", receivingBehavior: "MEASURE_EACH_DELIVERY", fixedConversionFactor: null })).toBe(true);
    expect(isReceivingBehaviorInferred({ baseUnitCode: "PIECE", purchaseUnitCode: "BAG", receivingBehavior: "COUNT_EACH_DELIVERY", fixedConversionFactor: null })).toBe(true);
  });
});

describe("shouldShowDispositionControl", () => {
  it("hides the raw dropdown for a confident inventory item", () => {
    expect(shouldShowDispositionControl(0.95, "INVENTORY")).toBe(false);
  });

  it("shows the raw dropdown when confidence is low", () => {
    expect(shouldShowDispositionControl(LOW_CONFIDENCE_THRESHOLD - 0.01, "INVENTORY")).toBe(true);
  });

  it("always shows the raw dropdown for a non-inventory item, regardless of confidence", () => {
    expect(shouldShowDispositionControl(0.99, "NON_INVENTORY")).toBe(true);
    expect(shouldShowDispositionControl(null, "NON_INVENTORY")).toBe(true);
  });

  it("hides the raw dropdown when confidence is unknown but disposition is inventory", () => {
    expect(shouldShowDispositionControl(null, "INVENTORY")).toBe(false);
  });
});

describe("shouldAutoExpandAdvancedSettings", () => {
  const baseline = { confidence: 0.95, categoriesMatch: true, hasSecondaryUsageUnit: false, receivingBehaviorInferred: true, disposition: "INVENTORY" as const };

  it("stays collapsed for the fully-resolved, confident, one-unit case (soup cup scenario)", () => {
    expect(shouldAutoExpandAdvancedSettings(baseline)).toBe(false);
  });

  it("auto-expands on low AI confidence", () => {
    expect(shouldAutoExpandAdvancedSettings({ ...baseline, confidence: 0.1 })).toBe(true);
  });

  it("auto-expands when categories differ", () => {
    expect(shouldAutoExpandAdvancedSettings({ ...baseline, categoriesMatch: false })).toBe(true);
  });

  it("auto-expands when a secondary usage unit is already set", () => {
    expect(shouldAutoExpandAdvancedSettings({ ...baseline, hasSecondaryUsageUnit: true })).toBe(true);
  });

  it("auto-expands when receiving behavior cannot be inferred", () => {
    expect(shouldAutoExpandAdvancedSettings({ ...baseline, receivingBehaviorInferred: false })).toBe(true);
  });

  it("auto-expands for non-inventory items", () => {
    expect(shouldAutoExpandAdvancedSettings({ ...baseline, disposition: "NON_INVENTORY" })).toBe(true);
  });
});
