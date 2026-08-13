import type { NormalizedInvoiceLine } from "@/app/lib/ai/tasks/invoiceExtraction/types";

/**
 * Shared shapes for the purchase-document draft/review layer. `lines`
 * reuses NormalizedInvoiceLine directly (2A.0's shape was already designed
 * to be usable by a real lines table without rework) -- `rawLineText` is
 * always null for a purchase_document_lines row, since that field only
 * ever came from Gemini's raw output.
 */
export type PurchaseDocumentType = "INVOICE" | "RECEIPT" | "CREDIT_MEMO";
/** DISCARDED is terminal and only reachable from DRAFT -- never directly
 * from READY_FOR_VERIFICATION (which must first be withdrawn to DRAFT) or
 * from VERIFIED (which can never be discarded, only amended). */
export type PurchaseDocumentStatus = "DRAFT" | "READY_FOR_VERIFICATION" | "VERIFIED" | "DISCARDED";

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

/**
 * A line as it round-trips through save/review-correction/verify --
 * NormalizedInvoiceLine plus a stable `lineKey`, generated once (server-side
 * for lines that originate from initialize_purchase_document_draft or
 * return-restoration, client-side via crypto.randomUUID() the instant a
 * manager adds a new line in the browser) and preserved verbatim by every
 * save, even though the underlying purchase_document_lines row is still
 * delete-all-reinserted on each save. This is what makes line-level
 * diffing (added/removed/modified) possible across saves -- array position
 * alone breaks the moment a line is inserted or removed anywhere but the
 * end. `lineKey` is null only for a line that hasn't been persisted or
 * locally assigned a key yet (should not normally happen once created).
 */
export interface PurchaseDocumentLine extends NormalizedInvoiceLine {
  lineKey: string | null;
}

/** One entry in a structured field-level diff -- see
 * app/lib/purchaseDocuments/diff.ts and the purchase_document_diff SQL
 * function this mirrors exactly (same field names, same shape). */
export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export type LineChange =
  | { lineKey: string; kind: "modified"; fields: FieldChange[] }
  | { lineKey: string; kind: "added"; line: Record<string, unknown> }
  | { lineKey: string; kind: "removed"; line: Record<string, unknown> };

export interface PurchaseDocumentDiff {
  headerChanges: FieldChange[];
  lineChanges: LineChange[];
}

export interface RevisionSummary {
  purchaseDocumentId: string;
  revisionNumber: number;
  status: PurchaseDocumentStatus;
  isCurrentVerified: boolean;
  /** Only meaningful when status is DISCARDED -- who discarded it, when,
   * and why (reason is required for an amendment, optional for an
   * original draft, so may be null even for a discarded row). */
  discardedByName: string | null;
  discardedAt: string | null;
  discardReason: string | null;
}
