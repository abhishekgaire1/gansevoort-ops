import { z } from "zod";

/**
 * Gemini-facing shape for item classification. The model is given a
 * SHORTLIST of candidate items for this organization only (never the full
 * item master -- see buildItemShortlist.ts), the org's canonical category/
 * spend-category/unit CANDIDATE lists (see ClassificationCandidateContext in
 * types.ts -- also never the model's own invention), and the unresolved
 * lines. It must either pick an item candidate by id or propose a new item
 * whose category/spend-category are themselves picked by id from the
 * supplied candidates, never free text. Every field `.nullable()`, not
 * `.optional()`, matching invoiceExtraction's schema convention.
 */

export const GeminiItemClassificationLineSchema = z.object({
  lineKey: z.string(),
  /** Must be an id literally present in the shortlist sent for this line
   * -- validated independently in validate.ts, never trusted blindly. */
  candidateItemId: z.string().nullable(),
  proposedName: z.string().nullable(),
  proposedDisposition: z.enum(["INVENTORY", "NON_INVENTORY"]).nullable(),
  /** Must be an id literally present in the inventoryCategories candidate
   * list supplied in this same request -- validated independently in
   * validate.ts, never trusted blindly. Never a free-text category name:
   * asking the model to invent text and matching it later is exactly the
   * brittleness this schema avoids (e.g. "Dairy" failing to match a
   * canonical "Dairy & Eggs"). Null only when genuinely nothing in the
   * supplied candidates fits. */
  suggestedInventoryCategoryId: z.string().nullable(),
  /** Same candidate-id-only resolution as suggestedInventoryCategoryId, but
   * against the spendCategories candidate list (each entry a full "Root >
   * Child" path). */
  suggestedSpendCategoryId: z.string().nullable(),
  /** Must be one of the known global unit codes (e.g. "LB", "EACH") --
   * validated independently in validate.ts. */
  proposedBaseUnitCode: z.string().nullable(),
  /** The unit the VENDOR sells it in, if different from the base unit
   * (e.g. a case/box) -- also a known global unit code, same validation as
   * proposedBaseUnitCode. Derive this from the line's own packageUnit
   * evidence, not by default-copying proposedBaseUnitCode: a line can
   * legitimately have packageUnit "CS" and measuredUnit "LB" at the same
   * time, meaning the vendor purchase unit is the case even though the item
   * is tracked and priced by the pound. Null/equal-to-base means the vendor
   * genuinely sells it in the same unit it's tracked in -- never a fallback
   * used merely because the base unit was resolved. */
  proposedVendorPurchaseUnitCode: z.string().nullable(),
  /** How receiving that vendor purchase unit converts to the base unit --
   * never a fabricated fixed rate for something that genuinely varies
   * (produce sold by the box but priced/tracked by weight must be
   * MEASURE_EACH_DELIVERY, never a guessed BOX->LB factor). */
  proposedReceivingBehavior: z.enum(["SAME_UNIT", "FIXED_CONVERSION", "MEASURE_EACH_DELIVERY", "COUNT_EACH_DELIVERY"]).nullable(),
  /** Only meaningful (and only ever applied) when proposedReceivingBehavior
   * is FIXED_CONVERSION -- e.g. a case of 24 identical bottles. */
  proposedFixedConversionFactor: z.number().nullable(),
  confidence: z.number().nullable(),
  reasoning: z.string().nullable(),
});

export const GeminiItemClassificationSchema = z.object({
  lines: z.array(GeminiItemClassificationLineSchema),
});

export type GeminiItemClassificationLine = z.infer<typeof GeminiItemClassificationLineSchema>;
export type GeminiItemClassification = z.infer<typeof GeminiItemClassificationSchema>;
