import type {
  PurchaseDocumentHeaderDraft,
  PurchaseDocumentLine,
  PurchaseDocumentDiff,
  FieldChange,
  LineChange,
} from "@/app/lib/purchaseDocuments/types";

/**
 * Pure-TS mirror of the purchase_document_diff SQL function (same field
 * lists, same lineKey correlation, same counting rule) -- used ONLY for an
 * instant, no-round-trip client-side preview (the "Verify" vs. "Verify
 * with N Corrections" button label, live as the reviewer types). The
 * AUTHORITATIVE diff/count is always the one verify_purchase_document
 * computes server-side against the real submitted snapshot; this never
 * substitutes for that, it only avoids a network round trip for a label
 * that updates on every keystroke.
 */

const HEADER_FIELDS: (keyof PurchaseDocumentHeaderDraft)[] = [
  "vendorId",
  "documentType",
  "documentNumber",
  "documentDate",
  "poNumber",
  "deliveryDate",
  "subtotal",
  "tax",
  "fees",
  "total",
  "currency",
];

const LINE_FIELDS: (keyof PurchaseDocumentLine)[] = [
  "vendorSku",
  "description",
  "packageQuantity",
  "packageUnit",
  "measuredQuantity",
  "measuredUnit",
  "unitPrice",
  "priceBasisUnit",
  "lineTotal",
];

export function computePurchaseDocumentDiff(
  oldHeader: PurchaseDocumentHeaderDraft,
  oldLines: PurchaseDocumentLine[],
  newHeader: PurchaseDocumentHeaderDraft,
  newLines: PurchaseDocumentLine[]
): PurchaseDocumentDiff {
  const headerChanges: FieldChange[] = [];
  for (const field of HEADER_FIELDS) {
    if (oldHeader[field] !== newHeader[field]) {
      headerChanges.push({ field, before: oldHeader[field], after: newHeader[field] });
    }
  }

  const oldByKey = new Map(oldLines.filter((line) => line.lineKey).map((line) => [line.lineKey as string, line]));
  const newByKey = new Map(newLines.filter((line) => line.lineKey).map((line) => [line.lineKey as string, line]));

  const lineChanges: LineChange[] = [];
  for (const [key, line] of oldByKey) {
    if (!newByKey.has(key)) {
      lineChanges.push({ lineKey: key, kind: "removed", line: line as unknown as Record<string, unknown> });
    }
  }
  for (const [key, line] of newByKey) {
    const oldLine = oldByKey.get(key);
    if (!oldLine) {
      lineChanges.push({ lineKey: key, kind: "added", line: line as unknown as Record<string, unknown> });
      continue;
    }
    const fields: FieldChange[] = [];
    for (const field of LINE_FIELDS) {
      if (oldLine[field] !== line[field]) {
        fields.push({ field, before: oldLine[field], after: line[field] });
      }
    }
    if (fields.length > 0) {
      lineChanges.push({ lineKey: key, kind: "modified", fields });
    }
  }

  return { headerChanges, lineChanges };
}

/** each changed header field = 1; each changed field inside a modified
 * line = 1; each added line = 1; each removed line = 1. Never the number
 * of events, never the number of lineChanges entries directly. */
export function purchaseDocumentDiffCount(diff: PurchaseDocumentDiff): number {
  const lineCount = diff.lineChanges.reduce((sum, change) => sum + (change.kind === "modified" ? change.fields.length : 1), 0);
  return diff.headerChanges.length + lineCount;
}
