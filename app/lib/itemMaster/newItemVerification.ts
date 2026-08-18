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
}

export interface NewItemVerificationStatus {
  missing: string[];
  canVerify: boolean;
  usesDistinctPurchaseUnit: boolean;
  needsConversionFactor: boolean;
}

export function computeNewItemVerificationStatus(fields: NewItemVerificationFields): NewItemVerificationStatus {
  const usesDistinctPurchaseUnit = fields.disposition === "INVENTORY" && fields.purchaseUnitCode !== "" && fields.purchaseUnitCode !== fields.baseUnitCode;
  const needsConversionFactor = usesDistinctPurchaseUnit && fields.receivingBehavior === "FIXED_CONVERSION";

  const missing: string[] = [];
  if (!fields.name.trim()) missing.push("Item name");
  if (fields.disposition === "INVENTORY" && !fields.categoryId) missing.push("Inventory category");
  if (fields.disposition === "INVENTORY" && !fields.baseUnitCode) missing.push("Base inventory unit");
  if (!fields.spendCategoryId) missing.push("Spend category");
  if (needsConversionFactor && (!fields.fixedConversionFactor.trim() || Number(fields.fixedConversionFactor) <= 0)) {
    missing.push("Fixed conversion factor");
  }

  return { missing, canVerify: missing.length === 0, usesDistinctPurchaseUnit, needsConversionFactor };
}
