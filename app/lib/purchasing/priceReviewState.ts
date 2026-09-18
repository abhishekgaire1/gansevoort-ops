import type { PriceComparisonResult } from "@/app/lib/purchasing/priceComparison";
import { classifyPriceChangeSeverity, PRICE_REVIEW_POLICY_VERSION, type PriceReviewState } from "@/app/lib/purchasing/priceReviewPolicy";

/**
 * Folds the authoritative normalized-price comparison
 * (PriceComparisonResult) together with any stored acknowledgment into the
 * single explicit PriceReviewState the whole UI + posting gate read from.
 * Pure and deterministic so the server (enforcement) and the client
 * (display) reach the identical verdict from the identical inputs.
 */

/** The inputs that, if any of them change, must invalidate a stored
 * acknowledgment and force a fresh review. The fingerprint is a stable
 * string over exactly these, so a changed quantity/amount/currency/vendor/
 * SKU/package/conversion/match -- all of which move currentUnitCost or the
 * comparable prior event -- yields a different fingerprint. */
export interface PriceComparisonFingerprintInputs {
  inventoryItemId: string;
  vendorId: string;
  vendorSku: string | null;
  currency: string | null;
  baseUnitCode: string | null;
  currentUnitCost: number;
  previousPurchaseDocumentId: string;
  previousUnitCost: number;
  policyVersion: string;
}

/** Round to 6 dp so ordinary float noise never spuriously invalidates a
 * still-identical comparison, while any real change still shifts it. */
function round6(n: number): string {
  return n.toFixed(6);
}

export function priceComparisonFingerprint(i: PriceComparisonFingerprintInputs): string {
  return [
    i.inventoryItemId,
    i.vendorId,
    i.vendorSku ?? "",
    (i.currency ?? "").toUpperCase(),
    i.baseUnitCode ?? "",
    round6(i.currentUnitCost),
    i.previousPurchaseDocumentId,
    round6(i.previousUnitCost),
    i.policyVersion,
  ].join("|");
}

export interface StoredPriceAcknowledgment {
  fingerprint: string;
  actorName: string | null;
  acknowledgedAt: string;
  note: string | null;
}

export interface LinePriceContext {
  inventoryItemId: string | null;
  vendorId: string | null;
  vendorSku: string | null;
  currency: string | null;
}

export interface PriceReviewResult {
  state: PriceReviewState;
  /** Present only when there is a comparable prior purchase (available). */
  comparison: Extract<PriceComparisonResult, { available: true }> | null;
  /** The current comparison fingerprint -- present only when comparable;
   * used to persist an acknowledgment and to detect a stale one. */
  fingerprint: string | null;
  /** The acknowledgment that currently applies (fingerprint matches). Null
   * when none, or when the stored one is stale (state falls back to
   * REQUIRES_ACKNOWLEDGMENT). */
  acknowledgment: StoredPriceAcknowledgment | null;
}

function unavailableState(reason: Extract<PriceComparisonResult, { available: false }>["reason"]): PriceReviewState {
  switch (reason) {
    case "NON_INVENTORY":
    case "UNRESOLVED":
    case "FREE_LINE":
    case "CREDIT_LINE":
      return "NOT_APPLICABLE";
    case "FIRST_PURCHASE":
      return "NO_COMPARABLE_HISTORY";
    case "NO_VENDOR":
    case "MISSING_LINE_TOTAL":
    case "MISSING_CONVERSION":
    case "AWAITING_RECEIVING_CONFIRMATION":
    case "CURRENCY_UNAVAILABLE":
      return "COMPARISON_UNAVAILABLE";
  }
}

export function derivePriceReviewState(input: {
  comparison: PriceComparisonResult;
  context: LinePriceContext;
  acknowledgment: StoredPriceAcknowledgment | null;
}): PriceReviewResult {
  const { comparison, context, acknowledgment } = input;

  if (!comparison.available) {
    return { state: unavailableState(comparison.reason), comparison: null, fingerprint: null, acknowledgment: null };
  }

  // Comparable. The fingerprint requires a resolved item + vendor; if the
  // context is somehow missing them we cannot safely persist/verify an
  // acknowledgment, so treat as unavailable rather than guess.
  if (!context.inventoryItemId || !context.vendorId) {
    return { state: "COMPARISON_UNAVAILABLE", comparison: null, fingerprint: null, acknowledgment: null };
  }

  const fingerprint = priceComparisonFingerprint({
    inventoryItemId: context.inventoryItemId,
    vendorId: context.vendorId,
    vendorSku: context.vendorSku,
    currency: context.currency,
    baseUnitCode: comparison.baseUnitCode,
    currentUnitCost: comparison.currentUnitCost,
    previousPurchaseDocumentId: comparison.previous.purchaseDocumentId,
    previousUnitCost: comparison.previous.unitCost,
    policyVersion: PRICE_REVIEW_POLICY_VERSION,
  });

  const severity = classifyPriceChangeSeverity(comparison.deltaPct);

  if (severity === "NONE") {
    return { state: "NO_MATERIAL_CHANGE", comparison, fingerprint, acknowledgment: null };
  }
  if (severity === "INFORMATIONAL") {
    return { state: "INFORMATIONAL_CHANGE", comparison, fingerprint, acknowledgment: null };
  }

  // SIGNIFICANT: acknowledged only when a stored ack matches the current
  // fingerprint exactly. A stale ack (any input changed) fails closed.
  const valid = acknowledgment !== null && acknowledgment.fingerprint === fingerprint;
  return {
    state: valid ? "ACKNOWLEDGED" : "REQUIRES_ACKNOWLEDGMENT",
    comparison,
    fingerprint,
    acknowledgment: valid ? acknowledgment : null,
  };
}
