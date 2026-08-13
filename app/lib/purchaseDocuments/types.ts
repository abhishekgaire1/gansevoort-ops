import type { NormalizedInvoiceLine } from "@/app/lib/ai/tasks/invoiceExtraction/types";

/**
 * Shared shapes for the purchase-document draft/review layer. `lines`
 * reuses NormalizedInvoiceLine directly (2A.0's shape was already designed
 * to be usable by a real lines table without rework) -- `rawLineText` is
 * always null for a purchase_document_lines row, since that field only
 * ever came from Gemini's raw output.
 */
export type PurchaseDocumentType = "INVOICE" | "RECEIPT" | "CREDIT_MEMO";
export type PurchaseDocumentStatus = "DRAFT" | "READY_FOR_VERIFICATION" | "VERIFIED";

export interface PurchaseDocumentHeaderDraft {
  vendorId: string | null;
  documentType: PurchaseDocumentType | null;
  documentNumber: string | null;
  documentDate: string | null;
  poNumber: string | null;
  deliveryDate: string | null;
  subtotal: number | null;
  tax: number | null;
  fees: number | null;
  total: number | null;
  currency: string | null;
}

export interface PurchaseDocumentDraft extends PurchaseDocumentHeaderDraft {
  lines: NormalizedInvoiceLine[];
}
