import { describe, expect, it } from "vitest";
import { validateItemClassification } from "@/app/lib/ai/tasks/itemClassification/validate";
import type { ClassificationCandidateContext, NormalizedItemClassificationLine } from "@/app/lib/ai/tasks/itemClassification/types";

/**
 * Proves the fix for a real accuracy gap found on a live Gansevoort DEV
 * invoice (a Sysco "Queso Fresco Cheese Wheel" line): the model must select
 * a category/spend-category by ID from the organization's own supplied
 * candidate list, never invent free text that then has to survive an exact
 * name match. These tests exercise validateItemClassification directly with
 * a realistic candidate context and simulated (stubbed) model output -- no
 * network, no database, no brittle exact-string assertions about what
 * Gemini itself would say.
 */

const CANDIDATE_CONTEXT: ClassificationCandidateContext = {
  inventoryCategories: [
    { id: "cat-produce", name: "Produce" },
    { id: "cat-meat", name: "Meat & Poultry" },
    { id: "cat-seafood", name: "Seafood" },
    { id: "cat-dairy", name: "Dairy & Eggs" },
    { id: "cat-frozen", name: "Frozen Foods" },
  ],
  spendCategories: [
    { id: "spend-produce", path: "Food & Beverage > Produce" },
    { id: "spend-seafood", path: "Food & Beverage > Seafood" },
    { id: "spend-dairy", path: "Food & Beverage > Dairy & Eggs" },
    { id: "spend-frozen", path: "Food & Beverage > Frozen Foods" },
  ],
  units: [
    { code: "LB", name: "Pound" },
    { code: "EACH", name: "Each" },
    { code: "CASE", name: "Case" },
  ],
};

function line(overrides: Partial<NormalizedItemClassificationLine> & { lineKey: string }): NormalizedItemClassificationLine {
  return {
    candidateItemId: null,
    proposedName: null,
    proposedDisposition: null,
    proposedCategoryId: null,
    proposedSpendCategoryId: null,
    proposedBaseUnitCode: null,
    proposedVendorPurchaseUnitCode: null,
    proposedReceivingBehavior: null,
    proposedFixedConversionFactor: null,
    confidence: null,
    reasoning: null,
    ...overrides,
  };
}

const knownUnitCodes = new Set(CANDIDATE_CONTEXT.units.map((u) => u.code));
const noShortlists = new Map<string, never[]>();

describe("validateItemClassification -- canonical candidate-id resolution", () => {
  it.each([
    { name: "Queso Fresco Cheese Wheel", categoryId: "cat-dairy", spendCategoryId: "spend-dairy" },
    { name: "Shrimp 16/20", categoryId: "cat-seafood", spendCategoryId: "spend-seafood" },
    { name: "French Fries 6mm", categoryId: "cat-frozen", spendCategoryId: "spend-frozen" },
    { name: "Korean Radish", categoryId: "cat-produce", spendCategoryId: "spend-produce" },
  ])("keeps a model-selected candidate id intact for $name when it is literally in the supplied candidate list", ({ name, categoryId, spendCategoryId }) => {
    const { lines, issues } = validateItemClassification(
      [
        line({
          lineKey: "line-1",
          proposedName: name,
          proposedDisposition: "INVENTORY",
          proposedCategoryId: categoryId,
          proposedSpendCategoryId: spendCategoryId,
          proposedBaseUnitCode: "LB",
        }),
      ],
      noShortlists,
      knownUnitCodes,
      CANDIDATE_CONTEXT
    );

    expect(issues).toEqual([]);
    expect(lines[0].proposedCategoryId).toBe(categoryId);
    expect(lines[0].proposedSpendCategoryId).toBe(spendCategoryId);
    expect(lines[0].proposedBaseUnitCode).toBe("LB");
  });

  it("strips a category id that was not in the supplied candidate list, never silently guessing or accepting it", () => {
    const { lines, issues } = validateItemClassification(
      [
        line({
          lineKey: "line-1",
          proposedName: "Mystery Item",
          proposedDisposition: "INVENTORY",
          proposedCategoryId: "cat-hallucinated",
          proposedBaseUnitCode: "LB",
        }),
      ],
      noShortlists,
      knownUnitCodes,
      CANDIDATE_CONTEXT
    );

    expect(lines[0].proposedCategoryId).toBeNull();
    expect(issues).toEqual([expect.objectContaining({ lineKey: "line-1", code: "UNKNOWN_INVENTORY_CATEGORY_ID" })]);
  });

  it("strips a spend category id that was not in the supplied candidate list", () => {
    const { lines, issues } = validateItemClassification(
      [line({ lineKey: "line-1", proposedName: "Mystery Item", proposedDisposition: "NON_INVENTORY", proposedSpendCategoryId: "spend-hallucinated" })],
      noShortlists,
      knownUnitCodes,
      CANDIDATE_CONTEXT
    );

    expect(lines[0].proposedSpendCategoryId).toBeNull();
    expect(issues).toEqual([expect.objectContaining({ lineKey: "line-1", code: "UNKNOWN_SPEND_CATEGORY_ID" })]);
  });

  it("supports a distinct vendor purchase unit (CASE) from the base unit (LB) with MEASURE_EACH_DELIVERY, exactly the Queso Fresco shape (1 CS, explicit variable T/WT)", () => {
    const { lines, issues } = validateItemClassification(
      [
        line({
          lineKey: "line-1",
          proposedName: "Queso Fresco Cheese Wheel",
          proposedDisposition: "INVENTORY",
          proposedCategoryId: "cat-dairy",
          proposedSpendCategoryId: "spend-dairy",
          proposedBaseUnitCode: "LB",
          proposedVendorPurchaseUnitCode: "CASE",
          proposedReceivingBehavior: "MEASURE_EACH_DELIVERY",
        }),
      ],
      noShortlists,
      knownUnitCodes,
      CANDIDATE_CONTEXT
    );

    expect(issues).toEqual([]);
    expect(lines[0].proposedBaseUnitCode).toBe("LB");
    expect(lines[0].proposedVendorPurchaseUnitCode).toBe("CASE");
    expect(lines[0].proposedReceivingBehavior).toBe("MEASURE_EACH_DELIVERY");
    expect(lines[0].proposedFixedConversionFactor).toBeNull();
  });

  it("never defaults the vendor purchase unit to the base unit merely because both were resolved -- SAME_UNIT must be explicit", () => {
    const { lines } = validateItemClassification(
      [
        line({
          lineKey: "line-1",
          proposedName: "Bottled Water",
          proposedDisposition: "INVENTORY",
          proposedCategoryId: "cat-produce",
          proposedBaseUnitCode: "EACH",
          proposedVendorPurchaseUnitCode: null,
          proposedReceivingBehavior: null,
        }),
      ],
      noShortlists,
      knownUnitCodes,
      CANDIDATE_CONTEXT
    );

    expect(lines[0].proposedVendorPurchaseUnitCode).toBeNull();
    expect(lines[0].proposedReceivingBehavior).toBeNull();
  });
});
