/**
 * The provider-independent shape everything downstream is allowed to
 * consume. No Gemini-specific field name or response quirk crosses this
 * boundary -- see normalize.ts. This is intentionally NOT persisted
 * anywhere in Milestone 2A.0 (no database exists for it yet); it is shaped
 * to be usable later by a real invoice_lines-style table without rework.
 */

export interface NormalizedInvoiceLine {
  vendorSku: string | null;
  description: string | null;
  /** e.g. 5, for "5 CS" */
  packageQuantity: number | null;
  /** e.g. "CS", for "5 CS" -- free text as extracted, not yet matched
   * against our canonical units table. */
  packageUnit: string | null;
  /** e.g. 90.4, for "90.4 LB" -- independent of packageQuantity; a line may
   * carry both simultaneously and neither implies the other. */
  measuredQuantity: number | null;
  measuredUnit: string | null;
  unitPrice: number | null;
  /** Which unit unitPrice is quoted per (e.g. "LB" for "$1.49/LB") --
   * independent of packageUnit/measuredUnit; may equal either or neither. */
  priceBasisUnit: string | null;
  lineTotal: number | null;
  rawLineText: string | null;
}

export interface NormalizedInvoiceExtraction {
  documentType: "INVOICE" | "RECEIPT" | "CREDIT_MEMO" | "OTHER" | null;
  vendorName: string | null;
  vendorAddress: string | null;
  vendorPhone: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  deliveryDate: string | null;
  purchaseOrderNumber: string | null;
  subtotal: number | null;
  tax: number | null;
  fees: number | null;
  total: number | null;
  currency: string | null;
  lines: NormalizedInvoiceLine[];
  /** Gemini's own reported uncertainty -- distinct from our deterministic
   * ReviewFlags below. */
  warnings: string[];
}

export type ReviewFlagSeverity = "error" | "warning" | "info";

export interface ReviewFlag {
  severity: ReviewFlagSeverity;
  /** Stable machine-readable code (e.g. "LINE_TOTAL_MISMATCH") so future
   * code can branch on it, not just display the message. */
  code: string;
  message: string;
  /** Dotted/bracketed path into NormalizedInvoiceExtraction, e.g.
   * "lines[2].lineTotal", when the issue is field-specific. */
  field?: string;
}

export interface InvoiceExtractionResult {
  normalized: NormalizedInvoiceExtraction;
  issues: ReviewFlag[];
  raw: unknown;
  model: string;
  provider: string;
}
