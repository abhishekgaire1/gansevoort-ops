import type { ReceivingLineInfo } from "@/app/lib/receiving/getReceivingLines";

export interface ReceivingPrefill {
  receivedQuantity: string;
  receivedUnit: string;
  verifiedQuantity: string;
  /** Set only when the invoice EXPLICITLY states a unit that disagrees
   * with the remembered vendor/current-line invoice unit -- a genuine
   * business anomaly the manager must look at ("Invoice says: CASE /
   * Previously remembered: PIECE / Needs review"), never silently
   * resolved in either direction. Distinct from the ordinary "nothing
   * known yet" unresolved case (receivedQuantity/receivedUnit simply
   * empty with conflict null). */
  conflict: { invoiceUnit: string; rememberedUnit: string } | null;
}

const EMPTY: ReceivingPrefill = { receivedQuantity: "", receivedUnit: "", verifiedQuantity: "", conflict: null };

function unitsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A real, STATED disagreement between what the invoice says and what the
 * item is confirmed to be received in -- never silently reconciled. A
 * missing invoice unit is NOT a conflict. */
function unitsConflict(invoiceUnit: string | null, expectedUnit: string | null): boolean {
  return invoiceUnit !== null && expectedUnit !== null && !unitsMatch(invoiceUnit, expectedUnit);
}

/** True only when `candidate` is known (non-null) AND actually matches --
 * a null candidate is never treated as a match, so this never fabricates
 * agreement out of two unknowns. */
function unitsEqual(unit: string, candidate: string | null): candidate is string {
  return candidate !== null && unitsMatch(unit, candidate);
}

/**
 * Resolves what unit the invoice's bare quantity is actually expressed
 * in, for the packaged-item behaviors (FIXED_CONVERSION/MEASURE_EACH_
 * DELIVERY/COUNT_EACH_DELIVERY). Priority, per the product decision:
 *   1. The invoice's own explicitly stated unit (package_unit) -- reading
 *      what the invoice itself says is never a guess.
 *   2. line.confirmedInvoiceUnitCode -- already resolved, by
 *      getReceivingLines, with the correct priority between "this exact
 *      invoice line was already confirmed" (permanent, per-document) and
 *      "this vendor's SKU is normally billed in this unit" (mutable,
 *      vendor-wide) -- the line-level fact wins when both exist, which is
 *      exactly what keeps a historical invoice's meaning stable even if
 *      the vendor's remembered default changes years later.
 *   3. Unresolved -- the item's own purchase/packaging unit is NEVER used
 *      as a substitute for a missing invoice unit (see this file's
 *      top-level doc comment for why).
 * If the invoice DOES explicitly state a unit, and it disagrees with what
 * was remembered/previously confirmed, that is a conflict requiring
 * manager review, not a silent pick of either value.
 */
function resolveInvoiceUnit(line: ReceivingLineInfo): { unit: string | null; conflict: { invoiceUnit: string; rememberedUnit: string } | null } {
  const remembered = line.confirmedInvoiceUnitCode;
  if (line.invoicePackageUnit !== null) {
    if (remembered !== null && !unitsMatch(line.invoicePackageUnit, remembered)) {
      return { unit: null, conflict: { invoiceUnit: line.invoicePackageUnit, rememberedUnit: remembered } };
    }
    return { unit: line.invoicePackageUnit, conflict: null };
  }
  return { unit: remembered, conflict: null };
}

/**
 * The one place "Actually Received" is ever auto-populated from an
 * invoice. Most deliveries arrive in the quantity invoiced -- the manager
 * should be reviewing exceptions, not retyping a number the invoice
 * already gave us -- so this prefills whenever the invoice's own quantity
 * can be safely paired with a unit, and stays blank when the pairing is
 * unsafe or genuinely unknown.
 *
 * purchase_document_lines.package_quantity/package_unit is THE INVOICE'S
 * OWN stated billing quantity/unit for this specific delivery -- a
 * completely separate fact from inventory_item_units.conversion_factor,
 * the Item Master's own confirmed, org-wide case-pack configuration set
 * once at item-approval time. **These two facts must never be conflated.**
 * A missing invoice unit (package_unit is null) does NOT mean "assume the
 * item's confirmed purchase/packaging unit" -- a real Gansevoort DEV
 * invoice line exposed exactly why not: Bartlett "HEAVY CREAM 40% QUART
 * (12)" had package_quantity=48, package_unit=null, and the item's
 * confirmed purchase unit is CASE (1 CASE = 12 PIECE) -- but 48 is NOT "48
 * CASE" (that would be 576 individual quarts); it's actually 48 PIECE,
 * the item's BASE unit -- the "(12)" in the description is case-pack
 * configuration, not the invoice's billing unit. Guessing CASE here would
 * have silently 12x'd the received quantity. The only two sources ever
 * trusted for "what unit is this bare invoice quantity in" are (1) the
 * invoice's own stated package_unit, or (2) a separately-confirmed
 * vendor/current-line invoice-unit fact (line.confirmedInvoiceUnitCode --
 * see resolveInvoiceUnit above, and confirm_receiving_line_invoice_unit /
 * vendor_item_mappings.confirmed_invoice_unit_id for where it comes
 * from). The item's purchase/packaging unit is NEVER used as a fallback
 * guess for what the invoice meant.
 *
 * - SAME_UNIT: the item has only one relevant unit at all (no separate
 *   packaging concept), so a missing invoice unit safely falls back to
 *   the item's own base unit -- this fallback is intentionally NOT
 *   generalized to the packaged-item cases below.
 * - FIXED_CONVERSION: the resolved unit (see resolveInvoiceUnit) must
 *   equal either the item's purchase unit (then the received quantity is
 *   a case count, and the verified base quantity is computed via the
 *   fixed factor) or the item's base unit (then the bare quantity already
 *   IS the base-unit quantity -- no factor applies, it does not get
 *   multiplied). A resolved unit matching neither, an unresolvable unit,
 *   or a genuine invoice-vs-remembered conflict: nothing prefilled.
 * - MEASURE_EACH_DELIVERY / COUNT_EACH_DELIVERY: the resolved unit must
 *   equal the item's purchase/container unit (the received field here is
 *   always a container count). The verified weight/count field is NEVER
 *   prefilled here regardless -- it varies delivery to delivery by
 *   definition and must always be entered by hand.
 * - No confirmed receiving configuration, no invoice quantity at all, or
 *   an unresolvable/conflicting unit: nothing to prefill.
 */
/**
 * Recomputes the FIXED_CONVERSION verified base-unit quantity from a
 * manager-entered received quantity/unit pair -- the exact same math
 * computeReceivingPrefill's own FIXED_CONVERSION branch uses (line.
 * fixedConversionFactor when the received unit is the item's purchase
 * unit, no multiplication when it's already the base unit), exposed
 * separately so the receiving UI can keep the derived quantity in sync
 * whenever the manager edits Received Qty/Unit directly -- not only when
 * resolving an initially-ambiguous invoice unit. Returns "" (never a
 * stale/guessed number) whenever the quantity doesn't parse or the unit
 * doesn't resolve to either of the item's two known units -- adversarial
 * review finding: previously nothing recomputed this at all, so a
 * shortage/excess correction silently left a stale, wrong quantity
 * permanently stored in the append-only receipt.
 */
export function recomputeFixedConversionVerifiedQuantity(line: ReceivingLineInfo, receivedQuantity: string, receivedUnit: string): string {
  if (line.receivingBehavior !== "FIXED_CONVERSION") return "";
  const trimmedQuantity = receivedQuantity.trim();
  if (trimmedQuantity === "") return "";
  const quantity = Number(trimmedQuantity);
  if (!Number.isFinite(quantity)) return "";

  if (unitsEqual(receivedUnit, line.purchaseUnitCode) && line.fixedConversionFactor !== null) {
    return String(quantity * line.fixedConversionFactor);
  }
  if (unitsEqual(receivedUnit, line.baseUnitCode)) {
    return String(quantity);
  }
  return "";
}

export function computeReceivingPrefill(line: ReceivingLineInfo): ReceivingPrefill {
  if (line.disposition !== "INVENTORY" || line.invoicePackageQuantity === null) {
    return EMPTY;
  }

  switch (line.receivingBehavior) {
    case "SAME_UNIT": {
      if (unitsConflict(line.invoicePackageUnit, line.baseUnitCode) || line.baseUnitCode === null) return EMPTY;
      return { receivedQuantity: String(line.invoicePackageQuantity), receivedUnit: line.baseUnitCode, verifiedQuantity: "", conflict: null };
    }

    case "FIXED_CONVERSION": {
      const { unit, conflict } = resolveInvoiceUnit(line);
      if (conflict) return { ...EMPTY, conflict };
      if (unit === null || line.fixedConversionFactor === null) return EMPTY;

      if (unitsEqual(unit, line.purchaseUnitCode)) {
        const verified = line.invoicePackageQuantity * line.fixedConversionFactor;
        return { receivedQuantity: String(line.invoicePackageQuantity), receivedUnit: line.purchaseUnitCode, verifiedQuantity: String(verified), conflict: null };
      }
      if (unitsEqual(unit, line.baseUnitCode)) {
        // Already stated in base units -- the case-pack factor never
        // applies here, it does not get multiplied a second time.
        return { receivedQuantity: String(line.invoicePackageQuantity), receivedUnit: line.baseUnitCode, verifiedQuantity: String(line.invoicePackageQuantity), conflict: null };
      }
      return EMPTY;
    }

    case "MEASURE_EACH_DELIVERY":
    case "COUNT_EACH_DELIVERY": {
      const { unit, conflict } = resolveInvoiceUnit(line);
      if (conflict) return { ...EMPTY, conflict };
      if (unit === null || !unitsEqual(unit, line.purchaseUnitCode)) return EMPTY;
      return { receivedQuantity: String(line.invoicePackageQuantity), receivedUnit: line.purchaseUnitCode, verifiedQuantity: "", conflict: null };
    }

    default:
      return EMPTY;
  }
}
