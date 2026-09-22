import { z } from "zod";

/**
 * Gemini-facing shape for invoice-line classification. The model is given
 * a SHORTLIST of candidate items for this organization only (never the
 * full item master -- see buildItemShortlist.ts), the org's canonical
 * category / expense-category / unit CANDIDATE lists and the closed
 * line-treatment vocabulary (see ClassificationCandidateContext in
 * types.ts -- never the model's own invention), and the unresolved lines.
 *
 * For EVERY line it must first decide the line's OPERATIONAL MEANING
 * (proposedLineTreatment) -- inventory purchase, expense, credit/return,
 * discount, tax, freight/fee, or unresolved when it genuinely cannot tell
 * -- and only then, for an inventory purchase, pick an item candidate by
 * id or propose a new item whose category/spend-category are themselves
 * picked by id from the supplied candidates, never free text. Every field
 * `.nullable()`, not `.optional()`, matching invoiceExtraction's schema
 * convention.
 */

export const LINE_TREATMENT_VALUES = ["INVENTORY_PURCHASE", "EXPENSE", "CREDIT_RETURN", "DISCOUNT", "TAX", "FREIGHT_FEE", "UNRESOLVED"] as const;
export const CREDIT_SUBTYPE_VALUES = ["FINANCIAL_CREDIT", "RETURNABLE_CONTAINER_CREDIT", "INVENTORY_RETURN"] as const;
export const DISCOUNT_SCOPE_VALUES = ["LINE", "DOCUMENT"] as const;

export const GeminiItemClassificationLineSchema = z.object({
  lineKey: z.string(),
  /** The line's operational meaning -- decided BEFORE any item/category
   * question. UNRESOLVED only when the text/amount genuinely cannot be
   * classified; never invent a treatment to avoid it. */
  proposedLineTreatment: z.enum(LINE_TREATMENT_VALUES).nullable(),
  /** Only for CREDIT_RETURN: did tracked inventory physically leave the
   * store? Null when the line does not say. */
  proposedCreditSubtype: z.enum(CREDIT_SUBTYPE_VALUES).nullable(),
  /** Only for DISCOUNT: does it apply to one line or the whole document? */
  proposedDiscountScope: z.enum(DISCOUNT_SCOPE_VALUES).nullable(),
  /** Must be an id literally present in the shortlist sent for this line
   * -- validated independently in validate.ts, never trusted blindly.
   * Only meaningful for INVENTORY_PURCHASE. */
  candidateItemId: z.string().nullable(),
  /** New-item proposal (INVENTORY_PURCHASE with no candidate). */
  proposedName: z.string().nullable(),
  /** Must be an id literally present in the inventoryCategories candidate
   * list supplied in this same request -- validated independently in
   * validate.ts, never trusted blindly. */
  suggestedInventoryCategoryId: z.string().nullable(),
  /** For EXPENSE / FREIGHT_FEE (required) and, optionally, for a new
   * inventory item: an id literally present in the spendCategories
   * candidate list. Never a free-text category name. Null when nothing in
   * the supplied list fits -- the line is then left for the manager, never
   * given an invented category. */
  suggestedSpendCategoryId: z.string().nullable(),
  proposedBaseUnitCode: z.string().nullable(),
  proposedVendorPurchaseUnitCode: z.string().nullable(),
  proposedReceivingBehavior: z.enum(["SAME_UNIT", "FIXED_CONVERSION", "MEASURE_EACH_DELIVERY", "COUNT_EACH_DELIVERY"]).nullable(),
  proposedFixedConversionFactor: z.number().nullable(),
  /** 0..1. >= 0.90 is auto-assigned (manager may change it), 0.70-0.89 is
   * "review recommended", < 0.70 lands UNRESOLVED. */
  confidence: z.number().nullable(),
  /** One short plain-language sentence a manager can read. */
  reasoning: z.string().nullable(),
  /** The concrete evidence used (e.g. "negative amount", "keyword
   * RETURNED", "vendor is a refrigeration service company"). */
  evidence: z.array(z.string()).nullable(),
  /** Field names a human should double-check (e.g. "creditSubtype",
   * "spendCategoryId", "quantity"). */
  fieldsRequiringReview: z.array(z.string()).nullable(),
});

export const GeminiItemClassificationSchema = z.object({
  lines: z.array(GeminiItemClassificationLineSchema),
});

export type GeminiItemClassificationLine = z.infer<typeof GeminiItemClassificationLineSchema>;
export type GeminiItemClassification = z.infer<typeof GeminiItemClassificationSchema>;
