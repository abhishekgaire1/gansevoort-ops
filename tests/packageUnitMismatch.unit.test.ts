import { describe, expect, it } from "vitest";
import { hasPackageUnitMismatch, resolveLineMismatchFields, resolveUnitCode, type PackageUnitMismatchInput } from "@/app/lib/purchaseDocuments/packageUnitMismatch";

/**
 * Fix for a confirmed defect: the invoice-unit-vs-confirmed-purchase-
 * package mismatch used to only surface at "Ready to Post" time, after
 * every line was already approved through the four-step review. This is
 * the pure-function core of the earlier check now surfaced during Step 2
 * (Confirm Items) -- see packageUnitMismatch.ts's own doc comment for how
 * it mirrors post_purchase_document_inventory's authoritative blocker
 * scan exactly.
 */

const baseInput: PackageUnitMismatchInput = {
  status: "CONFIRMED",
  disposition: "INVENTORY",
  resolvedInvoiceUnitCode: "PACK",
  effectivePurchaseUnitCode: "CASE",
};

describe("hasPackageUnitMismatch", () => {
  it("flags a mismatch as soon as both the invoice unit and the confirmed purchase package are known and disagree", () => {
    expect(hasPackageUnitMismatch(baseInput)).toBe(true);
  });

  it("passes normally when the invoice unit matches the confirmed purchase package", () => {
    expect(hasPackageUnitMismatch({ ...baseInput, resolvedInvoiceUnitCode: "CASE", effectivePurchaseUnitCode: "CASE" })).toBe(false);
  });

  it("is case/whitespace-insensitive (never a false mismatch from formatting alone)", () => {
    expect(hasPackageUnitMismatch({ ...baseInput, resolvedInvoiceUnitCode: " case ", effectivePurchaseUnitCode: "CASE" })).toBe(false);
  });

  it("never blocks an expense (NON_INVENTORY) line -- expense lines never post inventory", () => {
    expect(hasPackageUnitMismatch({ ...baseInput, disposition: "NON_INVENTORY" })).toBe(false);
  });

  it("never blocks a line before it is CONFIRMED -- there is no confirmed purchase package to compare against yet", () => {
    expect(hasPackageUnitMismatch({ ...baseInput, status: "PENDING_REVIEW" })).toBe(false);
    expect(hasPackageUnitMismatch({ ...baseInput, status: "STALE" })).toBe(false);
    expect(hasPackageUnitMismatch({ ...baseInput, status: "UNCLASSIFIED" })).toBe(false);
  });

  it("reports no mismatch (never guesses) when the invoice unit can't be resolved against a real unit", () => {
    expect(hasPackageUnitMismatch({ ...baseInput, resolvedInvoiceUnitCode: null })).toBe(false);
  });

  it("reports no mismatch when there is no effective purchase package resolved at all", () => {
    expect(hasPackageUnitMismatch({ ...baseInput, effectivePurchaseUnitCode: null })).toBe(false);
  });

  it("treats PACK, CASE, EACH, and TUB as distinct, never interchangeable", () => {
    expect(hasPackageUnitMismatch({ ...baseInput, resolvedInvoiceUnitCode: "PACK", effectivePurchaseUnitCode: "TUB" })).toBe(true);
    expect(hasPackageUnitMismatch({ ...baseInput, resolvedInvoiceUnitCode: "EACH", effectivePurchaseUnitCode: "CASE" })).toBe(true);
  });

  it("passes normally for a SAME_UNIT line whose invoice unit matches the item's base unit (fixed/measured usage-unit behavior unaffected)", () => {
    expect(hasPackageUnitMismatch({ ...baseInput, resolvedInvoiceUnitCode: "LB", effectivePurchaseUnitCode: "LB" })).toBe(false);
  });
});

describe("resolveUnitCode", () => {
  const recognized = new Set(["PACK", "CASE", "LB", "EACH", "TUB"]);

  it("resolves a recognized unit, case/whitespace-insensitively", () => {
    expect(resolveUnitCode(" pack ", recognized)).toBe("PACK");
  });

  it("returns null (never guesses) for unrecognized or missing text", () => {
    expect(resolveUnitCode("SPLORK", recognized)).toBeNull();
    expect(resolveUnitCode(null, recognized)).toBeNull();
    expect(resolveUnitCode("", recognized)).toBeNull();
  });
});

describe("resolveLineMismatchFields", () => {
  const recognizedUnitCodes = new Set(["PACK", "CASE", "LB", "TUB"]);

  it("shows the exact required warning content: the invoice unit (PACK) vs. the configured purchase package (CASE — 4 tubs per case)", () => {
    const resolution = resolveLineMismatchFields({
      status: "CONFIRMED",
      disposition: "INVENTORY",
      invoicePackageUnitText: "PACK",
      vendorPackage: { unitCode: "CASE", unitName: "Case", receivingBehavior: "FIXED_CONVERSION", conversionFactor: 4 },
      itemBaseUnit: { code: "TUB", name: "Tub" },
      recognizedUnitCodes,
    });
    expect(resolution.resolvedInvoiceUnitCode).toBe("PACK");
    expect(resolution.effectivePurchaseUnitCode).toBe("CASE");
    expect(resolution.effectiveReceivingBehavior).toBe("FIXED_CONVERSION");
    expect(resolution.effectiveConversionFactor).toBe(4);
    expect(resolution.hasPackageMismatch).toBe(true);
  });

  it("falls back to the item's base unit for SAME_UNIT (no distinct vendor package) -- exactly coalesce(vpu.purchase_unit_id, ii.base_unit_id)", () => {
    const resolution = resolveLineMismatchFields({
      status: "CONFIRMED",
      disposition: "INVENTORY",
      invoicePackageUnitText: "LB",
      vendorPackage: null,
      itemBaseUnit: { code: "LB", name: "Pound" },
      recognizedUnitCodes,
    });
    expect(resolution.effectivePurchaseUnitCode).toBe("LB");
    expect(resolution.effectiveReceivingBehavior).toBe("SAME_UNIT");
    expect(resolution.hasPackageMismatch).toBe(false);
  });

  it("correcting the invoice unit text clears the mismatch (same vendor package, updated invoice text)", () => {
    const vendorPackage = { unitCode: "CASE", unitName: "Case", receivingBehavior: "FIXED_CONVERSION" as const, conversionFactor: 4 };
    const before = resolveLineMismatchFields({
      status: "CONFIRMED",
      disposition: "INVENTORY",
      invoicePackageUnitText: "PACK",
      vendorPackage,
      itemBaseUnit: { code: "TUB", name: "Tub" },
      recognizedUnitCodes,
    });
    expect(before.hasPackageMismatch).toBe(true);
    const after = resolveLineMismatchFields({
      status: "CONFIRMED",
      disposition: "INVENTORY",
      invoicePackageUnitText: "CASE",
      vendorPackage,
      itemBaseUnit: { code: "TUB", name: "Tub" },
      recognizedUnitCodes,
    });
    expect(after.hasPackageMismatch).toBe(false);
  });

  it("correctly updating the vendor/SKU package to match the invoice unit clears the mismatch (same invoice text, updated package)", () => {
    const before = resolveLineMismatchFields({
      status: "CONFIRMED",
      disposition: "INVENTORY",
      invoicePackageUnitText: "PACK",
      vendorPackage: { unitCode: "CASE", unitName: "Case", receivingBehavior: "FIXED_CONVERSION", conversionFactor: 4 },
      itemBaseUnit: { code: "TUB", name: "Tub" },
      recognizedUnitCodes,
    });
    expect(before.hasPackageMismatch).toBe(true);
    const after = resolveLineMismatchFields({
      status: "CONFIRMED",
      disposition: "INVENTORY",
      invoicePackageUnitText: "PACK",
      vendorPackage: { unitCode: "PACK", unitName: "Pack", receivingBehavior: "FIXED_CONVERSION", conversionFactor: 1 },
      itemBaseUnit: { code: "TUB", name: "Tub" },
      recognizedUnitCodes,
    });
    expect(after.hasPackageMismatch).toBe(false);
  });

  it("never blocks a NON_INVENTORY (expense) line even with disagreeing unit text", () => {
    const resolution = resolveLineMismatchFields({
      status: "CONFIRMED",
      disposition: "NON_INVENTORY",
      invoicePackageUnitText: "PACK",
      vendorPackage: { unitCode: "CASE", unitName: "Case", receivingBehavior: "FIXED_CONVERSION", conversionFactor: 4 },
      itemBaseUnit: null,
      recognizedUnitCodes,
    });
    expect(resolution.hasPackageMismatch).toBe(false);
  });
});
