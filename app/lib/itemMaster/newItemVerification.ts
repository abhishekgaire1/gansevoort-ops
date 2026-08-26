/**
 * The New Item Review form's required-field completeness rule, pulled out
 * as a pure function so it's directly unit-testable -- this codebase has no
 * component-rendering test infrastructure (every existing test runs against
 * plain Node, not jsdom), so the logic that decides whether VERIFY ITEM is
 * enabled lives here instead of only inline inside the "use client" form.
 *
 * A canonical spend category is required for EVERY disposition (it's the
 * primary classification for NON_INVENTORY, and a required companion
 * attribute for INVENTORY) -- a name always; inventory category + base unit
 * only when disposition is INVENTORY; a positive fixed conversion factor
 * only when the vendor purchase unit differs from the base unit AND
 * FIXED_CONVERSION is selected. This is the client-side half of the rule
 * only -- approve_line_classification_new_item enforces spend category
 * server-side too (see 20260811100051), since client validation alone is
 * never sufficient.
 *
 * Purchase-versus-usage unit model (approved-plan §7) additions: an
 * OPTIONAL secondary kiosk usage unit, distinct from the item's base unit
 * (the always-present primary), with its own positive conversion factor.
 * Never required -- an empty secondaryUsageUnitCode is a fully valid,
 * one-unit item. Server-side, upsert_secondary_usage_unit
 * (20260811100114) re-checks the exact same distinctness/positivity rule
 * -- this is the client-side half only.
 */

export interface NewItemVerificationFields {
  name: string;
  disposition: "INVENTORY" | "NON_INVENTORY";
  categoryId: string;
  spendCategoryId: string;
  baseUnitCode: string;
  purchaseUnitCode: string;
  receivingBehavior: string;
  fixedConversionFactor: string;
  secondaryUsageUnitCode: string;
  secondaryConversionFactor: string;
}

export interface NewItemVerificationStatus {
  missing: string[];
  canVerify: boolean;
  usesDistinctPurchaseUnit: boolean;
  needsConversionFactor: boolean;
  hasSecondaryUsageUnit: boolean;
  /** True when the vendor purchase unit and the secondary kiosk usage
   * unit share the same global unit code but were confirmed with
   * different conversion factors -- a legitimate, deliberately supported
   * configuration (approved-plan §5: "vendor CASE" vs "kiosk CASE" can
   * mean different quantities), surfaced as a warning for the manager to
   * confirm rather than silently forced to match either way. */
  sameCodeDifferentFactorWarning: boolean;
}

export function computeNewItemVerificationStatus(fields: NewItemVerificationFields): NewItemVerificationStatus {
  const usesDistinctPurchaseUnit = fields.disposition === "INVENTORY" && fields.purchaseUnitCode !== "" && fields.purchaseUnitCode !== fields.baseUnitCode;
  const needsConversionFactor = usesDistinctPurchaseUnit && fields.receivingBehavior === "FIXED_CONVERSION";
  const hasSecondaryUsageUnit = fields.disposition === "INVENTORY" && fields.secondaryUsageUnitCode !== "";

  const missing: string[] = [];
  if (!fields.name.trim()) missing.push("Item name");
  if (fields.disposition === "INVENTORY" && !fields.categoryId) missing.push("Inventory category");
  if (fields.disposition === "INVENTORY" && !fields.baseUnitCode) missing.push("Base inventory unit");
  if (!fields.spendCategoryId) missing.push("Spend category");
  if (needsConversionFactor && (!fields.fixedConversionFactor.trim() || Number(fields.fixedConversionFactor) <= 0)) {
    missing.push("Fixed conversion factor");
  }
  if (hasSecondaryUsageUnit && fields.secondaryUsageUnitCode === fields.baseUnitCode) {
    missing.push("Secondary usage unit (must differ from the base unit)");
  }
  if (hasSecondaryUsageUnit && (!fields.secondaryConversionFactor.trim() || Number(fields.secondaryConversionFactor) <= 0)) {
    missing.push("Secondary usage unit conversion factor");
  }

  const sameCodeDifferentFactorWarning =
    hasSecondaryUsageUnit &&
    usesDistinctPurchaseUnit &&
    needsConversionFactor &&
    fields.secondaryUsageUnitCode === fields.purchaseUnitCode &&
    fields.secondaryConversionFactor.trim() !== "" &&
    fields.fixedConversionFactor.trim() !== "" &&
    Number(fields.secondaryConversionFactor) !== Number(fields.fixedConversionFactor);

  return { missing, canVerify: missing.length === 0, usesDistinctPurchaseUnit, needsConversionFactor, hasSecondaryUsageUnit, sameCodeDifferentFactorWarning };
}
