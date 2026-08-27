/**
 * Pure view-logic helpers for the simplified New Item Review screen
 * (progressive disclosure redesign). Framework-free, like
 * newItemVerification.ts and spendCategoryPaths.ts, so this is directly
 * unit-testable without a component-rendering test harness -- this repo
 * has none.
 *
 * None of these functions change any RPC/database behavior: they only
 * decide what the manager sees by default versus behind an explicit
 * "Edit" / "Advanced settings" affordance. The full underlying model
 * (inventory category, spend category, disposition, receiving behavior,
 * secondary usage unit fixed/measured mode) is always still present and
 * editable -- these helpers only decide default visibility.
 */

/** Below this AI confidence, the raw disposition dropdown (and other
 * uncertain fields) are shown by default instead of collapsed into a
 * simple label -- no such threshold existed elsewhere in the codebase,
 * so this is a new, deliberately conservative constant. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

function normalizeCategoryName(name: string): string {
  return name.trim().toLowerCase();
}

/** A spend category path looks like "Food > Produce > Root Vegetables" --
 * the leaf is the last segment, the part actually comparable to a flat
 * inventory category name. */
export function spendCategoryLeafName(spendCategoryPath: string): string {
  const segments = spendCategoryPath.split(">");
  return segments[segments.length - 1]!.trim();
}

/** True when the inventory category and spend category are, for the
 * manager's purposes, "the same" -- their names match case/whitespace-
 * insensitively. Both tables are independent (no FK/mapping column
 * between inventory_categories and spend_categories -- confirmed by
 * inspection of 20260811100004_inventory_master.sql and
 * 20260811100035_spend_categories_and_item_classification.sql), so this
 * is a UI-only heuristic, never a stored relationship. Either side
 * missing/unresolved means "not the same" -- there is nothing yet to
 * collapse into one field. */
export function categoriesMatch(inventoryCategoryName: string | null, spendCategoryPath: string | null): boolean {
  if (!inventoryCategoryName || !spendCategoryPath) return false;
  return normalizeCategoryName(inventoryCategoryName) === normalizeCategoryName(spendCategoryLeafName(spendCategoryPath));
}

/** Naive, display-only pluralization for a unit name inside a purchase
 * summary sentence (e.g. "500 pieces per case") -- never stored, never
 * used for any calculation. Deliberately simple: this repo's unit names
 * are short, common English words (Piece, Case, Pound, ...). */
function pluralizeUnitName(name: string, quantity: number): string {
  const lower = name.toLowerCase();
  if (quantity === 1) return lower;
  return lower.endsWith("s") ? lower : `${lower}s`;
}

export interface PurchaseSummaryInput {
  baseUnitCode: string | null;
  baseUnitName: string | null;
  purchaseUnitCode: string | null;
  purchaseUnitName: string | null;
  receivingBehavior: "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY" | null;
  fixedConversionFactor: number | null;
}

export interface PurchaseSummary {
  /** e.g. "Purchased as: Case" */
  headline: string;
  /** e.g. "500 pieces per case" -- null when there is nothing more to
   * say beyond the headline (SAME_UNIT, or a receiving behavior that
   * doesn't have single a fixed number to state). */
  detail: string | null;
}

/** Plain-language summary of "how this vendor sells it," derived from
 * already-resolved fields -- never a new stored fact. Returns null only
 * when there isn't enough resolved information yet to say anything
 * (no purchase/base unit at all), in which case the caller should fall
 * back to showing the raw controls. */
export function derivePurchaseSummary(input: PurchaseSummaryInput): PurchaseSummary | null {
  const baseLabel = input.baseUnitName ?? input.baseUnitCode;
  if (!baseLabel) return null;

  const usesDistinctPurchaseUnit = input.purchaseUnitCode !== null && input.purchaseUnitCode !== "" && input.purchaseUnitCode !== input.baseUnitCode;
  if (!usesDistinctPurchaseUnit) {
    return { headline: `Purchased as: ${baseLabel}`, detail: null };
  }

  const purchaseLabel = input.purchaseUnitName ?? input.purchaseUnitCode!;

  if (input.receivingBehavior === "FIXED_CONVERSION" && input.fixedConversionFactor !== null && input.fixedConversionFactor > 0) {
    const factor = input.fixedConversionFactor;
    return {
      headline: `Purchased as: ${purchaseLabel}`,
      detail: `${factor} ${pluralizeUnitName(baseLabel, factor)} per ${purchaseLabel.toLowerCase()}`,
    };
  }

  if (input.receivingBehavior === "MEASURE_EACH_DELIVERY") {
    return { headline: `Purchased as: ${purchaseLabel}`, detail: "Weight/volume measured at receiving each delivery" };
  }

  if (input.receivingBehavior === "COUNT_EACH_DELIVERY") {
    return { headline: `Purchased as: ${purchaseLabel}`, detail: "Count verified at receiving each delivery" };
  }

  // A distinct purchase unit with no receiving behavior resolved yet --
  // nothing safe to infer; the caller should fall back to raw controls.
  return null;
}

/** True when "How it is purchased" can be safely collapsed to the plain-
 * language summary above -- i.e. either the purchase unit matches the
 * base unit (SAME_UNIT), or a FIXED_CONVERSION factor is already
 * resolved and positive. MEASURE_EACH_DELIVERY / COUNT_EACH_DELIVERY are
 * summarizable via derivePurchaseSummary but still count as "inferred"
 * here since there's no ambiguous numeric factor to double check. */
export function isReceivingBehaviorInferred(input: {
  baseUnitCode: string | null;
  purchaseUnitCode: string | null;
  receivingBehavior: string | null;
  fixedConversionFactor: number | null;
}): boolean {
  const usesDistinctPurchaseUnit = input.purchaseUnitCode !== null && input.purchaseUnitCode !== "" && input.purchaseUnitCode !== input.baseUnitCode;
  if (!usesDistinctPurchaseUnit) return true;
  if (input.receivingBehavior === "FIXED_CONVERSION") return input.fixedConversionFactor !== null && input.fixedConversionFactor > 0;
  return input.receivingBehavior === "MEASURE_EACH_DELIVERY" || input.receivingBehavior === "COUNT_EACH_DELIVERY";
}

/** The raw disposition dropdown is only shown by default when the AI
 * wasn't confident, or the item is already NON_INVENTORY (a disposition
 * a manager picked deliberately, not something to hide behind a label). */
export function shouldShowDispositionControl(confidence: number | null, disposition: "INVENTORY" | "NON_INVENTORY"): boolean {
  if (disposition === "NON_INVENTORY") return true;
  return confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD;
}

export interface AdvancedSettingsAutoExpandInput {
  confidence: number | null;
  categoriesMatch: boolean;
  hasSecondaryUsageUnit: boolean;
  receivingBehaviorInferred: boolean;
  disposition: "INVENTORY" | "NON_INVENTORY";
}

/** Advanced Settings starts collapsed and stays that way unless one of
 * these conditions makes the simplified default view insufficient --
 * the manager can still open it manually at any time regardless. */
export function shouldAutoExpandAdvancedSettings(input: AdvancedSettingsAutoExpandInput): boolean {
  if (input.disposition === "NON_INVENTORY") return true;
  if (input.confidence !== null && input.confidence < LOW_CONFIDENCE_THRESHOLD) return true;
  if (!input.categoriesMatch) return true;
  if (input.hasSecondaryUsageUnit) return true;
  if (!input.receivingBehaviorInferred) return true;
  return false;
}
