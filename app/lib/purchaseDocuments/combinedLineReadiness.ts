import { evaluateLineReadiness, type LineReadinessInput } from "@/app/lib/purchaseDocuments/lineReadiness";

/**
 * Legacy adapter over lineReadiness.ts (the ONE authoritative per-line
 * readiness evaluation). Kept so callers that only know the coarse
 * disposition keep working; every new surface uses evaluateLineReadiness
 * directly with the full treatment input. Never a second calculation --
 * every function here delegates.
 */

export type LineOutcome = "ready" | "needs_attention" | "expense";

export interface CombinedLineReadinessInput {
  status: "UNCLASSIFIED" | "PENDING_REVIEW" | "STALE" | "CONFIRMED";
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  hasPackageMismatch: boolean;
  receivingReady: boolean | null;
  hasPostingBlocker?: boolean;
  hasDeliveryConflict?: boolean;
}

function toReadinessInput(input: CombinedLineReadinessInput): LineReadinessInput {
  return {
    lineKey: "legacy",
    status: input.status,
    treatment: input.disposition === "INVENTORY" ? "INVENTORY_PURCHASE" : input.disposition === "NON_INVENTORY" ? "EXPENSE" : "UNRESOLVED",
    creditSubtype: null,
    discountScope: null,
    resolutionSource: "MANUAL",
    aiConfidence: null,
    lineTotal: null,
    // The legacy caller has no category facts -- a CONFIRMED NON_INVENTORY
    // line was, by definition, a classified expense.
    spendCategoryId: input.disposition === "NON_INVENTORY" ? "legacy" : null,
    spendCategoryActive: true,
    spendCategoryRequiresExplanation: false,
    explanation: null,
    inventoryItemId: input.status === "CONFIRMED" && input.disposition === "INVENTORY" ? "legacy" : null,
    aiSuggestedInventoryItemId: null,
    aiSuggestedIsNewProposal: false,
    hasPackageMismatch: input.hasPackageMismatch,
    receivingReady: input.receivingReady,
    hasPostingBlocker: input.hasPostingBlocker,
    hasDeliveryConflict: input.hasDeliveryConflict,
    returnQuantity: null,
    returnUnitCode: null,
    returnLocationId: null,
    returnReason: null,
    returnImpactAcknowledged: false,
    returnBaseQuantity: null,
    returnBaseUnitCode: null,
    returnOnHandQuantity: null,
  };
}

export function classifyLineOutcome(input: CombinedLineReadinessInput): LineOutcome {
  const result = evaluateLineReadiness(toReadinessInput(input));
  if (!result.ready) return "needs_attention";
  return result.treatment === "INVENTORY_PURCHASE" ? "ready" : "expense";
}

export interface CombinedStepSummary {
  totalLines: number;
  readyCount: number;
  needsAttentionCount: number;
  expenseCount: number;
  allResolved: boolean;
}

export interface ChecklistCompletionInput {
  status: "UNCLASSIFIED" | "PENDING_REVIEW" | "STALE" | "CONFIRMED";
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  hasPackageMismatch: boolean;
  receivingReady: boolean | null;
  hasPostingBlocker?: boolean;
}

export interface ChecklistCompletion {
  itemMatchOk: boolean;
  packageOk: boolean;
  receivingReadyOk: boolean;
}

/** The three sub-checks of the SAME verdict, exposed so a needs-attention
 * card can point at the specific incomplete check. */
export function checklistCompletion(input: ChecklistCompletionInput): ChecklistCompletion {
  const itemMatchOk = input.status === "CONFIRMED";
  const isInventory = itemMatchOk && input.disposition === "INVENTORY";
  return {
    itemMatchOk,
    packageOk: isInventory && !input.hasPackageMismatch && !input.hasPostingBlocker,
    receivingReadyOk: isInventory && input.receivingReady === true,
  };
}

export function summarizeCombinedStep(outcomes: LineOutcome[]): CombinedStepSummary {
  const readyCount = outcomes.filter((o) => o === "ready").length;
  const expenseCount = outcomes.filter((o) => o === "expense").length;
  const needsAttentionCount = outcomes.filter((o) => o === "needs_attention").length;
  // Same rule as summarizeLineReadiness().allReady: an empty document is
  // never resolved, and one needs-attention line blocks the step.
  return { totalLines: outcomes.length, readyCount, needsAttentionCount, expenseCount, allResolved: outcomes.length > 0 && needsAttentionCount === 0 };
}
