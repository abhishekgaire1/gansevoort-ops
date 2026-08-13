/**
 * Never stored -- computed on demand at signed-download-URL generation
 * time. Only ever called with real values once a VERIFIED purchase_document
 * exists for the document (see getDocumentDownloadUrl); otherwise every
 * field is null and this falls back to the original filename. Type-aware
 * (Milestone 2A.2): the document-number prefix depends on document_type,
 * e.g. Baldor_2026-08-12_INV-839291.pdf vs. Target_2026-07-15_RECEIPT-26196.jpg
 * vs. US-Foods_2026-08-10_CM-49322.pdf.
 */
const DOCUMENT_TYPE_PREFIX: Record<"INVOICE" | "RECEIPT" | "CREDIT_MEMO", string> = {
  INVOICE: "INV",
  RECEIPT: "RECEIPT",
  CREDIT_MEMO: "CM",
};

export function buildArchiveFilename(input: {
  vendorName: string | null;
  documentDate: string | null;
  documentNumber: string | null;
  documentType: "INVOICE" | "RECEIPT" | "CREDIT_MEMO" | null;
  originalFilename: string;
}): string {
  const lastDot = input.originalFilename.lastIndexOf(".");
  const extension = lastDot > 0 ? input.originalFilename.slice(lastDot) : "";

  const prefixedNumber =
    input.documentNumber && input.documentType
      ? `${DOCUMENT_TYPE_PREFIX[input.documentType]}-${input.documentNumber}`
      : input.documentNumber;

  const parts = [input.vendorName, input.documentDate, prefixedNumber].filter((part): part is string => Boolean(part && part.trim()));

  if (parts.length === 0) {
    return input.originalFilename;
  }

  const sanitized = parts.map((part) => part.trim().replace(/[^a-zA-Z0-9._-]+/g, "_"));
  return `${sanitized.join("_")}${extension}`;
}
