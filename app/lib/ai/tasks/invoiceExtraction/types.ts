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
  /** This DOCUMENT's own total -- the amount attributable to just this
   * invoice/receipt/credit memo's own lines, tax, and fees. NEVER a
   * broader account balance/amount-due figure that includes prior
   * invoices -- see amountDue below for that distinct concept. Existing
   * downstream consumers (purchase_documents.total, reconciliation,
   * Verified/Step 4 display) all assume this meaning; that assumption is
   * preserved, not redefined. */
  total: number | null;
  /** Some vendor invoices print a bottom-line figure that is NOT this
   * document's own total -- it's a running account balance that also
   * includes prior, separately-invoiced deliveries (e.g. a paper-goods
   * distributor listing "177888 (07/30/26) $3,460.00" etc. above its
   * final TOTAL). When the model recognizes this pattern, it reports
   * that larger figure here (never in `total`) so validation can
   * distinguish "this invoice cost $X" from "the vendor says $Y is
   * currently owed, including older invoices." Null on the ordinary
   * invoice where the printed total already is just this document's own
   * total -- which is most invoices. Purely a suggestion signal, same as
   * `warnings` -- the deterministic validator (validate.ts) still infers
   * this from line reconciliation even when the model leaves it null. */
  amountDue: number | null;
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
