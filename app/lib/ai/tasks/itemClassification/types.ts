/** Provider-independent shapes -- a deliberately separate seam from
 * schema.ts, even though currently similar (matches invoiceExtraction's
 * types.ts/schema.ts split). */

export interface ItemShortlistCandidate {
  id: string;
  name: string;
  categoryName: string | null;
  baseUnitCode: string | null;
}

export interface UnresolvedClassificationLine {
  lineKey: string;
  vendorSku: string | null;
  description: string | null;
  packageUnit: string | null;
  measuredUnit: string | null;
  /** Org-scoped candidates for THIS line only -- never the whole item
   * master. */
  shortlist: ItemShortlistCandidate[];
}

/** A single ACTIVE inventory category the model may choose for a new-item
 * proposal, by id -- never free text. */
export interface CategoryCandidate {
  id: string;
  name: string;
}

/** A single ACTIVE spend category, flattened to its full "Root > Child"
 * path so an arbitrary-depth hierarchy is still unambiguous to the model in
 * one string, by id -- never free text. */
export interface SpendCategoryCandidate {
  id: string;
  path: string;
}

/** A supported global unit code, by code -- the model may only ever return
 * a code from this set for a base/purchase unit. */
export interface UnitCandidate {
  code: string;
  name: string;
}

/** The full, ORG-SCOPED set of canonical candidates the model may select
 * from for a new-item proposal -- sent once per batch (not per line, unlike
 * the per-line item shortlist), since these lists are small and org-wide.
 * Every suggested id/code the model returns is validated against this exact
 * set in validate.ts; nothing outside it is ever accepted. */
export interface ClassificationCandidateContext {
  inventoryCategories: CategoryCandidate[];
  spendCategories: SpendCategoryCandidate[];
  units: UnitCandidate[];
}

export type ReceivingBehavior = "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY";

export interface NormalizedItemClassificationLine {
  lineKey: string;
  candidateItemId: string | null;
  proposedName: string | null;
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
