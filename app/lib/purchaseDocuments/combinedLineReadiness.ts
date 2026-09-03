/**
 * Redesign: Steps 2 (Confirm Items) and 3 (Confirm Receiving) combined
 * into one "Confirm Items & Receiving" step. This is the SINGLE shared
 * per-line readiness decision -- drives the card's badge (Ready / Needs
 * attention / Expense), whether it auto-expands or collapses, the
 * page-level summary counts, and the combined step's own completion gate.
 * Never recomputed differently in more than one place (the redesign's own
 * explicit "one shared validation result" requirement).
 */

export type LineOutcome = "ready" | "needs_attention" | "expense";

export interface CombinedLineReadinessInput {
  status: "UNCLASSIFIED" | "PENDING_REVIEW" | "STALE" | "CONFIRMED";
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  /** True exactly when the confirmed purchase package disagrees with the
   * invoice unit -- see packageUnitMismatch.ts. */
  hasPackageMismatch: boolean;
  /** True once this line's receiving draft has everything required
   * (quantity, verified measurement if the package requires it, and a
   * destination location) -- see ReceivingPanel's own lineIsReady, reused
   * unchanged. Null when this line isn't an INVENTORY line at all (not
   * applicable -- never treated as blocking). */
  receivingReady: boolean | null;
}

export function classifyLineOutcome(input: CombinedLineReadinessInput): LineOutcome {
  if (input.status === "CONFIRMED" && input.disposition === "NON_INVENTORY") return "expense";
  if (input.status !== "CONFIRMED") return "needs_attention";
  if (input.disposition !== "INVENTORY") return "needs_attention";
  if (input.hasPackageMismatch) return "needs_attention";
  if (input.receivingReady !== true) return "needs_attention";
  return "ready";
}

export interface CombinedStepSummary {
  totalLines: number;
  readyCount: number;
  needsAttentionCount: number;
  expenseCount: number;
  /** True only when every line is ready or a correctly-classified expense
   * -- the combined step's own completion gate. */
  allResolved: boolean;
}

export interface ChecklistCompletionInput {
  status: "UNCLASSIFIED" | "PENDING_REVIEW" | "STALE" | "CONFIRMED";
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  hasPackageMismatch: boolean;
  receivingReady: boolean | null;
}

export interface ChecklistCompletion {
  itemMatchOk: boolean;
  packageOk: boolean;
  receivingReadyOk: boolean;
}

/** The per-panel "which of the three checks is actually done" breakdown
 * shown on an inventory line's card -- the SAME three facts
 * classifyLineOutcome already folds into a single ready/needs_attention
 * verdict, exposed separately here so a needs-attention card can point at
 * the specific incomplete check instead of a single undifferentiated
 * warning. Never a competing calculation: a line is "ready" exactly when
 * all three of these are true. */
export function checklistCompletion(input: ChecklistCompletionInput): ChecklistCompletion {
  const itemMatchOk = input.status === "CONFIRMED";
  const isInventory = itemMatchOk && input.disposition === "INVENTORY";
  return {
    itemMatchOk,
    packageOk: isInventory && !input.hasPackageMismatch,
    receivingReadyOk: isInventory && input.receivingReady === true,
  };
}

export function summarizeCombinedStep(outcomes: LineOutcome[]): CombinedStepSummary {
  const readyCount = outcomes.filter((o) => o === "ready").length;
  const expenseCount = outcomes.filter((o) => o === "expense").length;
  const needsAttentionCount = outcomes.filter((o) => o === "needs_attention").length;
  return {
    totalLines: outcomes.length,
    readyCount,
    needsAttentionCount,
    expenseCount,
    allResolved: outcomes.length > 0 && needsAttentionCount === 0,
  };
}
