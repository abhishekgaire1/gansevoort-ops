import { describe, expect, it } from "vitest";
import { buildFinalReviewRows } from "@/app/lib/purchaseDocuments/finalReviewTable";
import type { PurchaseDocumentLine } from "@/app/lib/purchaseDocuments/types";
import type { PurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";

/**
 * Step 4's consolidated Line Review table -- ONE row per invoice line,
 * merging commercial facts (qty/unit/price/total, straight from the draft
 * lines exactly as they'll be submitted) with mapping and effective
 * receiving facts from the same authoritative read models that gate Send.
 * Replaces the old repeated Items/Receiving/Non-Inventory sections.
 */

function line(overrides: Partial<PurchaseDocumentLine>): PurchaseDocumentLine {
  return {
    lineKey: "line-1",
    vendorSku: "SKU-1",
    description: "Heavy Cream",
    packageQuantity: 72,
    packageUnit: "PIECE",
    measuredQuantity: null,
    measuredUnit: null,
    unitPrice: 4.49,
    priceBasisUnit: null,
    lineTotal: 323.28,
    rawLineText: null,
    ...overrides,
  };
}

function summaryWith(overrides: Partial<PurchaseDocumentReviewSummary>): PurchaseDocumentReviewSummary {
  return {
    items: [],
    itemsConfirmedCount: 0,
    itemsTotalCount: 0,
    receiving: [],
    receivingCompleteCount: 0,
    receivingTotalCount: 0,
    nonInventory: [],
    exceptions: [],
    ...overrides,
  };
}

const CONFIRMED_ITEM = {
  lineKey: "line-1",
  vendorSku: "SKU-1",
  description: "Heavy Cream",
  disposition: "INVENTORY" as const,
  status: "CONFIRMED" as const,
  canonicalItemName: "Heavy Cream 40% Quart",
  categoryName: "Dairy",
  spendCategoryPath: "Food > Dairy",
  baseUnitCode: "PIECE",
  purchaseUnitCode: null,
  receivingBehavior: "SAME_UNIT",
};

const RECEIVED_LINE = {
  lineKey: "line-1",
  description: "Heavy Cream",
  expectedQuantity: 72,
  expectedUnit: "PIECE",
  receivedQuantity: 72,
  receivedUnit: "PIECE",
  requiresVerifiedMeasurement: false,
  verifiedQuantity: null,
  verifiedUnit: "PIECE",
  inventoryQuantity: null,
  locationName: "Central Walk-In",
  conditionStatus: "RECEIVED_AS_INVOICED",
  hasPackageMismatch: false,
};

describe("buildFinalReviewRows", () => {
  it("merges commercial, mapping, and receiving facts into ONE row -- pricing always visible", () => {
    const rows = buildFinalReviewRows({
      lines: [line({})],
      summary: summaryWith({ items: [CONFIRMED_ITEM], receiving: [RECEIVED_LINE] }),
      blockers: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      typeLabel: "Inventory",
      sku: "SKU-1",
      description: "Heavy Cream",
      matchedLabel: "Heavy Cream 40% Quart",
      quantity: 72,
      unit: "PIECE",
      unitPrice: 4.49,
      lineTotal: 323.28,
      receivedLabel: "72 PIECE",
      locationName: "Central Walk-In",
      conditionLabel: "As invoiced",
    });
    expect(rows[0].status).toEqual({ kind: "ready", label: "Ready" });
    expect(rows[0].secondary).toBe("Dairy · PIECE · Same unit");
  });

  it("a non-inventory line appears in the SAME table with its spend category as the match and em-dash-worthy receiving cells", () => {
    const rows = buildFinalReviewRows({
      lines: [line({ lineKey: "line-2", vendorSku: null, description: "Fuel Surcharge", packageQuantity: 1, packageUnit: null, unitPrice: 4.5, lineTotal: 4.5 })],
      summary: summaryWith({
        items: [
          {
            ...CONFIRMED_ITEM,
            lineKey: "line-2",
            vendorSku: null,
            description: "Fuel Surcharge",
            disposition: "NON_INVENTORY",
            canonicalItemName: "Fuel Surcharge",
            spendCategoryPath: "Other Operating Costs > Freight & Delivery",
          },
        ],
      }),
      blockers: [],
    });
    expect(rows[0].typeLabel).toBe("Non-inventory");
    expect(rows[0].matchedLabel).toBe("Other Operating Costs > Freight & Delivery");
    expect(rows[0].lineTotal).toBe(4.5);
    expect(rows[0].receivedLabel).toBeNull(); // renders as em dash
    expect(rows[0].inventoryQuantityLabel).toBeNull();
    expect(rows[0].locationName).toBeNull();
    expect(rows[0].status.kind).toBe("ready");
  });

  it("shows the fixed-conversion Inventory Qty where relevant, and the verified actual for measured items", () => {
    const rows = buildFinalReviewRows({
      lines: [line({ lineKey: "fixed" }), line({ lineKey: "measured", description: "Korean Radish" })],
      summary: summaryWith({
        items: [
          { ...CONFIRMED_ITEM, lineKey: "fixed", receivingBehavior: "FIXED_CONVERSION" },
          { ...CONFIRMED_ITEM, lineKey: "measured", description: "Korean Radish", receivingBehavior: "MEASURE_EACH_DELIVERY", baseUnitCode: "LB" },
        ],
        receiving: [
          { ...RECEIVED_LINE, lineKey: "fixed", receivedQuantity: 2, receivedUnit: "CASE", inventoryQuantity: 20, verifiedUnit: "LB" },
          {
            ...RECEIVED_LINE,
            lineKey: "measured",
            receivedQuantity: 1,
            receivedUnit: "BOX",
            requiresVerifiedMeasurement: true,
            verifiedQuantity: 38.6,
            verifiedUnit: "LB",
            inventoryQuantity: null,
          },
        ],
      }),
      blockers: [],
    });
    expect(rows[0].inventoryQuantityLabel).toBe("20 LB");
    expect(rows[1].inventoryQuantityLabel).toBe("38.6 LB");
    // SAME_UNIT rows keep it blank rather than repeating the received qty.
  });

  it("surfaces exceptions and line blockers in the Status column with their exact reasons attached", () => {
    const rows = buildFinalReviewRows({
      lines: [line({ lineKey: "short" }), line({ lineKey: "blocked", description: "Radish" })],
      summary: summaryWith({
        items: [
          { ...CONFIRMED_ITEM, lineKey: "short" },
          { ...CONFIRMED_ITEM, lineKey: "blocked", description: "Radish" },
        ],
        receiving: [
          { ...RECEIVED_LINE, lineKey: "short", receivedQuantity: 70, conditionStatus: "SHORT" },
          { ...RECEIVED_LINE, lineKey: "blocked" },
        ],
        exceptions: [{ lineKey: "short", description: "Heavy Cream", message: "Heavy Cream — received 70 PIECE, invoice expected 72 PIECE" }],
      }),
      blockers: [{ lineKey: "blocked", description: "Radish", reason: "Verified LB is required -- this item's vendor purchase unit varies by delivery." }],
    });
    expect(rows[0].status).toEqual({ kind: "exception", label: "Exception" });
    expect(rows[0].problems[0]).toMatch(/received 70 PIECE/);
    expect(rows[0].conditionLabel).toBe("Short");
    // A line-level completion blocker outranks everything -- it is what
    // actually stops Send.
    expect(rows[1].status).toEqual({ kind: "needs_review", label: "Needs review" });
    expect(rows[1].problems[0]).toMatch(/Verified LB is required/);
  });

  it("an unresolved (unclassified) line reads Needs review with an Unresolved type -- never silently Ready", () => {
    const rows = buildFinalReviewRows({
      lines: [line({ lineKey: "mystery", description: "Mystery Line" })],
      summary: summaryWith({}),
      blockers: [],
    });
    expect(rows[0].typeLabel).toBe("Unresolved");
    expect(rows[0].matchedLabel).toBeNull();
    expect(rows[0].status.kind).toBe("needs_review");
  });

  it("document-level blockers (lineKey null, e.g. delivery verifier) never mark any LINE as blocked", () => {
    const rows = buildFinalReviewRows({
      lines: [line({})],
      summary: summaryWith({ items: [CONFIRMED_ITEM], receiving: [RECEIVED_LINE] }),
      blockers: [{ lineKey: null, description: null, reason: "Delivery verified by is required before sending for final review -- this document has inventory lines." }],
    });
    expect(rows[0].status.kind).toBe("ready"); // the doc-level blocker shows in the blockers panel, not per-line
  });

  it("falls back to measured quantity/unit for lines invoiced by weight rather than package count", () => {
    const rows = buildFinalReviewRows({
      lines: [line({ packageQuantity: null, packageUnit: null, measuredQuantity: 90.4, measuredUnit: "LB" })],
      summary: summaryWith({ items: [CONFIRMED_ITEM], receiving: [RECEIVED_LINE] }),
      blockers: [],
    });
    expect(rows[0].quantity).toBe(90.4);
    expect(rows[0].unit).toBe("LB");
  });
});
