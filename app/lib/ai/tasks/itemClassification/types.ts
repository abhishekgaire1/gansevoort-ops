/** Provider-independent shapes -- a deliberately separate seam from
 * schema.ts, even though currently similar (matches invoiceExtraction's
 * types.ts/schema.ts split). */

export type LineTreatmentValue = "INVENTORY_PURCHASE" | "EXPENSE" | "CREDIT_RETURN" | "DISCOUNT" | "TAX" | "FREIGHT_FEE" | "UNRESOLVED";
export type CreditSubtypeValue = "FINANCIAL_CREDIT" | "RETURNABLE_CONTAINER_CREDIT" | "INVENTORY_RETURN";
export type DiscountScopeValue = "LINE" | "DOCUMENT";

export interface ItemShortlistCandidate {
  id: string;
  name: string;
  categoryName: string | null;
  baseUnitCode: string | null;
}

/** A vendor-specific prior manager decision for this SKU/description that
 * was NOT auto-applied (its treatment contradicted the current line's own
 * evidence, e.g. a "credit" rule on a positive amount) -- passed to the
 * model as context, never as an instruction to obey. */
export interface PriorTreatmentDecision {
  lineTreatment: LineTreatmentValue;
  creditSubtype: CreditSubtypeValue | null;
  spendCategoryId: string | null;
  matchBasis: "VENDOR_SKU" | "NORMALIZED_DESCRIPTION";
}

export interface UnresolvedClassificationLine {
  lineKey: string;
  vendorSku: string | null;
  description: string | null;
  packageQuantity: number | null;
  packageUnit: string | null;
  measuredQuantity: number | null;
  measuredUnit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  /** Org-scoped candidates for THIS line only -- never the whole item
   * master. */
  shortlist: ItemShortlistCandidate[];
  priorDecision: PriorTreatmentDecision | null;
}

/** A single ACTIVE inventory category the model may choose for a new-item
 * proposal, by id -- never free text. */
export interface CategoryCandidate {
  id: string;
  name: string;
}

/** A single ACTIVE expense (spend) category, flattened to its full "Root >
 * Child" path so an arbitrary-depth hierarchy is still unambiguous to the
 * model in one string, by id -- never free text. The description is what
 * an Admin wrote for it (helps the model match on meaning). */
export interface SpendCategoryCandidate {
  id: string;
  path: string;
  description: string | null;
}

/** A supported global unit code, by code -- the model may only ever return
 * a code from this set for a base/purchase unit. */
export interface UnitCandidate {
  code: string;
  name: string;
}

export interface VendorContext {
  name: string | null;
  /** INVENTORY (sells stock) or NON_INVENTORY (services/supplies) -- a
   * default, never a restriction. */
  classification: "INVENTORY" | "NON_INVENTORY" | null;
}

/** The full, ORG-SCOPED set of canonical candidates the model may select
 * from -- sent once per batch (not per line, unlike the per-line item
 * shortlist), since these lists are small and org-wide. Every suggested
 * id/code the model returns is validated against this exact set in
 * validate.ts; nothing outside it is ever accepted. */
export interface ClassificationCandidateContext {
  vendor: VendorContext | null;
  inventoryCategories: CategoryCandidate[];
  spendCategories: SpendCategoryCandidate[];
  units: UnitCandidate[];
  /** The closed treatment vocabulary with its meaning, so the model never
   * invents a treatment name. */
  lineTreatments: { value: LineTreatmentValue; meaning: string }[];
  creditSubtypes: { value: CreditSubtypeValue; meaning: string }[];
}

export type ReceivingBehavior = "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY";

export interface NormalizedItemClassificationLine {
  lineKey: string;
  proposedLineTreatment: LineTreatmentValue | null;
  proposedCreditSubtype: CreditSubtypeValue | null;
  proposedDiscountScope: DiscountScopeValue | null;
  candidateItemId: string | null;
  proposedName: string | null;
  /** Derived from proposedLineTreatment (INVENTORY_PURCHASE -> INVENTORY,
   * any other decided treatment -> NON_INVENTORY). Kept for the item
   * writers that only know the coarse disposition. */
  proposedDisposition: "INVENTORY" | "NON_INVENTORY" | null;
  /** A canonical inventory_categories.id, or null -- resolved directly from
   * the candidate list the model was given, never a free-text name matched
   * after the fact. */
  proposedCategoryId: string | null;
  /** A canonical spend_categories.id, or null -- same candidate-id-only
   * resolution as proposedCategoryId. */
  proposedSpendCategoryId: string | null;
  proposedBaseUnitCode: string | null;
  proposedVendorPurchaseUnitCode: string | null;
  proposedReceivingBehavior: ReceivingBehavior | null;
  proposedFixedConversionFactor: number | null;
  confidence: number | null;
  reasoning: string | null;
  evidence: string[];
  fieldsRequiringReview: string[];
}

export interface ItemClassificationIssue {
  lineKey: string;
  code: string;
  message: string;
}

export interface ItemClassificationResult {
  lines: NormalizedItemClassificationLine[];
  issues: ItemClassificationIssue[];
  raw: unknown;
  model: string;
  provider: string;
}
