/**
 * The authoritative line-treatment model (client-safe: no "server-only",
 * no framework imports) -- ONE vocabulary shared by Step 1 (Review
 * Invoice), Step 2 (Items & Receiving), Step 3 (Review & Post), the
 * server read models and the classifier. The database CHECK constraints
 * on purchase_document_line_classifications (20260811100182) are the
 * source of truth; these mirror them exactly.
 *
 * "Non-inventory" is NOT an operational classification: a real expense, a
 * freight/service charge, sales tax, a discount, a vendor credit, a
 * returned-container credit and a physical return of tracked stock all
 * have different data requirements, posting effects and manager actions.
 * The treatment decides all of that; the legacy disposition
 * (INVENTORY / NON_INVENTORY / UNRESOLVED) is derived from it.
 */

export type LineTreatment = "INVENTORY_PURCHASE" | "EXPENSE" | "CREDIT_RETURN" | "DISCOUNT" | "TAX" | "FREIGHT_FEE" | "UNRESOLVED";
export type CreditSubtype = "FINANCIAL_CREDIT" | "RETURNABLE_CONTAINER_CREDIT" | "INVENTORY_RETURN";
export type DiscountScope = "LINE" | "DOCUMENT";

export const LINE_TREATMENTS: LineTreatment[] = ["INVENTORY_PURCHASE", "EXPENSE", "CREDIT_RETURN", "DISCOUNT", "TAX", "FREIGHT_FEE", "UNRESOLVED"];

/** The six choices a manager may pick from (UNRESOLVED is a state, never a
 * choice). Order matches the design boards' classification picker. */
export const LINE_TREATMENT_CHOICES: { value: Exclude<LineTreatment, "UNRESOLVED">; label: string; hint: string }[] = [
  { value: "INVENTORY_PURCHASE", label: "Inventory purchase", hint: "Physical stock the business tracks. Needs an item match and receiving details." },
  { value: "EXPENSE", label: "Expense", hint: "A service, repair or supply that is not tracked as stock. Needs an expense category." },
  { value: "CREDIT_RETURN", label: "Credit / return", hint: "A vendor credit, returned containers, or merchandise physically returned." },
  { value: "DISCOUNT", label: "Discount", hint: "A promotional, volume, early-payment or allowance discount. Affects totals only." },
  { value: "TAX", label: "Tax", hint: "Sales tax. Document-level; no category, no inventory." },
  { value: "FREIGHT_FEE", label: "Freight / fee", hint: "Delivery, fuel, handling, minimum-order or service charges. Mapped to an expense category." },
];

export const LINE_TREATMENT_LABEL: Record<LineTreatment, string> = {
  INVENTORY_PURCHASE: "Inventory purchase",
  EXPENSE: "Expense",
  CREDIT_RETURN: "Credit / return",
  DISCOUNT: "Discount",
  TAX: "Tax",
  FREIGHT_FEE: "Freight / fee",
  UNRESOLVED: "Needs classification",
};

export const CREDIT_SUBTYPE_CHOICES: { value: CreditSubtype; label: string; hint: string }[] = [
  { value: "FINANCIAL_CREDIT", label: "No — financial credit", hint: "Invoice correction, vendor allowance or account credit. Reduces the invoice total; no inventory movement." },
  { value: "RETURNABLE_CONTAINER_CREDIT", label: "No — returnable-container credit", hint: "Milk crates, cases, kegs, pallets, bottle deposits. Reduces the invoice total; no inventory movement." },
  { value: "INVENTORY_RETURN", label: "Yes — tracked inventory was returned", hint: "Merchandise physically left the store. Records an audited inventory decrease." },
];

export const CREDIT_SUBTYPE_LABEL: Record<CreditSubtype, string> = {
  FINANCIAL_CREDIT: "Financial credit",
  RETURNABLE_CONTAINER_CREDIT: "Returnable-container credit",
  INVENTORY_RETURN: "Inventory return",
};

export const DISCOUNT_SCOPE_LABEL: Record<DiscountScope, string> = {
  LINE: "Line discount",
  DOCUMENT: "Document discount",
};

export function isLineTreatment(value: unknown): value is LineTreatment {
  return typeof value === "string" && (LINE_TREATMENTS as string[]).includes(value);
}

/** Treatments that require an ACTIVE expense category. */
export function treatmentRequiresExpenseCategory(treatment: LineTreatment): boolean {
  return treatment === "EXPENSE" || treatment === "FREIGHT_FEE";
}

/** Treatments that never touch inventory, never need an item, package,
 * receiving quantity, storage location or kiosk unit. */
export function treatmentIsNonInventory(treatment: LineTreatment): boolean {
  return treatment !== "INVENTORY_PURCHASE" && treatment !== "UNRESOLVED";
}

/** The legacy coarse view every older consumer reads, derived exactly the
 * way the database trigger derives it. */
export function dispositionForTreatment(treatment: LineTreatment): "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED" {
  if (treatment === "INVENTORY_PURCHASE") return "INVENTORY";
  if (treatment === "UNRESOLVED") return "UNRESOLVED";
  return "NON_INVENTORY";
}

// ---- Confidence policy (ONE central definition) ------------------------
export const CONFIDENCE_HIGH = 0.9;
export const CONFIDENCE_MEDIUM = 0.7;

export type ConfidenceBand = "high" | "medium" | "low";

export function confidenceBand(confidence: number | null): ConfidenceBand | null {
  if (confidence === null || Number.isNaN(confidence)) return null;
  if (confidence >= CONFIDENCE_HIGH) return "high";
  if (confidence >= CONFIDENCE_MEDIUM) return "medium";
  return "low";
}

export function formatConfidence(confidence: number | null): string {
  if (confidence === null || Number.isNaN(confidence)) return "—";
  return `${Math.round(confidence * 100)}%`;
}

/** The label shown next to an AI/rule proposal that has not been changed
 * by the manager. */
export function aiAssignmentLabel(input: { resolutionSource: string | null; status: string; confidence: number | null }): "AI assigned" | "Review recommended" | "Matched previous decision" | "Manager set" | null {
  if (input.status === "CONFIRMED") {
    if (input.resolutionSource === "AI_ACCEPTED") return "AI assigned";
    if (input.resolutionSource === "MANUAL" || input.resolutionSource === "VENDOR_SKU_MAPPING" || input.resolutionSource === "VENDOR_DESCRIPTION_MAPPING") return "Manager set";
    return null;
  }
  if (input.resolutionSource === "VENDOR_TREATMENT_RULE") return "Matched previous decision";
  if (input.resolutionSource === "AI_SUGGESTED" || input.resolutionSource === "NORMALIZED_NAME_MATCH") {
    const band = confidenceBand(input.confidence);
    if (band === "high") return "AI assigned";
    if (band === "medium") return "Review recommended";
    return null;
  }
  return null;
}

// ---- Financial effect ---------------------------------------------------

/** The signed effect a line has on the invoice total, by treatment:
 * credits and discounts always REDUCE the total (shown negative) even if
 * the extractor read a positive figure; everything else adds. Null when
 * the line has no amount. */
export function signedLineAmount(treatment: LineTreatment, lineTotal: number | null): number | null {
  if (lineTotal === null || Number.isNaN(lineTotal)) return null;
  if (treatment === "CREDIT_RETURN" || treatment === "DISCOUNT") return -Math.abs(lineTotal);
  return lineTotal;
}

export function invoiceEffectLabel(treatment: LineTreatment, lineTotal: number | null, format: (n: number) => string): string {
  const signed = signedLineAmount(treatment, lineTotal);
  if (signed === null) return "—";
  if (treatment === "CREDIT_RETURN" || treatment === "DISCOUNT") return `Invoice total decreases by ${format(Math.abs(signed))}`;
  if (treatment === "TAX") return `Tax ${format(signed)}`;
  return format(signed);
}
