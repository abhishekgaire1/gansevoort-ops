import { z } from "zod";

/**
 * What Gemini's structured output is constrained to (via
 * z.toJSONSchema -- see app/lib/ai/providers/gemini.ts) AND what its JSON
 * response is parsed/validated against. One definition, not two that could
 * drift.
 *
 * Every field is `.nullable()`, not `.optional()`: the key is always
 * present, forcing the model to explicitly choose null over silently
 * omitting a field it isn't confident about -- more reliable for
 * structured LLM output than leaving keys absent.
 *
 * This is deliberately the RAW Gemini-facing shape, kept separate from
 * NormalizedInvoiceExtraction (see types.ts + normalize.ts) even though
 * they're currently very similar -- that seam is what lets a future
 * provider, or a future revision of this schema, diverge without changing
 * anything downstream.
 */

export const GeminiInvoiceLineSchema = z.object({
  vendorSku: z.string().nullable(),
  description: z.string().nullable(),
  packageQuantity: z.number().nullable(),
  packageUnit: z.string().nullable(),
  measuredQuantity: z.number().nullable(),
  measuredUnit: z.string().nullable(),
  unitPrice: z.number().nullable(),
  priceBasisUnit: z.string().nullable(),
  lineTotal: z.number().nullable(),
  rawLineText: z.string().nullable(),
});

export const GeminiInvoiceExtractionSchema = z.object({
  documentType: z.enum(["INVOICE", "RECEIPT", "CREDIT_MEMO", "OTHER"]).nullable(),
  vendorName: z.string().nullable(),
  vendorAddress: z.string().nullable(),
  vendorPhone: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  deliveryDate: z.string().nullable(),
  purchaseOrderNumber: z.string().nullable(),
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  fees: z.number().nullable(),
  total: z.number().nullable(),
  /** Distinct from `total` -- a vendor-printed account balance / amount
   * due that includes prior invoices, when recognized. See types.ts. */
  amountDue: z.number().nullable(),
  currency: z.string().nullable(),
  lines: z.array(GeminiInvoiceLineSchema),
  warnings: z.array(z.string()),
});

export type GeminiInvoiceLine = z.infer<typeof GeminiInvoiceLineSchema>;
export type GeminiInvoiceExtraction = z.infer<typeof GeminiInvoiceExtractionSchema>;
