/**
 * Pure column presentation for a Step-2 "Items & Receiving" compact row.
 *
 * The old compact row repeated the quantity ("84 PIECE -> 84 PIECE" in the
 * package column, then "Received: 84 PIECE" in the next) without explaining
 * what each number meant. This helper produces distinct, self-describing
 * columns instead:
 *
 *   Invoice line | Matched item | Purchase package | Inventory increase |
 *   Destination  | Price        | Status           | Action
 *
 * It is free of React/DB types so it can be unit-tested directly. All price
 * change wording comes from the caller's already-computed PriceCheckDisplay
 * (one authoritative, vendor-aware source) -- this helper never re-derives a
 * price-change classification.
 */

export type RowReceivingBehavior = "SAME_UNIT" | "FIXED_CONVERSION" | "MEASURE_EACH_DELIVERY" | "COUNT_EACH_DELIVERY";

export interface CompactRowPriceComparison {
  available: boolean;
  currentUnitCost?: number;
  baseUnitCode?: string;
  previousVendorName?: string | null;
}

export interface CompactRowInput {
  description: string | null;
  vendorSku: string | null;
  /** Pre-formatted invoice quantity, e.g. "84 PIECE" (from formatSourceQuantity). */
  orderedQuantityText: string | null;
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  matchedItemName: string | null;

  receivingBehavior: RowReceivingBehavior | null;
  purchaseUnitCode: string | null;
  baseUnitCode: string | null;
  conversionFactor: number | null;
  /** The invoice's own unit, used to decide if a per-purchase-unit price applies. */
  resolvedInvoiceUnitCode: string | null;

  /** Verified base quantity that will enter inventory (already converted). */
  verifiedBaseQuantity: string | null;
  /** As-received quantity + unit (used for SAME_UNIT increase). */
  receivedQuantity: string | null;
  receivedUnit: string | null;

  locationName: string | null;
  conditionLabel: string | null;
  conditionIsAsInvoiced: boolean;

  lineTotal: number | null;
  priceComparison: CompactRowPriceComparison | null;
  /** Authoritative vendor-aware change text, e.g. "↑ 14.0% · Bartlett" or
   * "No material change" -- rendered verbatim as the change line. */
  priceChangeText: string | null;
}

export interface CompactRowView {
  invoice: { description: string; meta: string | null };
  matchedItem: string;
  purchasePackage: string;
  /** Null for non-inventory lines (they add nothing to stock). */
  inventoryIncrease: string | null;
  destination: { location: string; condition: string } | null;
  price: {
    /** Present when only one unit price applies (SAME_UNIT / measured). */
    unit: string | null;
    /** FIXED_CONVERSION only: the invoice's per-purchase-unit price. */
    invoiceUnit: string | null;
    /** FIXED_CONVERSION only: the normalized per-base-unit price. */
    normalized: string | null;
    lineTotal: string | null;
    change: string | null;
  } | null;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "Same unit · PIECE" | "1 CASE = 12 PIECE" | "Measured at receiving" | "—". */
export function purchasePackageText(input: {
  receivingBehavior: RowReceivingBehavior | null;
  purchaseUnitCode: string | null;
  baseUnitCode: string | null;
  conversionFactor: number | null;
}): string {
  switch (input.receivingBehavior) {
    case "SAME_UNIT":
      return input.baseUnitCode ? `Same unit · ${input.baseUnitCode}` : "Same unit";
    case "FIXED_CONVERSION":
      if (input.purchaseUnitCode && input.baseUnitCode && input.conversionFactor && input.conversionFactor > 0) {
        return `1 ${input.purchaseUnitCode} = ${input.conversionFactor} ${input.baseUnitCode}`;
      }
      return "Fixed conversion";
    case "MEASURE_EACH_DELIVERY":
    case "COUNT_EACH_DELIVERY":
      return "Measured at receiving";
    default:
      return "—";
  }
}

/** "+84 PIECE" | "+42.6 LB actual" | null (non-inventory). */
export function inventoryIncreaseText(input: CompactRowInput): string | null {
  if (input.disposition !== "INVENTORY") return null;
  const base = input.baseUnitCode ?? "";
  if (input.receivingBehavior === "MEASURE_EACH_DELIVERY" || input.receivingBehavior === "COUNT_EACH_DELIVERY") {
    if (input.verifiedBaseQuantity && input.verifiedBaseQuantity.trim() !== "") {
      return `+${input.verifiedBaseQuantity} ${base} actual`.trimEnd();
    }
    return null;
  }
  if (input.receivingBehavior === "FIXED_CONVERSION") {
    if (input.verifiedBaseQuantity && input.verifiedBaseQuantity.trim() !== "") {
      return `+${input.verifiedBaseQuantity} ${base}`.trimEnd();
    }
    return null;
  }
  // SAME_UNIT (or unspecified): the received quantity IS the base quantity.
  if (input.receivedQuantity && input.receivedQuantity.trim() !== "") {
    return `+${input.receivedQuantity} ${input.receivedUnit ?? base}`.trimEnd();
  }
  return null;
}

export function deriveCompactRowView(input: CompactRowInput): CompactRowView {
  const meta = [input.orderedQuantityText, input.vendorSku ? `SKU ${input.vendorSku}` : null].filter(Boolean).join(" · ") || null;

  // ---- Price column: unit price(s) + line total + change state ----
  let price: CompactRowView["price"] = null;
  const lineTotalText = input.lineTotal !== null ? `${money(input.lineTotal)} line total` : null;
  let unit: string | null = null;
  let invoiceUnit: string | null = null;
  let normalized: string | null = null;

  const pc = input.priceComparison;
  if (pc && pc.available && pc.currentUnitCost !== undefined && pc.baseUnitCode) {
    const basePrice = `${money(pc.currentUnitCost)} / ${pc.baseUnitCode}`;
    const billsInPurchaseUnit =
      input.receivingBehavior === "FIXED_CONVERSION" &&
      input.conversionFactor !== null &&
      input.conversionFactor > 0 &&
      input.purchaseUnitCode !== null &&
      input.resolvedInvoiceUnitCode !== null &&
      input.resolvedInvoiceUnitCode.trim().toUpperCase() === input.purchaseUnitCode.trim().toUpperCase();
    if (billsInPurchaseUnit) {
      // Distinguish the invoice's purchase-unit price from the normalized
      // base-unit price used for comparison -- never conflate them.
      invoiceUnit = `Invoice: ${money(pc.currentUnitCost * input.conversionFactor!)} / ${input.purchaseUnitCode}`;
      normalized = `Normalized: ${basePrice}`;
    } else {
      unit = basePrice;
    }
  }

  if (unit || invoiceUnit || normalized || lineTotalText || input.priceChangeText) {
    price = { unit, invoiceUnit, normalized, lineTotal: lineTotalText, change: input.priceChangeText };
  }

  return {
    invoice: { description: input.description ?? "—", meta },
    matchedItem: input.matchedItemName ?? "—",
    purchasePackage: purchasePackageText(input),
    inventoryIncrease: inventoryIncreaseText(input),
    destination: input.locationName
      ? { location: input.locationName, condition: input.conditionIsAsInvoiced ? "As invoiced" : (input.conditionLabel ?? "") }
      : null,
    price,
  };
}
