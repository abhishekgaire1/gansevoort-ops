import type { LineClassificationRow } from "@/app/actions/itemClassification";
import type { LineReadinessInput } from "@/app/lib/purchaseDocuments/lineReadiness";

/**
 * Maps the authoritative classification read model to the readiness
 * evaluator's input -- ONE mapping shared by Step 1, Step 2, Step 3 and
 * the wizard, so every surface feeds evaluateLineReadiness identically.
 * Receiving / posting facts (only Step 2 has them live) are supplied by the
 * caller through `overrides`; everything else comes straight off the row.
 */
export function readinessInputFromRow(
  row: LineClassificationRow,
  overrides?: Partial<Pick<LineReadinessInput, "receivingReady" | "hasPostingBlocker" | "hasDeliveryConflict" | "priceRequiresAck" | "inventoryIncrease">>
): LineReadinessInput {
  return {
    lineKey: row.lineKey,
    status: row.status,
    treatment: row.lineTreatment,
    creditSubtype: row.creditSubtype,
    discountScope: row.discountScope,
    resolutionSource: row.resolutionSource,
    aiConfidence: row.aiConfidence,
    lineTotal: row.lineTotal,
    spendCategoryId: row.spendCategoryId,
    spendCategoryActive: row.spendCategoryActive,
    spendCategoryRequiresExplanation: row.spendCategoryRequiresExplanation,
    explanation: row.explanation,
    inventoryItemId: row.inventoryItemId,
    aiSuggestedInventoryItemId: row.aiSuggestedInventoryItemId,
    aiSuggestedIsNewProposal: row.aiSuggestedIsNewProposal,
    hasPackageMismatch: row.hasPackageMismatch,
    receivingReady: overrides?.receivingReady ?? null,
    hasPostingBlocker: overrides?.hasPostingBlocker ?? false,
    hasDeliveryConflict: overrides?.hasDeliveryConflict ?? false,
    priceRequiresAck: overrides?.priceRequiresAck ?? false,
    inventoryIncrease: overrides?.inventoryIncrease ?? null,
    returnQuantity: row.returnQuantity,
    returnUnitCode: row.returnUnitCode,
    returnLocationId: row.returnLocationId,
    returnReason: row.returnReason,
    returnImpactAcknowledged: row.returnImpactAcknowledged,
    returnBaseQuantity: row.returnBaseQuantity,
    returnBaseUnitCode: row.inventoryBaseUnitCode,
    returnOnHandQuantity: row.returnOnHandQuantity,
  };
}
