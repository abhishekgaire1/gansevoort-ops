import type { NormalizedInvoiceExtraction, NormalizedInvoiceLine, ReviewFlag } from "./types";

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
    issues.push(...validateLineItem(line, index));
  });

  if (extraction.total !== null && extraction.lines.length > 0) {
    const allLineTotalsKnown = extraction.lines.every((line) => line.lineTotal !== null);
    if (allLineTotalsKnown) {
      const sumOfLines = extraction.lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);
      const computedTotal = sumOfLines + (extraction.tax ?? 0) + (extraction.fees ?? 0);
      if (!approximatelyEqual(computedTotal, extraction.total)) {
        issues.push({
          severity: "warning",
          code: "INVOICE_TOTAL_MISMATCH",
          field: "total",
          message: `Line totals + tax + fees (${computedTotal.toFixed(2)}) do not match the extracted total (${extraction.total.toFixed(2)}).`,
        });
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
export function validateLineItem(line: NormalizedInvoiceLine, index: number): ReviewFlag[] {
  const issues: ReviewFlag[] = [];
  const prefix = `lines[${index}]`;

  if (!line.description) {
    issues.push({ severity: "warning", code: "LINE_MISSING_DESCRIPTION", field: `${prefix}.description`, message: `Line ${index + 1} has no description.` });
  }

  if (line.packageQuantity !== null && line.packageQuantity < 0) {
    issues.push({ severity: "error", code: "LINE_NEGATIVE_PACKAGE_QUANTITY", field: `${prefix}.packageQuantity`, message: `Line ${index + 1} has a negative package quantity.` });
  }
  if (line.measuredQuantity !== null && line.measuredQuantity < 0) {
    issues.push({ severity: "error", code: "LINE_NEGATIVE_MEASURED_QUANTITY", field: `${prefix}.measuredQuantity`, message: `Line ${index + 1} has a negative measured quantity.` });
  }
  if (line.unitPrice !== null && line.unitPrice < 0) {
    issues.push({ severity: "error", code: "LINE_NEGATIVE_UNIT_PRICE", field: `${prefix}.unitPrice`, message: `Line ${index + 1} has a negative unit price.` });
  }
  if (line.lineTotal !== null && line.lineTotal < 0) {
    issues.push({ severity: "error", code: "LINE_NEGATIVE_TOTAL", field: `${prefix}.lineTotal`, message: `Line ${index + 1} has a negative line total.` });
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
        message: `Line ${index + 1}: calculated ${expected.toFixed(2)} vs. extracted ${line.lineTotal.toFixed(2)}.`,
      });
    }
  }

  return issues;
}
