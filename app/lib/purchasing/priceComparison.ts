import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getReceivingLines, type ReceivingBehavior, type ReceivingLineInfo } from "@/app/lib/receiving/getReceivingLines";
import { getEffectiveReceivingLines } from "@/app/lib/receiving/effectiveReceivingEdit";
import { resolveInvoiceUnit, unitsConflict, unitsEqual } from "@/app/lib/receiving/computeReceivingPrefill";

/**
 * V1 Purchase Price Change Intelligence -- quiet purchasing intelligence
 * for Confirm Items, never a blocker, never AI-derived (fully
 * deterministic, built only from already-authoritative data). See
 * supabase/migrations/20260811100106_purchase_price_history.sql for the
 * read model this is built on.
 *
 * Every comparison is on a NORMALIZED BASE-UNIT COST basis (dollars per
 * the item's own canonical base unit -- e.g. $/LB, $/EA), never a raw
 * package price. This is deliberately more robust than "compare only
 * when the package size happens to match": a base-unit cost is the same
 * number regardless of whether this delivery came in a 12-count case or
 * a 24-count case, so a genuine price change is never hidden just
 * because the vendor repackaged, and two genuinely incompatible
 * quantities (a CASE price vs a PIECE price) can never be compared
 * blindly because both sides are always converted through the same
 * trusted path before any arithmetic happens.
 */

export type PriceComparisonUnavailableReason =
  | "NON_INVENTORY"
  | "UNRESOLVED"
  | "NO_VENDOR"
  | "FREE_LINE"
  | "CREDIT_LINE"
  | "MISSING_LINE_TOTAL"
  | "MISSING_CONVERSION"
  | "AWAITING_RECEIVING_CONFIRMATION"
  | "FIRST_PURCHASE";

export interface PriceHistoryPoint {
  purchaseDocumentId: string;
  documentNumber: string | null;
  documentDate: string | null;
  vendorName: string | null;
  unitCost: number;
}

export type PriceComparisonResult =
  | {
      available: true;
      currentUnitCost: number;
      baseUnitCode: string;
      previous: PriceHistoryPoint;
      deltaAbs: number;
      deltaPct: number;
      direction: "increase" | "decrease" | "unchanged";
    }
  | { available: false; reason: PriceComparisonUnavailableReason };

/**
 * The ONLY place base quantity is derived for a not-yet-posted current
 * line. **Bug fix (real Bartlett Heavy Cream regression):** this
 * previously multiplied `invoicePackageQuantity * fixedConversionFactor`
 * unconditionally for every FIXED_CONVERSION item, silently assuming the
 * invoice's bare quantity was always expressed in the item's PURCHASE
 * unit (e.g. CASE). That assumption is wrong whenever the vendor's
 * invoice already bills in the item's BASE unit instead -- exactly what
 * "HEAVY CREAM 40% QUART (12)" with invoice quantity 48 and price
 * $4.37808 proves (48 x $4.37808 = $210.15, the invoice's own amount;
 * the "(12)" is case-pack product metadata, not a statement that the
 * invoice bills by the case). The old code divided that already-correct
 * $4.37808/PIECE price by 12 a second time, producing $0.36484.
 *
 * The fix: reuse resolveInvoiceUnit (computeReceivingPrefill.ts) --
 * already built and already proven correct for this EXACT real invoice
 * line, for Confirm Receiving's own prefill -- to determine whether the
 * invoice's bare quantity resolves to the item's purchase unit (multiply
 * by the conversion factor) or its base unit (use directly, never
 * multiplied again). A conflicting or unresolvable unit yields no
 * comparison rather than a guess, exactly like Confirm Receiving's own
 * prefill leaves the field blank in that case.
 *
 * MEASURE_EACH_DELIVERY/COUNT_EACH_DELIVERY items have no fixed
 * conversion by design (the item is genuinely variable) -- the ONLY safe
 * source is the manager's own verified measurement from Confirm
 * Receiving; before that exists, this returns null rather than guessing.
 */
export function computeCurrentBaseQuantity(line: ReceivingLineInfo, verifiedBaseQuantity: number | null): number | null {
  if (line.invoicePackageQuantity === null || line.invoicePackageQuantity <= 0) return null;

  if (line.receivingBehavior === "SAME_UNIT") {
    if (unitsConflict(line.invoicePackageUnit, line.baseUnitCode) || line.baseUnitCode === null) return null;
    return line.invoicePackageQuantity;
  }

  if (line.receivingBehavior === "FIXED_CONVERSION") {
    const { unit, conflict } = resolveInvoiceUnit(line);
    if (conflict || unit === null) return null;
    if (unitsEqual(unit, line.purchaseUnitCode)) {
      if (line.fixedConversionFactor === null || line.fixedConversionFactor <= 0) return null;
      return line.invoicePackageQuantity * line.fixedConversionFactor;
    }
    if (unitsEqual(unit, line.baseUnitCode)) {
      // Already stated in base units -- the case-pack factor must NEVER
      // be applied here a second time. This branch is the fix.
      return line.invoicePackageQuantity;
    }
    return null;
  }

  if (line.receivingBehavior === "MEASURE_EACH_DELIVERY" || line.receivingBehavior === "COUNT_EACH_DELIVERY") {
    return verifiedBaseQuantity !== null && verifiedBaseQuantity > 0 ? verifiedBaseQuantity : null;
  }

  return null;
}

/**
 * Whether THIS line is even eligible for a price comparison at all, and
 * why not when it isn't -- deliberately checked before any arithmetic.
 * Free lines (line_total === 0) and credit lines (line_total < 0) are
 * real, legitimate line shapes (per the Capital Paper fix) but neither
 * produces a meaningful purchasing-price signal, so both are excluded
 * here rather than shown as a misleading 100% swing.
 */
export function classifyLineForPriceComparison(input: {
  disposition: "INVENTORY" | "NON_INVENTORY" | "UNRESOLVED";
  vendorId: string | null;
  lineTotal: number | null;
  baseQuantity: number | null;
  receivingBehavior: ReceivingBehavior | null;
}): { eligible: true } | { eligible: false; reason: PriceComparisonUnavailableReason } {
  if (input.disposition === "NON_INVENTORY") return { eligible: false, reason: "NON_INVENTORY" };
  if (input.disposition === "UNRESOLVED") return { eligible: false, reason: "UNRESOLVED" };
  if (!input.vendorId) return { eligible: false, reason: "NO_VENDOR" };
  if (input.lineTotal === null) return { eligible: false, reason: "MISSING_LINE_TOTAL" };
  if (input.lineTotal === 0) return { eligible: false, reason: "FREE_LINE" };
  if (input.lineTotal < 0) return { eligible: false, reason: "CREDIT_LINE" };
  if (input.baseQuantity === null) {
    // MEASURE_EACH_DELIVERY/COUNT_EACH_DELIVERY items have no fixed
    // conversion by design -- missing a base quantity for them is a
    // normal, expected wait for the manager's own verified measurement at
    // Confirm Receiving, never a data problem. Every other case (no
    // resolved receiving behavior at all, or a FIXED_CONVERSION/SAME_UNIT
    // item missing the factor/quantity it needs) is a genuine missing-
    // conversion condition.
    const awaitingManualMeasurement = input.receivingBehavior === "MEASURE_EACH_DELIVERY" || input.receivingBehavior === "COUNT_EACH_DELIVERY";
    return { eligible: false, reason: awaitingManualMeasurement ? "AWAITING_RECEIVING_CONFIRMATION" : "MISSING_CONVERSION" };
  }
  return { eligible: true };
}

// Mirrors the existing money-reconciliation tolerance already established
// in app/lib/ai/tasks/invoiceExtraction/validate.ts's approximatelyEqual
// (2 cents absolute, or 1% relative for larger amounts, whichever is
// looser) -- the same "is this dollar difference real or just ordinary
// rounding/extraction noise" judgment, applied here to current-vs-previous
// unit cost instead of extraction-vs-computed-total reconciliation. Not
// imported directly (that module is a different domain, AI extraction
// validation, not purchasing) -- the formula itself is the shared
// convention being reused, per the fix's own explicit instruction not to
// invent a new threshold where an established one already exists.
const UNCHANGED_ABSOLUTE_TOLERANCE = 0.02; // 2 cents
const UNCHANGED_RELATIVE_TOLERANCE = 0.01; // 1%

/** Pure arithmetic once both sides are already known-trustworthy numbers.
 * Full stored precision in, full precision out -- deltaPct is NEVER
 * computed from a UI-rounded display value; only formatting rounds. */
export function comparePrices(
  currentUnitCost: number,
  previousUnitCost: number
): { deltaAbs: number; deltaPct: number; direction: "increase" | "decrease" | "unchanged" } {
  const deltaAbs = currentUnitCost - previousUnitCost;
  const deltaPct = previousUnitCost !== 0 ? (deltaAbs / previousUnitCost) * 100 : 0;
  const tolerance = Math.max(UNCHANGED_ABSOLUTE_TOLERANCE, Math.abs(previousUnitCost) * UNCHANGED_RELATIVE_TOLERANCE);
  const direction: "increase" | "decrease" | "unchanged" = Math.abs(deltaAbs) <= tolerance ? "unchanged" : deltaAbs > 0 ? "increase" : "decrease";
  return { deltaAbs, deltaPct, direction };
}

interface PriceHistoryRow {
  out_inventory_item_id: string;
  out_rank: number;
  out_purchase_document_id: string;
  out_document_number: string | null;
  out_document_date: string | null;
  out_vendor_id: string;
  out_vendor_name: string | null;
  out_package_quantity: number | null;
  out_package_unit: string | null;
  out_line_total: number;
  out_base_quantity: number;
  out_base_unit_code: string | null;
  out_unit_cost: number;
}

/**
 * Batched (Part 47 "no N+1"): one RPC call covers every resolved
 * INVENTORY line on the document at once, not one call per line.
 */
export async function getPriceComparisonsForDocument(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  organizationId: string
): Promise<Map<string, PriceComparisonResult>> {
  const [{ data: purchaseDocument }, receivingLines, { data: lines }, effectiveReceivingLines] = await Promise.all([
    supabase.from("purchase_documents").select("vendor_id").eq("id", purchaseDocumentId).eq("organization_id", organizationId).maybeSingle(),
    getReceivingLines(supabase, purchaseDocumentId, organizationId),
    supabase.from("purchase_document_lines").select("line_key, line_total").eq("purchase_document_id", purchaseDocumentId).eq("organization_id", organizationId),
    getEffectiveReceivingLines(supabase, purchaseDocumentId, organizationId),
  ]);

  const vendorId = (purchaseDocument?.vendor_id as string | null | undefined) ?? null;
  const lineTotalByKey = new Map(((lines ?? []) as { line_key: string; line_total: number | null }[]).map((l) => [l.line_key, l.line_total]));

  // Multiple effective receipt lines can share the same matched_line_key
  // (a genuine additional/split delivery) -- summed, mirroring exactly how
  // the price-history RPC itself sums posted_base_quantity per line.
  const verifiedBaseQuantityByKey = new Map<string, number>();
  for (const rl of effectiveReceivingLines) {
    if (rl.matchedLineKey === null || rl.verifiedBaseQuantity === null) continue;
    verifiedBaseQuantityByKey.set(rl.matchedLineKey, (verifiedBaseQuantityByKey.get(rl.matchedLineKey) ?? 0) + rl.verifiedBaseQuantity);
  }

  interface Eligible {
    lineKey: string;
    inventoryItemId: string;
    baseUnitCode: string;
    currentUnitCost: number;
  }
  const results = new Map<string, PriceComparisonResult>();
  const eligible: Eligible[] = [];

  for (const info of receivingLines) {
    const lineTotal = lineTotalByKey.get(info.lineKey) ?? null;
    const baseQuantity = computeCurrentBaseQuantity(info, verifiedBaseQuantityByKey.get(info.lineKey) ?? null);
    const classification = classifyLineForPriceComparison({
      disposition: info.disposition,
      vendorId,
      lineTotal,
      baseQuantity,
      receivingBehavior: info.receivingBehavior,
    });
    if (!classification.eligible) {
      results.set(info.lineKey, { available: false, reason: classification.reason });
      continue;
    }
    // classification.eligible guarantees lineTotal > 0 and baseQuantity > 0.
    const currentUnitCost = (lineTotal as number) / (baseQuantity as number);
    eligible.push({ lineKey: info.lineKey, inventoryItemId: info.inventoryItemId as string, baseUnitCode: info.baseUnitCode as string, currentUnitCost });
  }

  if (eligible.length === 0 || !vendorId) return results;

  const itemIds = Array.from(new Set(eligible.map((e) => e.inventoryItemId)));
  const { data: historyRows } = await supabase.rpc("get_inventory_item_price_history", {
    p_organization_id: organizationId,
    p_vendor_id: vendorId,
    p_inventory_item_ids: itemIds,
    p_limit_per_item: 1,
  });
  const previousByItemId = new Map<string, PriceHistoryRow>();
  for (const row of (historyRows ?? []) as PriceHistoryRow[]) {
    if (row.out_rank === 1) previousByItemId.set(row.out_inventory_item_id, row);
  }

  for (const e of eligible) {
    const previousRow = previousByItemId.get(e.inventoryItemId);
    if (!previousRow) {
      results.set(e.lineKey, { available: false, reason: "FIRST_PURCHASE" });
      continue;
    }
    const { deltaAbs, deltaPct, direction } = comparePrices(e.currentUnitCost, previousRow.out_unit_cost);
    results.set(e.lineKey, {
      available: true,
      currentUnitCost: e.currentUnitCost,
      baseUnitCode: e.baseUnitCode,
      previous: {
        purchaseDocumentId: previousRow.out_purchase_document_id,
        documentNumber: previousRow.out_document_number,
        documentDate: previousRow.out_document_date,
        vendorName: previousRow.out_vendor_name,
        unitCost: previousRow.out_unit_cost,
      },
      deltaAbs,
      deltaPct,
      direction,
    });
  }

  return results;
}

/** The on-demand drill-down (Section 21) -- called only when a manager
 * expands one line's history, never eagerly for every line. */
export async function getPriceHistoryForItem(
  supabase: SupabaseClient,
  organizationId: string,
  vendorId: string,
  inventoryItemId: string,
  limit = 8
): Promise<PriceHistoryPoint[]> {
  const { data: historyRows } = await supabase.rpc("get_inventory_item_price_history", {
    p_organization_id: organizationId,
    p_vendor_id: vendorId,
    p_inventory_item_ids: [inventoryItemId],
    p_limit_per_item: limit,
  });
  return ((historyRows ?? []) as PriceHistoryRow[]).map((row) => ({
    purchaseDocumentId: row.out_purchase_document_id,
    documentNumber: row.out_document_number,
    documentDate: row.out_document_date,
    vendorName: row.out_vendor_name,
    unitCost: row.out_unit_cost,
  }));
}
