import { validateLineItem } from "@/app/lib/ai/tasks/invoiceExtraction/validate";
import type { ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { PurchaseDocumentDraft, PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import { formatMoney } from "@/app/lib/formatMoney";

/**
 * Deterministic, non-AI validation of a purchase document DRAFT's current
 * values -- type-aware (an invoice-specific missing-field flag never
 * appears for a RECEIPT, and vice versa), pure, and side-effect-free so it
 * can run client-side on every edit for live-updating review flags
 * (nothing here is persisted -- see docs/DATABASE.md's "avoid duplicating
 * calculated truths into manually maintained tables," the same philosophy
 * already used for documents/document_extractions display status).
 *
 * Reuses validateLineItem (exported from 2A.0's validate.ts) for line-math
 * checks, which don't depend on document type -- only the header checks
 * below are type-aware.
 */

const DOCUMENT_NUMBER_LABEL: Record<PurchaseDocumentType, string> = {
  INVOICE: "Invoice number",
  RECEIPT: "Receipt/transaction number",
  CREDIT_MEMO: "Credit memo number",
};

const DOCUMENT_NUMBER_CODE: Record<PurchaseDocumentType, string> = {
  INVOICE: "MISSING_INVOICE_NUMBER",
  RECEIPT: "MISSING_RECEIPT_NUMBER",
  CREDIT_MEMO: "MISSING_CREDIT_MEMO_NUMBER",
};

const DOCUMENT_DATE_LABEL: Record<PurchaseDocumentType, string> = {
  INVOICE: "Invoice date",
  RECEIPT: "Transaction date",
  CREDIT_MEMO: "Credit memo date",
};

const DOCUMENT_DATE_CODE: Record<PurchaseDocumentType, string> = {
  INVOICE: "MISSING_INVOICE_DATE",
  RECEIPT: "MISSING_TRANSACTION_DATE",
  CREDIT_MEMO: "MISSING_CREDIT_MEMO_DATE",
};

const ABSOLUTE_TOLERANCE = 0.02; // 2 cents
const RELATIVE_TOLERANCE = 0.01; // 1%, for larger amounts where a flat cent tolerance is too strict

function approximatelyEqual(a: number, b: number): boolean {
  const tolerance = Math.max(ABSOLUTE_TOLERANCE, Math.abs(b) * RELATIVE_TOLERANCE);
  return Math.abs(a - b) <= tolerance;
}

export function validatePurchaseDocumentDraft(draft: PurchaseDocumentDraft): ReviewFlag[] {
  const issues: ReviewFlag[] = [];

  if (!draft.vendorId) {
    issues.push({ severity: "error", code: "MISSING_VENDOR", field: "vendorId", message: "Vendor has not been selected." });
  }

  if (draft.documentType) {
    if (!draft.documentNumber) {
      issues.push({
        severity: "error",
        code: DOCUMENT_NUMBER_CODE[draft.documentType],
        field: "documentNumber",
        message: `${DOCUMENT_NUMBER_LABEL[draft.documentType]} was not found.`,
      });
    }
    if (!draft.documentDate) {
      issues.push({
        severity: "error",
        code: DOCUMENT_DATE_CODE[draft.documentType],
        field: "documentDate",
        message: `${DOCUMENT_DATE_LABEL[draft.documentType]} was not found.`,
      });
    }
  } else {
    issues.push({ severity: "error", code: "MISSING_DOCUMENT_TYPE", field: "documentType", message: "Document type has not been resolved." });
  }
  // po_number/delivery_date are never flagged as missing, for any type --
  // they're always legitimately absent.

  if (draft.total === null) {
    issues.push({ severity: "error", code: "MISSING_TOTAL", field: "total", message: "Total was not found." });
  }

  if (draft.lines.length === 0) {
    issues.push({ severity: "warning", code: "NO_LINE_ITEMS", message: "No line items." });
  }

  draft.lines.forEach((line, index) => {
    issues.push(...validateLineItem(line, index, draft.currency));
  });

  if (draft.total !== null && draft.lines.length > 0) {
    const allLineTotalsKnown = draft.lines.every((line) => line.lineTotal !== null);
    if (allLineTotalsKnown) {
      const sumOfLines = draft.lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);
      const computedTotal = sumOfLines + (draft.tax ?? 0) + (draft.fees ?? 0);
      if (!approximatelyEqual(computedTotal, draft.total)) {
        issues.push({
          severity: "warning",
          code: "TOTAL_MISMATCH",
          field: "total",
          message: `Line totals + tax + fees (${formatMoney(computedTotal, draft.currency)}) do not match the entered total (${formatMoney(draft.total, draft.currency)}).`,
        });
      }
    }
  }

  return issues;
}
