import type { GeminiInvoiceExtraction, GeminiInvoiceLine } from "./schema";
import type { NormalizedInvoiceExtraction, NormalizedInvoiceLine } from "./types";

/** Empty/whitespace-only strings become null; genuine content is trimmed
 * but never rewritten (vendor terminology must survive verbatim). */
function normalizeNullableString(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** NaN/Infinity (which a schema-conforming but malformed response could
 * theoretically still contain) become null rather than propagating into
 * validation math. */
function normalizeNullableNumber(value: number | null): number | null {
  if (value === null) return null;
  return Number.isFinite(value) ? value : null;
}

function normalizeLine(line: GeminiInvoiceLine): NormalizedInvoiceLine {
  return {
    vendorSku: normalizeNullableString(line.vendorSku),
    description: normalizeNullableString(line.description),
    packageQuantity: normalizeNullableNumber(line.packageQuantity),
    packageUnit: normalizeNullableString(line.packageUnit),
    measuredQuantity: normalizeNullableNumber(line.measuredQuantity),
    measuredUnit: normalizeNullableString(line.measuredUnit),
    unitPrice: normalizeNullableNumber(line.unitPrice),
    priceBasisUnit: normalizeNullableString(line.priceBasisUnit),
    lineTotal: normalizeNullableNumber(line.lineTotal),
    rawLineText: normalizeNullableString(line.rawLineText),
  };
}

/** Gemini-shaped result -> the provider-independent shape everything
 * downstream consumes. No Gemini-specific quirk is allowed to cross this
 * function. */
export function normalizeInvoiceExtraction(raw: GeminiInvoiceExtraction): NormalizedInvoiceExtraction {
  return {
    documentType: raw.documentType,
    vendorName: normalizeNullableString(raw.vendorName),
    vendorAddress: normalizeNullableString(raw.vendorAddress),
    vendorPhone: normalizeNullableString(raw.vendorPhone),
    invoiceNumber: normalizeNullableString(raw.invoiceNumber),
    invoiceDate: normalizeNullableString(raw.invoiceDate),
    deliveryDate: normalizeNullableString(raw.deliveryDate),
    purchaseOrderNumber: normalizeNullableString(raw.purchaseOrderNumber),
    subtotal: normalizeNullableNumber(raw.subtotal),
    tax: normalizeNullableNumber(raw.tax),
    fees: normalizeNullableNumber(raw.fees),
    total: normalizeNullableNumber(raw.total),
    currency: normalizeNullableString(raw.currency),
    lines: raw.lines.map(normalizeLine),
    warnings: raw.warnings.map((w) => w.trim()).filter((w) => w !== ""),
  };
}
