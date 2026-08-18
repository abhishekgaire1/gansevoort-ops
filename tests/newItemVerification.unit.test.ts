import { describe, expect, it } from "vitest";
import { computeNewItemVerificationStatus, type NewItemVerificationFields } from "@/app/lib/itemMaster/newItemVerification";

/**
 * The New Item Review form's always-editable "VERIFY ITEM" button is
 * enabled/disabled entirely from this pure function -- these tests are the
 * automated coverage for that redesign (the modal itself always shows every
 * field, pre-filled from the AI's proposal, with no separate EDIT mode).
 */

const inventoryDefaults: NewItemVerificationFields = {
  name: "Korean Radish",
  disposition: "INVENTORY",
  categoryId: "cat-1",
  spendCategoryId: "spend-1",
  baseUnitCode: "LB",
  purchaseUnitCode: "",
  receivingBehavior: "SAME_UNIT",
  fixedConversionFactor: "",
};

describe("computeNewItemVerificationStatus", () => {
  it("allows immediate verification when the AI fully resolved every required field", () => {
    const status = computeNewItemVerificationStatus(inventoryDefaults);
    expect(status.missing).toEqual([]);
    expect(status.canVerify).toBe(true);
  });

  it("blocks verification when the AI could not resolve an inventory category", () => {
    const status = computeNewItemVerificationStatus({ ...inventoryDefaults, categoryId: "" });
    expect(status.canVerify).toBe(false);
    expect(status.missing).toContain("Inventory category");
  });

  it("enables verification once the manager fills the previously-missing category", () => {
    const missingCategory = computeNewItemVerificationStatus({ ...inventoryDefaults, categoryId: "" });
    expect(missingCategory.canVerify).toBe(false);

    const filledIn = computeNewItemVerificationStatus({ ...inventoryDefaults, categoryId: "cat-2" });
    expect(filledIn.canVerify).toBe(true);
    expect(filledIn.missing).toEqual([]);
  });

  it("blocks verification when the AI could not resolve a base unit", () => {
    const status = computeNewItemVerificationStatus({ ...inventoryDefaults, baseUnitCode: "" });
    expect(status.canVerify).toBe(false);
    expect(status.missing).toContain("Base inventory unit");
  });

  it("requires a name regardless of disposition", () => {
    const status = computeNewItemVerificationStatus({ ...inventoryDefaults, name: "   " });
    expect(status.canVerify).toBe(false);
    expect(status.missing).toContain("Item name");
  });

  it("requires no category or base unit for NON_INVENTORY items, but still requires a spend category", () => {
    const withoutSpendCategory = computeNewItemVerificationStatus({
      name: "Paper Napkins",
      disposition: "NON_INVENTORY",
      categoryId: "",
      spendCategoryId: "",
      baseUnitCode: "",
      purchaseUnitCode: "",
      receivingBehavior: "SAME_UNIT",
      fixedConversionFactor: "",
    });
    expect(withoutSpendCategory.canVerify).toBe(false);
    expect(withoutSpendCategory.missing).toEqual(["Spend category"]);

    const withSpendCategory = computeNewItemVerificationStatus({
      name: "Paper Napkins",
      disposition: "NON_INVENTORY",
      categoryId: "",
      spendCategoryId: "spend-1",
      baseUnitCode: "",
      purchaseUnitCode: "",
      receivingBehavior: "SAME_UNIT",
      fixedConversionFactor: "",
    });
    expect(withSpendCategory.canVerify).toBe(true);
    expect(withSpendCategory.missing).toEqual([]);
  });

  it("blocks verification of an otherwise-fully-resolved INVENTORY item when spend category is missing (never silently optional)", () => {
    const status = computeNewItemVerificationStatus({ ...inventoryDefaults, spendCategoryId: "" });
    expect(status.canVerify).toBe(false);
    expect(status.missing).toEqual(["Spend category"]);
  });

  it("does not require a fixed conversion factor when the purchase unit matches the base unit", () => {
    const status = computeNewItemVerificationStatus({ ...inventoryDefaults, purchaseUnitCode: "LB" });
    expect(status.usesDistinctPurchaseUnit).toBe(false);
    expect(status.canVerify).toBe(true);
  });

  it("requires a positive fixed conversion factor when the purchase unit differs and FIXED_CONVERSION is selected", () => {
    const noFactor = computeNewItemVerificationStatus({
      ...inventoryDefaults,
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: "",
    });
    expect(noFactor.needsConversionFactor).toBe(true);
    expect(noFactor.canVerify).toBe(false);
    expect(noFactor.missing).toContain("Fixed conversion factor");

    const zeroFactor = computeNewItemVerificationStatus({
      ...inventoryDefaults,
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: "0",
    });
    expect(zeroFactor.canVerify).toBe(false);

    const withFactor = computeNewItemVerificationStatus({
      ...inventoryDefaults,
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: "24",
    });
    expect(withFactor.canVerify).toBe(true);
  });

  it("does not require a fixed conversion factor for MEASURE_EACH_DELIVERY or COUNT_EACH_DELIVERY", () => {
    const measured = computeNewItemVerificationStatus({
      ...inventoryDefaults,
      purchaseUnitCode: "CASE",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
      fixedConversionFactor: "",
    });
    expect(measured.needsConversionFactor).toBe(false);
    expect(measured.canVerify).toBe(true);

    const counted = computeNewItemVerificationStatus({
      ...inventoryDefaults,
      purchaseUnitCode: "CASE",
      receivingBehavior: "COUNT_EACH_DELIVERY",
      fixedConversionFactor: "",
    });
    expect(counted.needsConversionFactor).toBe(false);
    expect(counted.canVerify).toBe(true);
  });
});
