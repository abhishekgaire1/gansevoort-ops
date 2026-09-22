import { describe, expect, it } from "vitest";
import { aiAssignmentLabel, confidenceBand, dispositionForTreatment, signedLineAmount, treatmentRequiresExpenseCategory, treatmentIsNonInventory, isLineTreatment, LINE_TREATMENT_CHOICES } from "@/app/lib/purchaseDocuments/lineTreatment";
import { ruleContradictsEvidence } from "@/app/lib/itemMaster/classifyPurchaseDocumentLines";
import { normalizeItemClassification } from "@/app/lib/ai/tasks/itemClassification/normalize";
import { validateItemClassification } from "@/app/lib/ai/tasks/itemClassification/validate";
import type { ClassificationCandidateContext } from "@/app/lib/ai/tasks/itemClassification/types";

const CONTEXT: ClassificationCandidateContext = {
  vendor: { name: "Bartlett Dairy", classification: "INVENTORY" },
  inventoryCategories: [{ id: "cat-dairy", name: "Dairy & Eggs" }],
  spendCategories: [
    { id: "spend-freight", path: "Freight, Delivery & Fuel Surcharges", description: null },
    { id: "spend-fees", path: "Vendor Fees & Service Charges", description: null },
    { id: "spend-repairs", path: "Repairs & Maintenance — Equipment", description: null },
  ],
  units: [{ code: "LB", name: "Pound" }],
  lineTreatments: [],
  creditSubtypes: [],
};
const noShortlists = new Map<string, never[]>();
const units = new Set(["LB"]);

describe("line treatment vocabulary and confidence policy", () => {
  it("exposes exactly six manager choices and maps to the legacy disposition", () => {
    expect(LINE_TREATMENT_CHOICES.map((c) => c.value)).toEqual(["INVENTORY_PURCHASE", "EXPENSE", "CREDIT_RETURN", "DISCOUNT", "TAX", "FREIGHT_FEE"]);
    expect(dispositionForTreatment("INVENTORY_PURCHASE")).toBe("INVENTORY");
    expect(dispositionForTreatment("TAX")).toBe("NON_INVENTORY");
    expect(dispositionForTreatment("UNRESOLVED")).toBe("UNRESOLVED");
    expect(isLineTreatment("CREDIT_RETNT")).toBe(false);
    expect(treatmentRequiresExpenseCategory("FREIGHT_FEE")).toBe(true);
    expect(treatmentRequiresExpenseCategory("TAX")).toBe(false);
    expect(treatmentIsNonInventory("DISCOUNT")).toBe(true);
    expect(treatmentIsNonInventory("UNRESOLVED")).toBe(false);
  });

  it("bands confidence at 0.90 / 0.70 and labels proposals accordingly", () => {
    expect(confidenceBand(0.95)).toBe("high");
    expect(confidenceBand(0.9)).toBe("high");
    expect(confidenceBand(0.89)).toBe("medium");
    expect(confidenceBand(0.43)).toBe("low");
    expect(confidenceBand(null)).toBeNull();
    expect(aiAssignmentLabel({ resolutionSource: "AI_SUGGESTED", status: "PENDING_REVIEW", confidence: 0.95 })).toBe("AI assigned");
    expect(aiAssignmentLabel({ resolutionSource: "AI_SUGGESTED", status: "PENDING_REVIEW", confidence: 0.8 })).toBe("Review recommended");
    expect(aiAssignmentLabel({ resolutionSource: "AI_SUGGESTED", status: "PENDING_REVIEW", confidence: 0.4 })).toBeNull();
    expect(aiAssignmentLabel({ resolutionSource: "VENDOR_TREATMENT_RULE", status: "PENDING_REVIEW", confidence: 1 })).toBe("Matched previous decision");
    expect(aiAssignmentLabel({ resolutionSource: "AI_ACCEPTED", status: "CONFIRMED", confidence: 0.95 })).toBe("AI assigned");
  });

  it("credits and discounts always reduce the invoice total, even when extracted positive", () => {
    expect(signedLineAmount("CREDIT_RETURN", 24)).toBe(-24);
    expect(signedLineAmount("CREDIT_RETURN", -24)).toBe(-24);
    expect(signedLineAmount("DISCOUNT", 10)).toBe(-10);
    expect(signedLineAmount("EXPENSE", 425)).toBe(425);
    expect(signedLineAmount("TAX", null)).toBeNull();
  });
});

describe("vendor rule evidence check", () => {
  it("never applies a credit rule to a positive amount or a charge rule to a negative one", () => {
    expect(ruleContradictsEvidence({ lineTreatment: "CREDIT_RETURN" }, { lineTotal: 24 })).toBe(true);
    expect(ruleContradictsEvidence({ lineTreatment: "CREDIT_RETURN" }, { lineTotal: -24 })).toBe(false);
    expect(ruleContradictsEvidence({ lineTreatment: "FREIGHT_FEE" }, { lineTotal: -5 })).toBe(true);
    expect(ruleContradictsEvidence({ lineTreatment: "FREIGHT_FEE" }, { lineTotal: 5 })).toBe(false);
    expect(ruleContradictsEvidence({ lineTreatment: "CREDIT_RETURN" }, { lineTotal: null })).toBe(false);
  });
});

describe("AI treatment contract -- normalize + validate", () => {
  const raw = (overrides: Record<string, unknown>) => ({
    lineKey: "l1",
    proposedLineTreatment: null,
    proposedCreditSubtype: null,
    proposedDiscountScope: null,
    candidateItemId: null,
    proposedName: null,
    suggestedInventoryCategoryId: null,
    suggestedSpendCategoryId: null,
    proposedBaseUnitCode: null,
    proposedVendorPurchaseUnitCode: null,
    proposedReceivingBehavior: null,
    proposedFixedConversionFactor: null,
    confidence: null,
    reasoning: null,
    evidence: null,
    fieldsRequiringReview: null,
    ...overrides,
  });

  it("freight maps to the Freight category and a vendor fee to Vendor Fees (tests 13/14), both without item fields", () => {
    const normalized = normalizeItemClassification({
      lines: [
        raw({ proposedLineTreatment: "FREIGHT_FEE", suggestedSpendCategoryId: "spend-freight", confidence: 0.96, reasoning: "Fuel surcharge", evidence: ["keyword FUEL SURCHARGE"] }),
        raw({ lineKey: "l2", proposedLineTreatment: "FREIGHT_FEE", suggestedSpendCategoryId: "spend-fees", confidence: 0.93, proposedName: "Service Charge", proposedBaseUnitCode: "LB" }),
      ],
    } as never);
    const { lines, issues } = validateItemClassification(normalized, noShortlists, units, CONTEXT);
    expect(lines[0]).toMatchObject({ proposedLineTreatment: "FREIGHT_FEE", proposedSpendCategoryId: "spend-freight", proposedDisposition: "NON_INVENTORY", evidence: ["keyword FUEL SURCHARGE"] });
    expect(lines[1]).toMatchObject({ proposedSpendCategoryId: "spend-fees", proposedName: null, proposedBaseUnitCode: null });
    expect(issues.map((i) => i.code)).toContain("ITEM_FIELDS_ON_NON_INVENTORY_LINE");
  });

  it("an invalid / foreign category id is stripped, never saved (test 4); tax carries no category (test 12)", () => {
    const normalized = normalizeItemClassification({
      lines: [
        raw({ proposedLineTreatment: "EXPENSE", suggestedSpendCategoryId: "spend-from-another-org", confidence: 0.97 }),
        raw({ lineKey: "l2", proposedLineTreatment: "TAX", suggestedSpendCategoryId: "spend-fees", confidence: 0.99 }),
        raw({ lineKey: "l3", proposedLineTreatment: "CREDIT_RETURN", proposedCreditSubtype: "RETURNABLE_CONTAINER_CREDIT", proposedName: "Cases Returned", confidence: 0.95 }),
      ],
    } as never);
    const { lines, issues } = validateItemClassification(normalized, noShortlists, units, CONTEXT);
    expect(lines[0].proposedSpendCategoryId).toBeNull();
    expect(issues.some((i) => i.code === "UNKNOWN_SPEND_CATEGORY_ID")).toBe(true);
    expect(lines[1]).toMatchObject({ proposedLineTreatment: "TAX", proposedSpendCategoryId: null });
    // CASES RETURNED never becomes an item proposal (test 6).
    expect(lines[2]).toMatchObject({ proposedLineTreatment: "CREDIT_RETURN", proposedCreditSubtype: "RETURNABLE_CONTAINER_CREDIT", proposedName: null, proposedDisposition: "NON_INVENTORY" });
  });

  it("a candidate item implies an inventory purchase; a low-confidence unresolved line keeps its reason", () => {
    const normalized = normalizeItemClassification({
      lines: [
        raw({ proposedLineTreatment: "EXPENSE", candidateItemId: "item-1", confidence: 0.9 }),
        raw({ lineKey: "l2", proposedLineTreatment: "UNRESOLVED", confidence: 0.43, reasoning: "Ambiguous abbreviation.", fieldsRequiringReview: ["treatment"] }),
      ],
    } as never);
    const { lines } = validateItemClassification(normalized, new Map([["l1", [{ id: "item-1", name: "Thing", categoryName: null, baseUnitCode: "LB" }]]]), units, CONTEXT);
    expect(lines[0]).toMatchObject({ proposedLineTreatment: "INVENTORY_PURCHASE", candidateItemId: "item-1", proposedDisposition: "INVENTORY" });
    expect(lines[1]).toMatchObject({ proposedLineTreatment: "UNRESOLVED", proposedDisposition: null, reasoning: "Ambiguous abbreviation.", fieldsRequiringReview: ["treatment"] });
  });
});
