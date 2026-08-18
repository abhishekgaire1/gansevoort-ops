import { describe, expect, it } from "vitest";
import { computeReceivingPrefill, recomputeFixedConversionVerifiedQuantity } from "@/app/lib/receiving/computeReceivingPrefill";
import type { ReceivingLineInfo } from "@/app/lib/receiving/getReceivingLines";

/**
 * Most deliveries arrive in the quantity invoiced -- the manager should be
 * reviewing exceptions, not retyping a number the invoice already gave us.
 * But invoice billing-quantity semantics and Item Master packaging
 * configuration are DIFFERENT facts and must never be conflated. The real
 * Bartlett "HEAVY CREAM 40% QUART (12)" case (package_quantity=48,
 * package_unit=null, item's confirmed purchase unit=CASE, 1 CASE=12 PIECE)
 * is NOT safely "48 CASE" -- the invoice's 48 is actually counted in the
 * item's BASE unit (PIECE), not its packaging unit. These tests prove the
 * item's own purchase/packaging unit is never used as a substitute for a
 * missing INVOICE unit -- only the invoice's own stated unit, or a
 * separately-confirmed vendor/current-line invoice-unit fact
 * (confirmedInvoiceUnitCode), is ever trusted for that, and a genuine
 * disagreement between the two is surfaced for review, never silently
 * resolved.
 */

function line(overrides: Partial<ReceivingLineInfo>): ReceivingLineInfo {
  return {
    lineKey: "line-1",
    description: "Test Item",
    vendorSku: "SKU-1",
    invoicePackageQuantity: null,
    invoicePackageUnit: null,
    disposition: "INVENTORY",
    inventoryItemId: "item-1",
    baseUnitCode: null,
    baseUnitId: "unit-1",
    purchaseUnitCode: null,
    receivingBehavior: null,
    fixedConversionFactor: null,
    requiresVerifiedMeasurement: false,
    defaultReceivingLocationId: null,
    confirmedInvoiceUnitCode: null,
    ...overrides,
  };
}

const EMPTY = { receivedQuantity: "", receivedUnit: "", verifiedQuantity: "", conflict: null };

describe("computeReceivingPrefill", () => {
  it("never prefills anything for a NON_INVENTORY line", () => {
    const result = computeReceivingPrefill(line({ disposition: "NON_INVENTORY", invoicePackageQuantity: 1, invoicePackageUnit: "EACH" }));
    expect(result).toEqual(EMPTY);
  });

  it("prefills nothing when there is no invoice quantity at all -- nothing to assume a unit for", () => {
    const result = computeReceivingPrefill(
      line({ invoicePackageQuantity: null, invoicePackageUnit: null, receivingBehavior: "FIXED_CONVERSION", purchaseUnitCode: "CASE", fixedConversionFactor: 12 })
    );
    expect(result).toEqual(EMPTY);
  });

  describe("SAME_UNIT", () => {
    it("prefills Actually Received when the invoice unit matches the base unit", () => {
      const result = computeReceivingPrefill(line({ invoicePackageQuantity: 20, invoicePackageUnit: "LB", baseUnitCode: "LB", receivingBehavior: "SAME_UNIT" }));
      expect(result).toEqual({ receivedQuantity: "20", receivedUnit: "LB", verifiedQuantity: "", conflict: null });
    });

    it("also prefills using the item's own base unit when the invoice simply didn't capture a unit -- the item has only ONE relevant unit, so this fallback is safe and is not generalized to packaged items below", () => {
      const result = computeReceivingPrefill(line({ invoicePackageQuantity: 20, invoicePackageUnit: null, baseUnitCode: "LB", receivingBehavior: "SAME_UNIT" }));
      expect(result).toEqual({ receivedQuantity: "20", receivedUnit: "LB", verifiedQuantity: "", conflict: null });
    });

    it("prefills nothing when the invoice states a unit that conflicts with the base unit -- never silently reconciled", () => {
      const result = computeReceivingPrefill(line({ invoicePackageQuantity: 20, invoicePackageUnit: "CASE", baseUnitCode: "LB", receivingBehavior: "SAME_UNIT" }));
      expect(result).toEqual(EMPTY);
    });
  });

  describe("FIXED_CONVERSION", () => {
    it("(test 5) an EXPLICIT invoice unit of CASE still safely prefills Actually Received AND the computed Verified Base Qty, since reading the invoice's own stated unit is never a guess", () => {
      const result = computeReceivingPrefill(
        line({ invoicePackageQuantity: 2, invoicePackageUnit: "CASE", purchaseUnitCode: "CASE", baseUnitCode: "EACH", fixedConversionFactor: 24, receivingBehavior: "FIXED_CONVERSION" })
      );
      expect(result).toEqual({ receivedQuantity: "2", receivedUnit: "CASE", verifiedQuantity: "48", conflict: null });
    });

    it("is case-insensitive when matching the invoice unit against the purchase unit", () => {
      const result = computeReceivingPrefill(
        line({ invoicePackageQuantity: 4, invoicePackageUnit: "case", purchaseUnitCode: "CASE", fixedConversionFactor: 12, receivingBehavior: "FIXED_CONVERSION" })
      );
      expect(result.verifiedQuantity).toBe("48");
    });

    it("(test 1) the exact real Bartlett Heavy Cream case: invoice qty 48 + invoice unit NULL + purchase unit CASE must NOT become 48 CASE automatically -- the item's confirmed packaging unit is never substituted for a missing invoice unit", () => {
      const result = computeReceivingPrefill(
        line({ invoicePackageQuantity: 48, invoicePackageUnit: null, receivingBehavior: "FIXED_CONVERSION", purchaseUnitCode: "CASE", fixedConversionFactor: 12, baseUnitCode: "PIECE" })
      );
      expect(result).toEqual(EMPTY);
    });

    it("(test 2) once a vendor's invoice-billing unit for this SKU is separately confirmed as PIECE (the item's base unit), the same line safely becomes 48 PIECE -- not 48 CASE, and not a computed 576", () => {
      const result = computeReceivingPrefill(
        line({
          invoicePackageQuantity: 48,
          invoicePackageUnit: null,
          receivingBehavior: "FIXED_CONVERSION",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: 12,
          baseUnitCode: "PIECE",
          confirmedInvoiceUnitCode: "PIECE",
        })
      );
      expect(result).toEqual({ receivedQuantity: "48", receivedUnit: "PIECE", verifiedQuantity: "48", conflict: null });
    });

    it("(test 3) the CASE=12 PIECE packaging relationship remains a separate fact from the confirmed invoice unit -- changing the conversion factor has no effect once the invoice unit resolves to the base unit, proving the factor is never applied on this path", () => {
      const result = computeReceivingPrefill(
        line({
          invoicePackageQuantity: 48,
          invoicePackageUnit: null,
          receivingBehavior: "FIXED_CONVERSION",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: 6, // deliberately different from the "real" 12 -- must not matter
          baseUnitCode: "PIECE",
          confirmedInvoiceUnitCode: "PIECE",
        })
      );
      expect(result).toEqual({ receivedQuantity: "48", receivedUnit: "PIECE", verifiedQuantity: "48", conflict: null });
    });

    it("(test 7) an EXPLICIT future invoice unit of CASE conflicting with a remembered PIECE surfaces a review conflict, never a silent pick of either value", () => {
      const result = computeReceivingPrefill(
        line({
          invoicePackageQuantity: 5,
          invoicePackageUnit: "CASE",
          receivingBehavior: "FIXED_CONVERSION",
          purchaseUnitCode: "CASE",
          baseUnitCode: "PIECE",
          fixedConversionFactor: 12,
          confirmedInvoiceUnitCode: "PIECE",
        })
      );
      expect(result).toEqual({ receivedQuantity: "", receivedUnit: "", verifiedQuantity: "", conflict: { invoiceUnit: "CASE", rememberedUnit: "PIECE" } });
    });

    it("never prefills or computes anything when the invoice's stated unit matches neither the confirmed purchase unit nor the base unit, and nothing is remembered to compare against (an ordinary packaging conflict, not a vendor-memory conflict)", () => {
      const result = computeReceivingPrefill(
        line({ invoicePackageQuantity: 48, invoicePackageUnit: "GALLON", purchaseUnitCode: "CASE", baseUnitCode: "PIECE", fixedConversionFactor: 12, receivingBehavior: "FIXED_CONVERSION" })
      );
      expect(result).toEqual(EMPTY);
    });

    it("prefills nothing when the item has no confirmed fixed conversion factor to compute from", () => {
      const result = computeReceivingPrefill(
        line({ invoicePackageQuantity: 2, invoicePackageUnit: "CASE", purchaseUnitCode: "CASE", fixedConversionFactor: null, receivingBehavior: "FIXED_CONVERSION" })
      );
      expect(result).toEqual(EMPTY);
    });
  });

  describe("MEASURE_EACH_DELIVERY / COUNT_EACH_DELIVERY", () => {
    it("prefills only the container-level Actually Received quantity, never the required Verified field", () => {
      const result = computeReceivingPrefill(
        line({ invoicePackageQuantity: 1, invoicePackageUnit: "BOX", baseUnitCode: "LB", purchaseUnitCode: "BOX", receivingBehavior: "MEASURE_EACH_DELIVERY", requiresVerifiedMeasurement: true })
      );
      expect(result).toEqual({ receivedQuantity: "1", receivedUnit: "BOX", verifiedQuantity: "", conflict: null });
    });

    it("(test 4) invoice unit missing must NOT become BOX merely because BOX is the item's configured purchase package", () => {
      const result = computeReceivingPrefill(
        line({ invoicePackageQuantity: 1, invoicePackageUnit: null, baseUnitCode: "LB", purchaseUnitCode: "BOX", receivingBehavior: "MEASURE_EACH_DELIVERY", requiresVerifiedMeasurement: true })
      );
      expect(result).toEqual(EMPTY);
    });

    it("a separately-confirmed vendor invoice unit that matches the container unit safely prefills the container count, same as an explicit invoice unit would", () => {
      const result = computeReceivingPrefill(
        line({
          invoicePackageQuantity: 1,
          invoicePackageUnit: null,
          baseUnitCode: "LB",
          purchaseUnitCode: "BOX",
          receivingBehavior: "MEASURE_EACH_DELIVERY",
          requiresVerifiedMeasurement: true,
          confirmedInvoiceUnitCode: "BOX",
        })
      );
      expect(result).toEqual({ receivedQuantity: "1", receivedUnit: "BOX", verifiedQuantity: "", conflict: null });
    });

    it("prefills the container count for COUNT_EACH_DELIVERY too, never the required verified count", () => {
      const result = computeReceivingPrefill(
        line({ invoicePackageQuantity: 3, invoicePackageUnit: "BAG", baseUnitCode: "EACH", purchaseUnitCode: "BAG", receivingBehavior: "COUNT_EACH_DELIVERY", requiresVerifiedMeasurement: true })
      );
      expect(result).toEqual({ receivedQuantity: "3", receivedUnit: "BAG", verifiedQuantity: "", conflict: null });
    });

    it("prefills nothing when the invoice states a container unit that conflicts with the item's confirmed purchase unit", () => {
      const result = computeReceivingPrefill(
        line({ invoicePackageQuantity: 1, invoicePackageUnit: "CRATE", baseUnitCode: "LB", purchaseUnitCode: "BOX", receivingBehavior: "MEASURE_EACH_DELIVERY", requiresVerifiedMeasurement: true })
      );
      expect(result).toEqual(EMPTY);
    });
  });

  it("prefills nothing for a line with no confirmed receiving configuration yet", () => {
    const result = computeReceivingPrefill(line({ disposition: "UNRESOLVED", invoicePackageQuantity: 5, invoicePackageUnit: "LB", receivingBehavior: null }));
    expect(result).toEqual(EMPTY);
  });
});

/**
 * Adversarial-review priority 3 (client half): ReceivingPanel.tsx's
 * Received Qty/Unit fields never recomputed the derived FIXED_CONVERSION
 * quantity on manual edit, so a manager correcting a shortage/excess
 * (e.g. 2 CASE -> 1 CASE, at 1 CASE = 24 PIECE) left a stale, wrong
 * quantity (48, not 24) silently stored. This is the pure function
 * ReceivingPanel now calls from both Received-quantity and Received-unit
 * onChange handlers to keep the derived quantity in sync immediately.
 */
describe("recomputeFixedConversionVerifiedQuantity", () => {
  const fixedConversionLine = line({
    baseUnitCode: "PIECE",
    purchaseUnitCode: "CASE",
    receivingBehavior: "FIXED_CONVERSION",
    fixedConversionFactor: 24,
  });

  it("2 CASE -> 48 PIECE, then correcting to 1 CASE -> 24 PIECE, never a stale 48", () => {
    expect(recomputeFixedConversionVerifiedQuantity(fixedConversionLine, "2", "CASE")).toBe("48");
    expect(recomputeFixedConversionVerifiedQuantity(fixedConversionLine, "1", "CASE")).toBe("24");
  });

  it("a quantity already stated in the base unit is never multiplied a second time", () => {
    expect(recomputeFixedConversionVerifiedQuantity(fixedConversionLine, "24", "PIECE")).toBe("24");
  });

  it("returns blank (never a stale or guessed number) for a unit that matches neither the purchase nor base unit", () => {
    expect(recomputeFixedConversionVerifiedQuantity(fixedConversionLine, "1", "GALLON")).toBe("");
  });

  it("returns blank for an empty or unparseable quantity", () => {
    expect(recomputeFixedConversionVerifiedQuantity(fixedConversionLine, "", "CASE")).toBe("");
    expect(recomputeFixedConversionVerifiedQuantity(fixedConversionLine, "not a number", "CASE")).toBe("");
  });

  it("is a no-op for every other receiving behavior -- FIXED_CONVERSION math never applies to them", () => {
    const measureLine = line({ baseUnitCode: "LB", purchaseUnitCode: "BOX", receivingBehavior: "MEASURE_EACH_DELIVERY", requiresVerifiedMeasurement: true });
    expect(recomputeFixedConversionVerifiedQuantity(measureLine, "2", "BOX")).toBe("");
  });

  it("unit matching is case-insensitive, matching the rest of this codebase's unit-comparison convention", () => {
    expect(recomputeFixedConversionVerifiedQuantity(fixedConversionLine, "2", "case")).toBe("48");
  });
});
