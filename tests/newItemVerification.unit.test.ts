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
  secondaryUsageUnitCode: "",
  secondaryConversionFactor: "",
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
      secondaryUsageUnitCode: "",
      secondaryConversionFactor: "",
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
      secondaryUsageUnitCode: "",
      secondaryConversionFactor: "",
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

  // ---- Purchase-versus-usage unit model additions (approved-plan §7) ----

  it("treats a one-unit item (no secondary) as fully valid -- a secondary usage unit is never required", () => {
    const status = computeNewItemVerificationStatus(inventoryDefaults);
    expect(status.hasSecondaryUsageUnit).toBe(false);
    expect(status.canVerify).toBe(true);
  });

  it("blocks verification when the secondary usage unit is the same as the base unit", () => {
    const status = computeNewItemVerificationStatus({ ...inventoryDefaults, secondaryUsageUnitCode: "LB", secondaryConversionFactor: "10" });
    expect(status.hasSecondaryUsageUnit).toBe(true);
    expect(status.canVerify).toBe(false);
    expect(status.missing).toContain("Secondary usage unit (must differ from the base unit)");
  });

  it("requires a positive secondary conversion factor once a distinct secondary usage unit is chosen", () => {
    const noFactor = computeNewItemVerificationStatus({ ...inventoryDefaults, secondaryUsageUnitCode: "EACH", secondaryConversionFactor: "" });
    expect(noFactor.canVerify).toBe(false);
    expect(noFactor.missing).toContain("Secondary usage unit conversion factor");

    const zeroFactor = computeNewItemVerificationStatus({ ...inventoryDefaults, secondaryUsageUnitCode: "EACH", secondaryConversionFactor: "0" });
    expect(zeroFactor.canVerify).toBe(false);

    const withFactor = computeNewItemVerificationStatus({ ...inventoryDefaults, secondaryUsageUnitCode: "EACH", secondaryConversionFactor: "8" });
    expect(withFactor.canVerify).toBe(true);
    expect(withFactor.missing).toEqual([]);
  });

  it("never requires a secondary usage unit configuration for a NON_INVENTORY item", () => {
    const status = computeNewItemVerificationStatus({
      name: "Paper Napkins",
      disposition: "NON_INVENTORY",
      categoryId: "",
      spendCategoryId: "spend-1",
      baseUnitCode: "",
      purchaseUnitCode: "",
      receivingBehavior: "SAME_UNIT",
      fixedConversionFactor: "",
      secondaryUsageUnitCode: "CASE",
      secondaryConversionFactor: "",
    });
    expect(status.hasSecondaryUsageUnit).toBe(false);
    expect(status.canVerify).toBe(true);
  });

  it("warns when the vendor purchase unit and the secondary kiosk usage unit share a unit code but were confirmed with different factors", () => {
    const status = computeNewItemVerificationStatus({
      ...inventoryDefaults,
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: "24",
      secondaryUsageUnitCode: "CASE",
      secondaryConversionFactor: "12",
    });
    expect(status.sameCodeDifferentFactorWarning).toBe(true);
    // A warning is advisory, never blocking -- both sides are otherwise valid.
    expect(status.canVerify).toBe(true);
  });

  it("does not warn when the vendor purchase unit and the secondary kiosk usage unit share the same code AND the same confirmed factor", () => {
    const status = computeNewItemVerificationStatus({
      ...inventoryDefaults,
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: "24",
      secondaryUsageUnitCode: "CASE",
      secondaryConversionFactor: "24",
    });
    expect(status.sameCodeDifferentFactorWarning).toBe(false);
  });

  it("does not warn when the vendor purchase unit and the secondary usage unit use different codes", () => {
    const status = computeNewItemVerificationStatus({
      ...inventoryDefaults,
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: "24",
      secondaryUsageUnitCode: "EACH",
      secondaryConversionFactor: "1",
    });
    expect(status.sameCodeDifferentFactorWarning).toBe(false);
  });

  // ---- Weigh-at-kiosk restoration (20260811100126) additions ----

  it("defaults secondaryRequiresMeasurement to false (never measured) when omitted -- existing fixed-item callers are unaffected", () => {
    const status = computeNewItemVerificationStatus({ ...inventoryDefaults, secondaryUsageUnitCode: "EACH", secondaryConversionFactor: "" });
    expect(status.canVerify).toBe(false);
    expect(status.missing).toContain("Secondary usage unit conversion factor");
    expect(status.secondaryModeValid).toBe(false);
  });

  it("does not require a secondary conversion factor when the manager explicitly picks measured mode", () => {
    const status = computeNewItemVerificationStatus({
      ...inventoryDefaults,
      secondaryUsageUnitCode: "BOX",
      secondaryConversionFactor: "",
      secondaryRequiresMeasurement: true,
    });
    expect(status.canVerify).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.secondaryModeValid).toBe(true);
  });

  it("never suppresses the same-code-different-factor warning check by accident, but the warning cannot fire for a measured secondary (no factor to compare)", () => {
    const status = computeNewItemVerificationStatus({
      ...inventoryDefaults,
      purchaseUnitCode: "CASE",
      receivingBehavior: "FIXED_CONVERSION",
      fixedConversionFactor: "24",
      secondaryUsageUnitCode: "CASE",
      secondaryConversionFactor: "",
      secondaryRequiresMeasurement: true,
    });
    expect(status.sameCodeDifferentFactorWarning).toBe(false);
    expect(status.canVerify).toBe(true);
  });

  it("a one-unit item (no secondary) always reports a valid secondary mode", () => {
    const status = computeNewItemVerificationStatus(inventoryDefaults);
    expect(status.secondaryModeValid).toBe(true);
  });

  it("AI cannot bypass manager verification: canVerify is false whenever a required field is still unresolved, regardless of how confidently the AI proposed it -- there is no code path here that forces canVerify true without every requirement actually being met", () => {
    const unresolved = computeNewItemVerificationStatus({ ...inventoryDefaults, categoryId: "", spendCategoryId: "", baseUnitCode: "" });
    expect(unresolved.canVerify).toBe(false);
    // computeNewItemVerificationStatus is a pure predicate -- it never
    // performs the RPC call itself. Approving a classification always
    // requires a separate, explicit call to approveNewItemClassification
    // (see itemClassificationActions.unit.test.ts), never something this
    // module can trigger on its own.
  });
});
