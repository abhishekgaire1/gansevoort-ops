import { describe, it, expect } from "vitest";
import { deriveCompactRowView, purchasePackageText, inventoryIncreaseText, type CompactRowInput } from "@/app/lib/purchaseDocuments/lineRowPresentation";

function base(overrides: Partial<CompactRowInput> = {}): CompactRowInput {
  return {
    description: "HEAVY CREAM 40% QUART (12)",
    vendorSku: "101102",
    orderedQuantityText: "84 PIECE",
    disposition: "INVENTORY",
    matchedItemName: "Heavy Cream 40% Quart",
    receivingBehavior: "SAME_UNIT",
    purchaseUnitCode: "PIECE",
    baseUnitCode: "PIECE",
    conversionFactor: null,
    resolvedInvoiceUnitCode: "PIECE",
    verifiedBaseQuantity: null,
    receivedQuantity: "84",
    receivedUnit: "PIECE",
    locationName: "Gansevoort Liberty Market — WTC",
    conditionLabel: "Received as invoiced",
    conditionIsAsInvoiced: true,
    lineTotal: 357,
    priceComparison: { available: true, currentUnitCost: 4.25, baseUnitCode: "PIECE", previousVendorName: "Bartlett" },
    priceChangeText: "↓ 3.0% · Bartlett",
    ...overrides,
  };
}

describe("same-unit row", () => {
  it("shows the invoice meta, matched item, same-unit package and a single +N base increase (never X -> X)", () => {
    const v = deriveCompactRowView(base());
    expect(v.invoice.meta).toBe("84 PIECE · SKU 101102");
    expect(v.matchedItem).toBe("Heavy Cream 40% Quart");
    expect(v.purchasePackage).toBe("Same unit · PIECE");
    expect(v.inventoryIncrease).toBe("+84 PIECE");
    // No duplicated "84 PIECE -> 84 PIECE" anywhere in the derived strings.
    const joined = JSON.stringify(v);
    expect(joined).not.toContain("→");
    expect(joined).not.toContain("->");
  });

  it("shows a per-unit price with an explicit unit, the line total, and the change state", () => {
    const v = deriveCompactRowView(base());
    expect(v.price?.unit).toBe("$4.25 / PIECE");
    expect(v.price?.lineTotal).toBe("$357.00 line total");
    expect(v.price?.change).toBe("↓ 3.0% · Bartlett");
    expect(v.price?.invoiceUnit).toBeNull();
    expect(v.price?.normalized).toBeNull();
  });

  it("marks the destination as 'As invoiced' when condition is unchanged", () => {
    expect(deriveCompactRowView(base()).destination).toEqual({ location: "Gansevoort Liberty Market — WTC", condition: "As invoiced" });
  });
});

describe("fixed-conversion row", () => {
  const fixed = base({
    orderedQuantityText: "7 CASE",
    receivingBehavior: "FIXED_CONVERSION",
    purchaseUnitCode: "CASE",
    baseUnitCode: "PIECE",
    conversionFactor: 12,
    resolvedInvoiceUnitCode: "CASE",
    verifiedBaseQuantity: "84",
    receivedQuantity: "7",
    receivedUnit: "CASE",
    lineTotal: 140,
    priceComparison: { available: true, currentUnitCost: 1.67, baseUnitCode: "PIECE", previousVendorName: null },
    priceChangeText: "↑ 4.2% — informational",
  });

  it("shows the factor, the +base increase, and distinguishes invoice vs normalized price", () => {
    const v = deriveCompactRowView(fixed);
    expect(v.purchasePackage).toBe("1 CASE = 12 PIECE");
    expect(v.inventoryIncrease).toBe("+84 PIECE");
    expect(v.price?.invoiceUnit).toBe("Invoice: $20.04 / CASE");
    expect(v.price?.normalized).toBe("Normalized: $1.67 / PIECE");
    expect(v.price?.unit).toBeNull();
    expect(v.price?.lineTotal).toBe("$140.00 line total");
  });

  it("does not synthesize an invoice per-case price when the invoice bills in the base unit", () => {
    const v = deriveCompactRowView({ ...fixed, resolvedInvoiceUnitCode: "PIECE" });
    expect(v.price?.invoiceUnit).toBeNull();
    expect(v.price?.normalized).toBeNull();
    expect(v.price?.unit).toBe("$1.67 / PIECE");
  });
});

describe("measured-at-receiving row", () => {
  it("shows the actual measured quantity with no fabricated factor", () => {
    const v = deriveCompactRowView(
      base({
        orderedQuantityText: "2 CASE",
        receivingBehavior: "MEASURE_EACH_DELIVERY",
        purchaseUnitCode: "CASE",
        baseUnitCode: "LB",
        conversionFactor: null,
        verifiedBaseQuantity: "42.6",
        receivedQuantity: "2",
        receivedUnit: "CASE",
      }),
    );
    expect(v.purchasePackage).toBe("Measured at receiving");
    expect(v.inventoryIncrease).toBe("+42.6 LB actual");
  });
});

describe("non-inventory row", () => {
  it("adds nothing to inventory", () => {
    const v = deriveCompactRowView(base({ disposition: "NON_INVENTORY" }));
    expect(v.inventoryIncrease).toBeNull();
  });
});

describe("price visibility fallbacks", () => {
  it("still shows a line total and the state when the comparison is unavailable (no fabricated unit price)", () => {
    const v = deriveCompactRowView(base({ priceComparison: { available: false }, priceChangeText: "Comparison unavailable" }));
    expect(v.price?.unit).toBeNull();
    expect(v.price?.lineTotal).toBe("$357.00 line total");
    expect(v.price?.change).toBe("Comparison unavailable");
  });
});

describe("purchasePackageText / inventoryIncreaseText units", () => {
  it("never returns a package label without its unit context", () => {
    expect(purchasePackageText({ receivingBehavior: "SAME_UNIT", purchaseUnitCode: "LB", baseUnitCode: "LB", conversionFactor: null })).toBe("Same unit · LB");
    expect(purchasePackageText({ receivingBehavior: "FIXED_CONVERSION", purchaseUnitCode: "CASE", baseUnitCode: "LB", conversionFactor: 10 })).toBe("1 CASE = 10 LB");
  });
  it("returns null increase for a non-inventory line", () => {
    expect(inventoryIncreaseText(base({ disposition: "NON_INVENTORY" }))).toBeNull();
  });
});
