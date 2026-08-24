import type { NormalizedInvoiceExtraction, NormalizedInvoiceLine, ReviewFlag } from "./types";
import { formatMoney } from "@/app/lib/formatMoney";

/**
 * Deterministic, non-AI validation of an already-normalized extraction.
 * Gemini is never the final validator -- this is. Pure function: never
 * mutates its input, never writes anywhere (there is no database in
 * Milestone 2A.0 to write an exception to; it only returns flags for a
 * human to review).
 */

const ABSOLUTE_TOLERANCE = 0.02; // 2 cents
const RELATIVE_TOLERANCE = 0.01; // 1%, for larger amounts where a flat cent tolerance is too strict

function approximatelyEqual(a: number, b: number): boolean {
  const tolerance = Math.max(ABSOLUTE_TOLERANCE, Math.abs(b) * RELATIVE_TOLERANCE);
  return Math.abs(a - b) <= tolerance;
}

function unitsMatch(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Recognizes a legitimate credit/return line from its OWN numbers alone --
 * no new AI-predicted per-line field required, no line "kind" taxonomy to
 * maintain. A line only qualifies when BOTH its package quantity and its
 * line total are negative AND, when a unit price is also known, the
 * arithmetic actually reconciles (qty x unitPrice = lineTotal) -- the same
 * "arithmetic is internally consistent" signal that distinguishes a real
 * credit (qty -2, unit price $32, total -$64) from a genuinely suspicious
 * line (qty -200, amount +$500, ordinary purchase description) where the
 * signs disagree. A line with only ONE of the two negative is never
 * recognized here -- that inconsistency is exactly what should still
 * surface for manual review, not be silently accepted as a credit.
 */
export function isRecognizedCreditLine(line: Pick<NormalizedInvoiceLine, "packageQuantity" | "unitPrice" | "lineTotal">): boolean {
  const quantityNegative = line.packageQuantity !== null && line.packageQuantity < 0;
  const totalNegative = line.lineTotal !== null && line.lineTotal < 0;
  if (!quantityNegative || !totalNegative) return false;
  if (line.unitPrice !== null && line.packageQuantity !== null && line.lineTotal !== null) {
    const expected = line.packageQuantity * line.unitPrice;
    if (!approximatelyEqual(expected, line.lineTotal)) return false;
  }
  return true;
}

export interface AccountBalanceSignal {
  /** What THIS document's own lines/tax/fees actually add up to -- the
   * value that belongs in `total` for reconciliation, reporting, and
   * posting purposes. */
  currentDocumentTotal: number;
  /** The larger, unreconciled figure the document itself stated as its
   * bottom line -- likely an account-balance/amount-due figure that
   * includes more than this one document. */
  statedTotal: number;
  /** True when the AI itself separately reported this same figure as
   * `amountDue` (high confidence) -- false when this is purely an
   * arithmetic inference with no corroborating structured signal (lower
   * confidence, surfaced as a softer warning rather than an info note). */
  confirmedByExtraction: boolean;
}

/**
 * Deterministic (no AI required) detection of "this document's stated
 * total is probably an account balance, not this document's own total" --
 * shared by both the AI-extraction-time validator below and
 * validatePurchaseDocumentDraft.ts's live draft validation, so the two
 * never drift into different reconciliation rules.
 *
 * Fires only when the stated total is LARGER than the computed sum of
 * this document's own lines (+ tax/fees) by more than the normal
 * reconciliation tolerance -- a total SMALLER than the lines is a
 * different, more suspicious anomaly and is never treated as "includes a
 * prior balance." Returns null in every case where the ordinary
 * INVOICE_TOTAL_MISMATCH / TOTAL_MISMATCH warning should still apply
 * unchanged (Part 24: normal-invoice regression safety).
 */
export function detectAccountBalanceSignal(input: {
  lines: { lineTotal: number | null }[];
  tax: number | null;
  fees: number | null;
  total: number;
  /** The AI's own separately-reported amountDue, when available (null for
   * draft-time validation, which has no access to the original
   * extraction). */
  amountDue?: number | null;
}): AccountBalanceSignal | null {
  const sumOfLines = input.lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);
  const computedTotal = sumOfLines + (input.tax ?? 0) + (input.fees ?? 0);
  if (approximatelyEqual(computedTotal, input.total)) return null; // reconciles fine -- no signal
  if (input.total <= computedTotal) return null; // smaller/equal total is a different anomaly, never "includes prior balance"

  if (input.amountDue != null) {
    if (!approximatelyEqual(input.amountDue, input.total)) return null; // AI reported a DIFFERENT amountDue than total -- don't guess, let the ordinary mismatch check run
    return { currentDocumentTotal: computedTotal, statedTotal: input.total, confirmedByExtraction: true };
  }
  return { currentDocumentTotal: computedTotal, statedTotal: input.total, confirmedByExtraction: false };
}

export function validateInvoiceExtraction(extraction: NormalizedInvoiceExtraction): {
  data: NormalizedInvoiceExtraction;
  issues: ReviewFlag[];
} {
  const issues: ReviewFlag[] = [];

  if (!extraction.vendorName) {
    issues.push({ severity: "error", code: "MISSING_VENDOR_NAME", message: "Vendor name was not found." });
  }
  if (!extraction.invoiceNumber) {
    issues.push({ severity: "error", code: "MISSING_INVOICE_NUMBER", message: "Invoice number was not found." });
  }
  if (!extraction.invoiceDate) {
    issues.push({ severity: "error", code: "MISSING_INVOICE_DATE", message: "Invoice date was not found." });
  }
  if (extraction.total === null) {
    issues.push({ severity: "error", code: "MISSING_TOTAL", message: "Invoice total was not found." });
  }

  if (extraction.lines.length === 0) {
    issues.push({ severity: "warning", code: "NO_LINE_ITEMS", message: "No line items were extracted." });
  }

  extraction.lines.forEach((line, index) => {
    issues.push(...validateLineItem(line, index, extraction.currency));
  });

  if (extraction.total !== null && extraction.lines.length > 0) {
    const allLineTotalsKnown = extraction.lines.every((line) => line.lineTotal !== null);
    if (allLineTotalsKnown) {
      const signal = detectAccountBalanceSignal({
        lines: extraction.lines,
        tax: extraction.tax,
        fees: extraction.fees,
        total: extraction.total,
        amountDue: extraction.amountDue,
      });
      if (signal) {
        issues.push({
          severity: signal.confirmedByExtraction ? "info" : "warning",
          code: signal.confirmedByExtraction ? "TOTAL_INCLUDES_ACCOUNT_BALANCE" : "TOTAL_MAY_INCLUDE_ACCOUNT_BALANCE",
          field: "total",
          message: signal.confirmedByExtraction
            ? `This document's own lines, tax, and fees total ${formatMoney(signal.currentDocumentTotal, extraction.currency)} -- the invoice's TOTAL of ${formatMoney(signal.statedTotal, extraction.currency)} includes a prior account balance, not just this document.`
            : `This document's own lines, tax, and fees total ${formatMoney(signal.currentDocumentTotal, extraction.currency)}, but the invoice's TOTAL is ${formatMoney(signal.statedTotal, extraction.currency)} -- it may include a prior account balance rather than being purely this document's own total. Confirm or correct the Total field if this document's own total should be ${formatMoney(signal.currentDocumentTotal, extraction.currency)}.`,
        });
      } else {
        const sumOfLines = extraction.lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);
        const computedTotal = sumOfLines + (extraction.tax ?? 0) + (extraction.fees ?? 0);
        if (!approximatelyEqual(computedTotal, extraction.total)) {
          issues.push({
            severity: "warning",
            code: "INVOICE_TOTAL_MISMATCH",
            field: "total",
            message: `Line totals + tax + fees (${formatMoney(computedTotal, extraction.currency)}) do not match the extracted total (${formatMoney(extraction.total, extraction.currency)}).`,
          });
        }
      }
    }
  }

  return { data: extraction, issues };
}

/**
 * Exported (Milestone 2A.2) so app/lib/purchaseDocuments/validatePurchaseDocumentDraft.ts
 * can reuse this line-math/unit logic for a purchase document draft's
 * lines -- it doesn't care whether the document is an invoice, receipt, or
 * credit memo, so it's shared rather than duplicated. Header-level checks
 * stay type-aware and live in that module instead, since "Invoice #" vs.
 * "Receipt #" vs. "Credit Memo #" genuinely differ by document type.
 */
export function validateLineItem(line: NormalizedInvoiceLine, index: number, currency?: string | null): ReviewFlag[] {
  const issues: ReviewFlag[] = [];
  const prefix = `lines[${index}]`;

  if (!line.description) {
    issues.push({ severity: "warning", code: "LINE_MISSING_DESCRIPTION", field: `${prefix}.description`, message: `Line ${index + 1} has no description.` });
  }

  // A recognized credit/return line (Part 9-11 of the credit-line spec)
  // gets an informational note instead of the two negative-value errors
  // below -- both its package quantity AND its line total are legitimately
  // negative, and they reconcile with each other. A line where only ONE
  // of the two is negative is NOT recognized here and still falls through
  // to the ordinary error checks, exactly as before.
  if (isRecognizedCreditLine(line)) {
    issues.push({
      severity: "info",
      code: "LINE_RECOGNIZED_AS_CREDIT",
      field: `${prefix}.lineTotal`,
      message: `${line.description ?? `Line ${index + 1}`} is recognized as a credit/return (negative quantity and amount agree).`,
    });
  } else {
    if (line.packageQuantity !== null && line.packageQuantity < 0) {
      issues.push({ severity: "error", code: "LINE_NEGATIVE_PACKAGE_QUANTITY", field: `${prefix}.packageQuantity`, message: `Line ${index + 1} has a negative package quantity.` });
    }
    if (line.lineTotal !== null && line.lineTotal < 0) {
      issues.push({ severity: "error", code: "LINE_NEGATIVE_TOTAL", field: `${prefix}.lineTotal`, message: `Line ${index + 1} has a negative line total.` });
    }
  }
  if (line.measuredQuantity !== null && line.measuredQuantity < 0) {
    issues.push({ severity: "error", code: "LINE_NEGATIVE_MEASURED_QUANTITY", field: `${prefix}.measuredQuantity`, message: `Line ${index + 1} has a negative measured quantity.` });
  }
  if (line.unitPrice !== null && line.unitPrice < 0) {
    issues.push({ severity: "error", code: "LINE_NEGATIVE_UNIT_PRICE", field: `${prefix}.unitPrice`, message: `Line ${index + 1} has a negative unit price.` });
  }

  if (line.packageQuantity !== null && !line.packageUnit) {
    issues.push({ severity: "warning", code: "LINE_MISSING_PACKAGE_UNIT", field: `${prefix}.packageUnit`, message: `Line ${index + 1} has a package quantity but no package unit.` });
  }
  if (line.measuredQuantity !== null && !line.measuredUnit) {
    issues.push({ severity: "warning", code: "LINE_MISSING_MEASURED_UNIT", field: `${prefix}.measuredUnit`, message: `Line ${index + 1} has a measured quantity but no measured unit.` });
  }

  // Line-total math check: only when the price basis matches a unit we can
  // actually compute against. If the basis matches neither package nor
  // measured unit, that's an unfamiliar pricing model, not an error --
  // deliberately no flag in that case.
  if (line.unitPrice !== null && line.lineTotal !== null && line.priceBasisUnit) {
    let expected: number | null = null;
    if (line.measuredQuantity !== null && unitsMatch(line.priceBasisUnit, line.measuredUnit)) {
      expected = line.measuredQuantity * line.unitPrice;
    } else if (line.packageQuantity !== null && unitsMatch(line.priceBasisUnit, line.packageUnit)) {
      expected = line.packageQuantity * line.unitPrice;
    }
    if (expected !== null && !approximatelyEqual(expected, line.lineTotal)) {
      issues.push({
        severity: "warning",
        code: "LINE_TOTAL_MISMATCH",
        field: `${prefix}.lineTotal`,
        message: `Line ${index + 1}: calculated ${formatMoney(expected, currency)} vs. extracted ${formatMoney(line.lineTotal, currency)}.`,
      });
    }
  }

  return issues;
}
