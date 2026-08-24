import { describe, expect, it } from "vitest";
import { matchSourceLabel, formatSourceQuantity } from "@/app/lib/purchaseDocuments/matchSourcePresentation";
import type { LineClassificationRow } from "@/app/actions/itemClassification";

// CI-safe: no network, no database, no live Gemini call. Deterministic
// fixtures only (Part 63: "Use deterministic/mock AI responses in tests").

function baseLine(overrides: Partial<LineClassificationRow>): LineClassificationRow {
  return {
    classificationId: "classification-1",
    lineKey: "line-1",
    lineNumber: 1,
    vendorSku: "843920",
    description: "CHK THIGH BLS SKLS 40#",
    status: "CONFIRMED",
    disposition: "INVENTORY",
    resolutionSource: "MANUAL",
    inventoryItemId: "item-1",
    inventoryItemName: "Chicken Thigh Boneless Skinless",
    aiSuggestedInventoryItemId: null,
    aiSuggestedInventoryItemName: null,
    aiSuggestedIsNewProposal: false,
    aiConfidence: null,
    aiProposedPurchaseUnit: null,
    aiNewItemProposal: null,
    packageQuantity: 40,
    packageUnit: "LB",
    measuredQuantity: null,
    measuredUnit: null,
    lineTotal: 120,
    inventoryItemNumber: "ITEM-000184",
    inventoryCategoryName: "Meat & Poultry",
    inventoryBaseUnitCode: "LB",
    inventoryItemCreatedVia: "MANUAL",
    spendCategoryId: null,
    ...overrides,
  };
}

describe("matchSourceLabel", () => {
  it("labels a deterministic vendor-SKU mapping as a known, previously-approved mapping", () => {
    const line = baseLine({ resolutionSource: "VENDOR_SKU_MAPPING" });
    expect(matchSourceLabel(line)).toEqual({ label: "Known Mapping", sublabel: "Previously approved" });
  });

  it("labels a deterministic vendor-description mapping the same way", () => {
    const line = baseLine({ resolutionSource: "VENDOR_DESCRIPTION_MAPPING" });
    expect(matchSourceLabel(line)).toEqual({ label: "Known Mapping", sublabel: "Previously approved" });
  });

  it("labels an AI-suggested EXISTING item, once approved, as AI Suggested / Manager approved -- never bare 'Approved' with no AI attribution, and never implies AI itself approved it", () => {
    const line = baseLine({
      resolutionSource: "MANUAL",
      aiSuggestedInventoryItemId: "item-1",
      aiSuggestedInventoryItemName: "Chicken Thigh Boneless Skinless",
      aiConfidence: 0.94,
      inventoryItemCreatedVia: "MANUAL",
    });
    expect(matchSourceLabel(line)).toEqual({ label: "AI Suggested", sublabel: "Manager approved" });
  });

  it("labels a genuinely new item (AI-proposed, now confirmed) as New Item / Manager approved -- durable even though the item's own approval_status-derived isNewProposal flag would read false post-approval", () => {
    const line = baseLine({
      resolutionSource: "MANUAL",
      aiSuggestedInventoryItemId: "item-1",
      aiSuggestedInventoryItemName: "Chicken Thigh Boneless Skinless",
      aiConfidence: 0.87,
      inventoryItemCreatedVia: "AI_PROPOSED",
    });
    expect(matchSourceLabel(line)).toEqual({ label: "New Item", sublabel: "Manager approved" });
  });

  it("labels a fully manual pick (no AI suggestion involved at all, or manager overrode AI's suggestion to a different item) as plain Manager Approved", () => {
    const line = baseLine({ resolutionSource: "MANUAL", aiSuggestedInventoryItemId: null });
    expect(matchSourceLabel(line)).toEqual({ label: "Manager Approved", sublabel: "" });
  });

  it("a manual override AWAY from the AI's suggestion is never mislabeled as AI Suggested -- the confirmed item id must match the suggested one, not merely exist", () => {
    const line = baseLine({
      resolutionSource: "MANUAL",
      inventoryItemId: "item-2", // manager chose a DIFFERENT item than AI suggested
      aiSuggestedInventoryItemId: "item-1",
      aiSuggestedInventoryItemName: "Some other candidate",
      aiConfidence: 0.6,
    });
    expect(matchSourceLabel(line)).toEqual({ label: "Manager Approved", sublabel: "" });
  });

  it("labels a confirmed non-inventory line as Non-Inventory / Manager approved", () => {
    const line = baseLine({ disposition: "NON_INVENTORY", resolutionSource: "MANUAL", inventoryItemId: "expense-1", inventoryItemName: "Refrigerator Repair", spendCategoryId: "spend-1" });
    expect(matchSourceLabel(line)).toEqual({ label: "Non-Inventory", sublabel: "Manager approved" });
  });

  it("a known non-inventory mapping (deterministic tier) is still 'Known Mapping,' not 'Non-Inventory' -- the deterministic-tier check takes priority", () => {
    const line = baseLine({ disposition: "NON_INVENTORY", resolutionSource: "VENDOR_SKU_MAPPING", inventoryItemId: "expense-1" });
    expect(matchSourceLabel(line)).toEqual({ label: "Known Mapping", sublabel: "Previously approved" });
  });
});

describe("formatSourceQuantity", () => {
  it("prefers package quantity/unit when present", () => {
    expect(formatSourceQuantity(baseLine({ packageQuantity: 12, packageUnit: "CASE", measuredQuantity: 288, measuredUnit: "OZ" }))).toBe("12 CASE");
  });

  it("falls back to measured quantity/unit when no package figure exists", () => {
    expect(formatSourceQuantity(baseLine({ packageQuantity: null, packageUnit: null, measuredQuantity: 40, measuredUnit: "LB" }))).toBe("40 LB");
  });

  it("returns null rather than fabricating a unit when neither is available", () => {
    expect(formatSourceQuantity(baseLine({ packageQuantity: null, packageUnit: null, measuredQuantity: null, measuredUnit: null }))).toBeNull();
  });

  it("returns null when a quantity exists but its unit is missing -- never shows a bare number with an invented unit", () => {
    expect(formatSourceQuantity(baseLine({ packageQuantity: 12, packageUnit: null, measuredQuantity: null, measuredUnit: null }))).toBeNull();
  });
});
