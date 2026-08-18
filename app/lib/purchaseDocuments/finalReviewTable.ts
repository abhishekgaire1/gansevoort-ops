// Deliberately NOT "server-only" -- a pure merge over data Step 4 already
// has (the current draft lines plus the authoritative review summary and
// preparation blockers), shared with the client component and directly
// unit-testable. It invents NO business facts: pricing/quantities come
// from the invoice lines exactly as they will be submitted, item/receiving
// facts from getPurchaseDocumentReviewSummary (current classifications +
// EFFECTIVE receipts), and per-line problems from the same
// getPreparationStatus blockers that gate Send itself.

import type { PurchaseDocumentLine } from "@/app/lib/purchaseDocuments/types";
import type { PurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";
import type { PreparationBlocker } from "@/app/lib/purchaseDocuments/preparationBlockers";
import { lineLevelBlockers } from "@/app/lib/purchaseDocuments/preparationBlockers";

export type FinalReviewRowStatus =
  | { kind: "ready"; label: "Ready" }
  | { kind: "needs_review"; label: "Needs review" }
  | { kind: "exception"; label: "Exception" };

export interface FinalReviewRow {
  lineKey: string | null;
  /** Inventory / Non-inventory / Unresolved (classification pending). */
  type: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  typeLabel: string;
  sku: string | null;
  description: string | null;
  /** Canonical item for inventory lines; spend category (or plain
   * "Non-inventory") for non-inventory lines; em-dash-worthy null while
   * unresolved. */
  matchedLabel: string | null;
  /** Muted secondary context under the item cell -- category, base unit,
   * receiving behavior, spend category -- shown once, never as separate
   * repeated sections. */
  secondary: string | null;
  // Invoice/commercial facts -- exactly what will be submitted.
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  // Receiving facts (effective receipts) -- null-labeled for non-inventory.
  receivedLabel: string | null;
  inventoryQuantityLabel: string | null;
  locationName: string | null;
  conditionLabel: string | null;
  status: FinalReviewRowStatus;
  /** The exact per-line problems (blocker reasons + exception messages)
   * backing a non-ready status -- for tooltips/summary, never recomputed. */
  problems: string[];
}

const RECEIVING_BEHAVIOR_LABEL: Record<string, string> = {
  SAME_UNIT: "Same unit",
  FIXED_CONVERSION: "Fixed conversion",
  MEASURE_EACH_DELIVERY: "Measured each delivery",
  COUNT_EACH_DELIVERY: "Counted each delivery",
};

function conditionLabel(conditionStatus: string | null): string | null {
  if (conditionStatus === null) return null;
  if (conditionStatus === "RECEIVED_AS_INVOICED") return "As invoiced";
  return conditionStatus.charAt(0) + conditionStatus.slice(1).toLowerCase().replace(/_/g, " ");
}

function quantityUnit(quantity: number | null, unit: string | null): string | null {
  if (quantity === null) return null;
  return unit ? `${quantity} ${unit}` : String(quantity);
}

export function buildFinalReviewRows(input: {
  lines: PurchaseDocumentLine[];
  summary: PurchaseDocumentReviewSummary | null;
  blockers: PreparationBlocker[];
}): FinalReviewRow[] {
  const itemByLineKey = new Map((input.summary?.items ?? []).map((item) => [item.lineKey, item]));
  const receivingByLineKey = new Map((input.summary?.receiving ?? []).map((line) => [line.lineKey, line]));
  const exceptionsByLineKey = new Map<string, string[]>();
  for (const exception of input.summary?.exceptions ?? []) {
    if (!exceptionsByLineKey.has(exception.lineKey)) exceptionsByLineKey.set(exception.lineKey, []);
    exceptionsByLineKey.get(exception.lineKey)!.push(exception.message);
  }
  const blockersByLineKey = new Map<string, string[]>();
  for (const blocker of lineLevelBlockers(input.blockers)) {
    if (blocker.lineKey === null) continue;
    if (!blockersByLineKey.has(blocker.lineKey)) blockersByLineKey.set(blocker.lineKey, []);
    blockersByLineKey.get(blocker.lineKey)!.push(blocker.reason);
  }

  return input.lines.map((line) => {
    const item = line.lineKey ? itemByLineKey.get(line.lineKey) : undefined;
    const receiving = line.lineKey ? receivingByLineKey.get(line.lineKey) : undefined;
    const lineBlockers = line.lineKey ? (blockersByLineKey.get(line.lineKey) ?? []) : [];
    const lineExceptions = line.lineKey ? (exceptionsByLineKey.get(line.lineKey) ?? []) : [];

    const type = item?.disposition ?? "UNRESOLVED";
    const isInventory = type === "INVENTORY";

    const matchedLabel = isInventory
      ? (item?.canonicalItemName ?? null)
      : type === "NON_INVENTORY"
        ? (item?.spendCategoryPath ?? "Non-inventory")
        : null;

    const secondaryParts = isInventory
      ? [item?.categoryName ?? null, item?.baseUnitCode ?? null, item?.receivingBehavior ? RECEIVING_BEHAVIOR_LABEL[item.receivingBehavior] : null]
      : [];
    const secondary = secondaryParts.filter(Boolean).join(" · ") || null;

    // Inventory Qty: the base-unit quantity that would actually enter
    // inventory -- the fixed-conversion derivation where relevant, or the
    // manager-verified actual for measured items. Blank when it would just
    // repeat the received quantity.
    const inventoryQuantityLabel = receiving
      ? receiving.inventoryQuantity !== null
        ? quantityUnit(receiving.inventoryQuantity, receiving.verifiedUnit)
        : receiving.requiresVerifiedMeasurement
          ? quantityUnit(receiving.verifiedQuantity, receiving.verifiedUnit)
          : null
      : null;

    const problems = [...lineBlockers, ...lineExceptions];
    const status: FinalReviewRowStatus =
      lineBlockers.length > 0 || !item || item.status !== "CONFIRMED"
        ? { kind: "needs_review", label: "Needs review" }
        : lineExceptions.length > 0
          ? { kind: "exception", label: "Exception" }
          : { kind: "ready", label: "Ready" };

    return {
      lineKey: line.lineKey,
      type,
      typeLabel: type === "INVENTORY" ? "Inventory" : type === "NON_INVENTORY" ? "Non-inventory" : "Unresolved",
      sku: line.vendorSku,
      description: line.description,
      matchedLabel,
      secondary,
      quantity: line.packageQuantity ?? line.measuredQuantity,
      unit: line.packageQuantity !== null ? line.packageUnit : line.measuredUnit,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      receivedLabel: receiving ? quantityUnit(receiving.receivedQuantity, receiving.receivedUnit) : null,
      inventoryQuantityLabel,
      locationName: receiving?.locationName ?? null,
      conditionLabel: receiving ? conditionLabel(receiving.conditionStatus) : null,
      status,
      problems,
    };
  });
}
