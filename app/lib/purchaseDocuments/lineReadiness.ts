import {
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  aiAssignmentLabel,
  signedLineAmount,
  type CreditSubtype,
  type DiscountScope,
  type LineTreatment,
} from "@/app/lib/purchaseDocuments/lineTreatment";

/**
 * THE single authoritative per-line readiness result (client-safe, pure).
 * Every consumer -- Step 1's row status / issue count / sticky footer,
 * Step 2's grouping / row status / drawer / footer / progress text, the
 * Stepper, Step 3's access gate and summaries, the server-side
 * preparation preview (getPreparationStatus) and the pre-submit
 * acceptance -- reads THIS, never a second calculation. The database gate
 * (purchase_document_preparation_incomplete + post_purchase_document_
 * inventory, 20260811100182) is the enforcement boundary; this mirrors
 * its rules field-for-field so the UI never says "Ready" for a line the
 * server would refuse.
 *
 * Two facts per line:
 *   classificationSettled -- the treatment is decided (CONFIRMED, or a
 *     high-confidence proposal the manager accepts by continuing: the ONE
 *     central confidence policy, >= 0.90). Step 1's gate.
 *   ready -- every treatment-specific requirement is met, including
 *     receiving for an inventory purchase. Step 2 / Step 3 / posting gate.
 */

export type ReadinessGroup = "needs_attention" | "inventory" | "inventory_return" | "expense" | "credit_adjustment" | "tax_charge";
export type ReadinessStatus = "ready" | "ai_assigned" | "review_recommended" | "needs_classification" | "needs_attention";

export interface LineReadinessInput {
  lineKey: string;
  status: "UNCLASSIFIED" | "PENDING_REVIEW" | "STALE" | "CONFIRMED";
  treatment: LineTreatment;
  creditSubtype: CreditSubtype | null;
  discountScope: DiscountScope | null;
  resolutionSource: string | null;
  aiConfidence: number | null;
  lineTotal: number | null;
  // Expense / freight
  spendCategoryId: string | null;
  /** Null when unknown (category list not loaded) -- treated as active. */
  spendCategoryActive: boolean | null;
  spendCategoryRequiresExplanation: boolean;
  explanation: string | null;
  // Inventory purchase
  inventoryItemId: string | null;
  aiSuggestedInventoryItemId: string | null;
  aiSuggestedIsNewProposal: boolean;
  hasPackageMismatch: boolean;
  /** Null when not applicable / not loaded yet. */
  receivingReady: boolean | null;
  hasPostingBlocker?: boolean;
  hasDeliveryConflict?: boolean;
  priceRequiresAck?: boolean;
  /** The base-unit quantity a ready inventory purchase will add. */
  inventoryIncrease?: { quantity: number | null; unitCode: string | null } | null;
  // Inventory return
  returnQuantity: number | null;
  returnUnitCode: string | null;
  returnLocationId: string | null;
  returnReason: string | null;
  returnImpactAcknowledged: boolean;
  /** Server-resolved base quantity of the return (null = unit not configured). */
  returnBaseQuantity: number | null;
  returnBaseUnitCode: string | null;
  /** Server-resolved on-hand at the source location; null when unknown. */
  returnOnHandQuantity: number | null;
}

export interface InventoryEffect {
  kind: "increase" | "decrease" | "none";
  quantity: number | null;
  unitCode: string | null;
}

export interface LineReadiness {
  lineKey: string;
  treatment: LineTreatment;
  creditSubtype: CreditSubtype | null;
  group: ReadinessGroup;
  status: ReadinessStatus;
  statusLabel: string;
  /** Treatment decided (CONFIRMED or high-confidence acceptable). */
  classificationSettled: boolean;
  /** True exactly when a high-confidence proposal is still pending and
   * will be accepted by the manager's Continue / Post. */
  acceptable: boolean;
  /** Everything required for posting is present and valid. */
  ready: boolean;
  /** The one reason to show on a row; null when ready. */
  primaryIssue: string | null;
  /** Every reason, untruncated, for drawers. */
  issues: string[];
  inventoryEffect: InventoryEffect;
  /** Signed effect on the invoice total (credits/discounts negative). */
  financialAmount: number | null;
  aiLabel: ReturnType<typeof aiAssignmentLabel> | "AI proposed";
}

function treatmentFieldIssues(i: LineReadinessInput): string[] {
  const issues: string[] = [];
  switch (i.treatment) {
    case "EXPENSE":
    case "FREIGHT_FEE":
      if (!i.spendCategoryId) issues.push("Expense category is missing.");
      else if (i.spendCategoryActive === false) issues.push("Expense category is no longer active — choose another.");
      else if (i.spendCategoryRequiresExplanation && !(i.explanation ?? "").trim()) issues.push("A written explanation is required for this expense category.");
      break;
    case "DISCOUNT":
      if (!i.discountScope) issues.push("Choose whether this discount applies to a line or the whole document.");
      break;
    case "CREDIT_RETURN":
      if (!i.creditSubtype) issues.push("Did tracked inventory physically leave the store? Choose the credit type.");
      else if (i.creditSubtype === "INVENTORY_RETURN") {
        if (!i.inventoryItemId) issues.push("Choose the canonical item that was returned.");
        if (i.returnQuantity === null || i.returnQuantity <= 0) issues.push("Enter the returned quantity.");
        if (!i.returnUnitCode) issues.push("Choose the returned unit.");
        if (!i.returnLocationId) issues.push("Choose the source location the stock left from.");
        if (!(i.returnReason ?? "").trim()) issues.push("Enter a reason for the return.");
        if (!i.returnImpactAcknowledged) issues.push("Acknowledge the inventory decrease.");
        if (i.inventoryItemId && i.returnQuantity !== null && i.returnUnitCode && i.returnBaseQuantity === null) {
          issues.push(`Unit ${i.returnUnitCode} is not configured for this item — enter the return in its base unit.`);
        }
        if (i.returnBaseQuantity !== null && i.returnOnHandQuantity !== null && i.returnBaseQuantity > i.returnOnHandQuantity) {
          issues.push(`Returning ${i.returnBaseQuantity} ${i.returnBaseUnitCode ?? ""} exceeds the ${i.returnOnHandQuantity} ${i.returnBaseUnitCode ?? ""} on hand — inventory cannot go negative.`.replace(/\s+/g, " "));
        }
      }
      break;
    default:
      break;
  }
  return issues;
}

/** Mirrors line_classification_is_auto_acceptable (20260811100182). */
export function isAutoAcceptable(i: LineReadinessInput, fieldIssues: string[]): boolean {
  if (i.status !== "PENDING_REVIEW") return false;
  if (i.resolutionSource !== "AI_SUGGESTED" && i.resolutionSource !== "VENDOR_TREATMENT_RULE") return false;
  if ((i.aiConfidence ?? 0) < CONFIDENCE_HIGH) return false;
  switch (i.treatment) {
    case "EXPENSE":
    case "FREIGHT_FEE":
    case "TAX":
    case "DISCOUNT":
      return fieldIssues.length === 0;
    case "CREDIT_RETURN":
      return i.creditSubtype === "FINANCIAL_CREDIT" || i.creditSubtype === "RETURNABLE_CONTAINER_CREDIT";
    case "INVENTORY_PURCHASE":
      return i.aiSuggestedInventoryItemId !== null && !i.aiSuggestedIsNewProposal;
    default:
      return false;
  }
}

function groupForTreatment(treatment: LineTreatment, subtype: CreditSubtype | null): ReadinessGroup {
  switch (treatment) {
    case "INVENTORY_PURCHASE": return "inventory";
    case "EXPENSE":
    case "FREIGHT_FEE": return "expense";
    case "TAX": return "tax_charge";
    case "DISCOUNT": return "credit_adjustment";
    case "CREDIT_RETURN": return subtype === "INVENTORY_RETURN" ? "inventory_return" : "credit_adjustment";
    default: return "needs_attention";
  }
}

export function evaluateLineReadiness(i: LineReadinessInput): LineReadiness {
  const financialAmount = signedLineAmount(i.treatment, i.lineTotal);
  const rawAiLabel = aiAssignmentLabel({ resolutionSource: i.resolutionSource, status: i.status, confidence: i.aiConfidence });
  const fieldIssues = treatmentFieldIssues(i);
  const acceptable = isAutoAcceptable(i, fieldIssues);
  // A high-confidence proposal the policy will NOT accept on its own (an
  // inventory return, a new-item proposal, a missing category) is "AI
  // proposed", never "AI assigned" -- the manager still has to act.
  const aiLabel: LineReadiness["aiLabel"] = rawAiLabel === "AI assigned" && i.status !== "CONFIRMED" && !acceptable ? "AI proposed" : rawAiLabel;
  const base = { lineKey: i.lineKey, treatment: i.treatment, creditSubtype: i.creditSubtype, financialAmount, aiLabel };

  const inventoryEffect: InventoryEffect =
    i.treatment === "INVENTORY_PURCHASE"
      ? { kind: "increase", quantity: i.inventoryIncrease?.quantity ?? null, unitCode: i.inventoryIncrease?.unitCode ?? null }
      : i.treatment === "CREDIT_RETURN" && i.creditSubtype === "INVENTORY_RETURN"
        ? { kind: "decrease", quantity: i.returnBaseQuantity, unitCode: i.returnBaseUnitCode }
        : { kind: "none", quantity: null, unitCode: null };

  const notReady = (status: ReadinessStatus, statusLabel: string, issues: string[], settled: boolean, acceptable = false): LineReadiness => ({
    ...base,
    group: "needs_attention",
    status,
    statusLabel,
    classificationSettled: settled,
    acceptable,
    ready: false,
    primaryIssue: issues[0] ?? null,
    issues,
    inventoryEffect,
  });

  if (i.status === "UNCLASSIFIED" || i.treatment === "UNRESOLVED") {
    return notReady("needs_classification", "Needs classification", ["This line has not been classified. Choose how it should be treated."], false);
  }
  if (i.status === "STALE") {
    return notReady("needs_attention", "Needs attention", ["The invoice line changed after it was classified — confirm the classification again."], false);
  }

  const settled = i.status === "CONFIRMED" || acceptable;

  if (!settled) {
    if (i.treatment === "INVENTORY_PURCHASE") {
      if (i.aiSuggestedIsNewProposal) return notReady("needs_attention", "New item needs verification", ["New item needs verification before it can be received."], false);
      if (i.aiSuggestedInventoryItemId && (i.aiConfidence ?? 0) >= CONFIDENCE_MEDIUM) {
        return notReady("review_recommended", "Review recommended", ["Confirm the suggested item match — the AI was not certain enough to assign it automatically."], false);
      }
      return notReady("needs_attention", "Needs item match", ["No item match yet — choose the canonical item or change the classification."], false);
    }
    const reviewIssues = fieldIssues.length > 0 ? fieldIssues : ["Confirm the recommended classification — the AI was not certain enough to assign it automatically."];
    return notReady((i.aiConfidence ?? 0) >= CONFIDENCE_MEDIUM && fieldIssues.length === 0 ? "review_recommended" : "needs_attention", fieldIssues.length > 0 ? "Needs attention" : "Review recommended", reviewIssues, false);
  }

  if (fieldIssues.length > 0) return notReady("needs_attention", "Needs attention", fieldIssues, true, acceptable);

  if (i.treatment === "INVENTORY_PURCHASE") {
    const issues: string[] = [];
    if (i.hasDeliveryConflict) issues.push("Delivery records need review — the same delivery may have been recorded more than once.");
    if (i.hasPackageMismatch) issues.push("Purchase package needs review — the invoice unit does not match this vendor/SKU's confirmed package.");
    if (i.hasPostingBlocker) issues.push("Posting would refuse this line — review the purchase package and received unit.");
    if (i.receivingReady !== true) issues.push(acceptable ? "Accept the item match, then enter receiving details." : "Enter the received quantity, unit and destination.");
    if (i.priceRequiresAck) issues.push("A significant price change must be reviewed before posting.");
    if (issues.length > 0) return notReady("needs_attention", acceptable ? "AI assigned · receiving needed" : "Needs attention", issues, true, acceptable);
  }

  const status: ReadinessStatus = acceptable || (i.status === "CONFIRMED" && i.resolutionSource === "AI_ACCEPTED") ? "ai_assigned" : "ready";
  return {
    ...base,
    group: groupForTreatment(i.treatment, i.creditSubtype),
    status,
    statusLabel: status === "ai_assigned" ? "Ready · AI assigned" : "Ready",
    classificationSettled: true,
    acceptable,
    ready: true,
    primaryIssue: null,
    issues: [],
    inventoryEffect,
  };
}

export interface ReadinessSummary {
  totalLines: number;
  readyCount: number;
  needsAttentionCount: number;
  unresolvedCount: number;
  /** Lines whose classification is still open (Step 1's issue count). */
  unsettledCount: number;
  inventoryCount: number;
  inventoryReturnCount: number;
  expenseCount: number;
  creditAdjustmentCount: number;
  taxChargeCount: number;
  /** Every line is ready (posting gate) -- an empty document is never ready. */
  allReady: boolean;
  /** Every line's classification is settled (Step 1 gate). */
  allClassified: boolean;
  hasInventoryChanges: boolean;
  acceptableCount: number;
}

export function summarizeLineReadiness(results: LineReadiness[]): ReadinessSummary {
  const count = (pred: (r: LineReadiness) => boolean) => results.filter(pred).length;
  const readyCount = count((r) => r.ready);
  const needsAttentionCount = count((r) => !r.ready);
  return {
    totalLines: results.length,
    readyCount,
    needsAttentionCount,
    unresolvedCount: count((r) => r.status === "needs_classification"),
    unsettledCount: count((r) => !r.classificationSettled),
    inventoryCount: count((r) => r.treatment === "INVENTORY_PURCHASE"),
    inventoryReturnCount: count((r) => r.treatment === "CREDIT_RETURN" && r.creditSubtype === "INVENTORY_RETURN"),
    expenseCount: count((r) => r.treatment === "EXPENSE" || r.treatment === "FREIGHT_FEE"),
    creditAdjustmentCount: count((r) => r.treatment === "DISCOUNT" || (r.treatment === "CREDIT_RETURN" && r.creditSubtype !== "INVENTORY_RETURN")),
    taxChargeCount: count((r) => r.treatment === "TAX"),
    allReady: results.length > 0 && needsAttentionCount === 0,
    allClassified: results.length > 0 && results.every((r) => r.classificationSettled),
    hasInventoryChanges: results.some((r) => r.inventoryEffect.kind !== "none"),
    acceptableCount: count((r) => r.acceptable),
  };
}

/** Step 2's exception-first order: Needs Attention, Ready Inventory,
 * Inventory Returns, Expenses, Credits & Adjustments, Taxes & Charges. */
export const READINESS_GROUP_ORDER: ReadinessGroup[] = ["needs_attention", "inventory", "inventory_return", "expense", "credit_adjustment", "tax_charge"];

export const READINESS_GROUP_LABEL: Record<ReadinessGroup, string> = {
  needs_attention: "Needs attention",
  inventory: "Ready inventory",
  inventory_return: "Inventory returns",
  expense: "Expenses",
  credit_adjustment: "Credits & adjustments",
  tax_charge: "Taxes & charges",
};

/** Never "Post to inventory" for an expense-only invoice. */
export function postPrimaryLabel(hasInventoryChanges: boolean): "Post invoice & inventory" | "Post invoice" {
  return hasInventoryChanges ? "Post invoice & inventory" : "Post invoice";
}

export function issueCountLabel(count: number): string {
  return `${count} issue${count === 1 ? "" : "s"} remaining`;
}
