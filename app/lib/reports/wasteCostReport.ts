import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listInventoryWasteEvents, type InventoryWasteEventSummary } from "@/app/lib/inventory/waste";
import { customRange } from "@/app/lib/dateRanges/calendarPeriods";
import { resolveHistoricalUnitCostsForItem, type HistoricalPriceOutcome } from "@/app/lib/ai/tasks/chat/itemPurchaseCost";
import { WASTE_REASON_LABEL } from "@/app/lib/reports/wasteReasonLabels";

/**
 * Ask Gansevoort -- Waste Cost Report data assembly. Read-only: reuses
 * the SAME authoritative sources as everything else in this app --
 * list_inventory_waste_events (the identical event-level RPC the Waste
 * activity views already use -- never withdrawals/cycle-count
 * adjustments/transfers, which live in separate tables entirely) and
 * resolveHistoricalUnitCostsForItem (the SAME partial-posting/
 * measurement/vendor-completeness/revision-safety-checked cost
 * resolution the item-cost chat tool uses, generalized to an arbitrary
 * "as of" date instead of "now").
 *
 * One historical-price resolution PER DISTINCT ITEM, not per waste line
 * -- events are grouped by item first, then resolveHistoricalUnitCostsForItem
 * is called once per item with every distinct as-of date that item's
 * waste events need, avoiding N RPC calls for N waste lines of the same
 * item.
 */

// Bounded export size -- a single request never processes an unbounded
// number of waste rows. Chosen generously relative to any realistic
// single-organization 90-day waste volume; if ever exceeded, the export
// fails closed (Section 10) rather than silently truncating.
const MAX_EXPORT_WASTE_ROWS = 5000;

export interface WasteCostLineRow {
  wasteEventId: string;
  inventoryItemId: string;
  wasteDate: string;
  wasteTime: string;
  locationName: string;
  itemName: string;
  categoryName: string | null;
  reasonCode: string;
  reasonLabel: string;
  quantity: number;
  baseUnitCode: string;
  unitPrice: number | null;
  priceUnitCode: string | null;
  estimatedCost: number | null;
  currency: string | null;
  costBasisDate: string | null;
  costBasisVendorName: string | null;
  costBasisDocumentId: string | null;
  costBasisDocumentNumber: string | null;
  pricingStatus: "priced" | "unpriced" | "not_requested";
  pricingLimitation: string | null;
  movementId: string;
}

export interface GetWasteCostReportOptions {
  locationId?: string | null;
  reasonCode?: string | null;
  /** Applied client-side after fetching -- list_inventory_waste_events has
   * no item filter parameter of its own. */
  inventoryItemId?: string | null;
  /** Default true. When false, historical price resolution is skipped
   * entirely (never run just to discard the result) and every line is
   * marked "not_requested" rather than "unpriced". */
  includePricing?: boolean;
}

export interface WasteCostByItemRow {
  itemName: string;
  categoryName: string | null;
  baseUnitCode: string;
  wasteQuantity: number;
  eventCount: number;
  pricedCount: number;
  unpricedCount: number;
  estimatedCost: number;
  priceCoveragePercent: number;
}

export interface WasteCostByReasonRow {
  reasonLabel: string;
  lineCount: number;
  pricedCount: number;
  unpricedCount: number;
  estimatedCost: number;
  priceCoveragePercent: number;
}

export interface WasteCostCurrencyTotal {
  currency: string;
  estimatedCost: number;
}

export interface WasteCostReport {
  startDate: string;
  endDate: string;
  pricingRequested: boolean;
  eventCount: number;
  lineCount: number;
  pricedCount: number;
  unpricedCount: number;
  priceCoveragePercent: number;
  currencyTotals: WasteCostCurrencyTotal[];
  lines: WasteCostLineRow[];
  byItem: WasteCostByItemRow[];
  byReason: WasteCostByReasonRow[];
}

export type GetWasteCostReportResult = { ok: true; report: WasteCostReport } | { ok: false; reason: "invalid_range" | "range_too_large" | "data_error"; message: string };

function emptyReport(startDate: string, endDate: string, pricingRequested: boolean): WasteCostReport {
  return { startDate, endDate, pricingRequested, eventCount: 0, lineCount: 0, pricedCount: 0, unpricedCount: 0, priceCoveragePercent: 0, currencyTotals: [], lines: [], byItem: [], byReason: [] };
}

function localDateString(isoTimestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(isoTimestamp));
}

function splitLocalDateTime(isoTimestamp: string, timeZone: string): { date: string; time: string } {
  const instant = new Date(isoTimestamp);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(instant);
  return { date: localDateString(isoTimestamp, timeZone), time };
}

function buildByItem(lines: WasteCostLineRow[]): WasteCostByItemRow[] {
  const map = new Map<
    string,
    { itemName: string; categoryName: string | null; baseUnitCode: string; wasteQuantity: number; eventCount: number; pricedCount: number; unpricedCount: number; estimatedCost: number }
  >();
  for (const line of lines) {
    // Grouped by (item, base unit) -- an item's base unit never varies
    // across its own waste events, so this can never combine two
    // genuinely different units into one quantity cell.
    const key = `${line.inventoryItemId}::${line.baseUnitCode}`;
    if (!map.has(key)) {
      map.set(key, { itemName: line.itemName, categoryName: line.categoryName, baseUnitCode: line.baseUnitCode, wasteQuantity: 0, eventCount: 0, pricedCount: 0, unpricedCount: 0, estimatedCost: 0 });
    }
    const agg = map.get(key)!;
    agg.wasteQuantity += line.quantity;
    agg.eventCount += 1;
    if (line.pricingStatus === "priced") {
      agg.pricedCount += 1;
      agg.estimatedCost += line.estimatedCost ?? 0;
    } else if (line.pricingStatus === "unpriced") {
      agg.unpricedCount += 1;
    }
  }
  return Array.from(map.values())
    .map((agg) => ({ ...agg, priceCoveragePercent: agg.eventCount > 0 ? (agg.pricedCount / agg.eventCount) * 100 : 0 }))
    .sort((a, b) => b.estimatedCost - a.estimatedCost);
}

function buildByReason(lines: WasteCostLineRow[]): WasteCostByReasonRow[] {
  const map = new Map<string, { reasonLabel: string; lineCount: number; pricedCount: number; unpricedCount: number; estimatedCost: number }>();
  for (const line of lines) {
    if (!map.has(line.reasonLabel)) map.set(line.reasonLabel, { reasonLabel: line.reasonLabel, lineCount: 0, pricedCount: 0, unpricedCount: 0, estimatedCost: 0 });
    const agg = map.get(line.reasonLabel)!;
    agg.lineCount += 1;
    if (line.pricingStatus === "priced") {
      agg.pricedCount += 1;
      agg.estimatedCost += line.estimatedCost ?? 0;
    } else if (line.pricingStatus === "unpriced") {
      agg.unpricedCount += 1;
    }
  }
  return Array.from(map.values())
    .map((agg) => ({ ...agg, priceCoveragePercent: agg.lineCount > 0 ? (agg.pricedCount / agg.lineCount) * 100 : 0 }))
    .sort((a, b) => b.estimatedCost - a.estimatedCost);
}

export async function getWasteCostReport(
  supabase: SupabaseClient,
  organizationId: string,
  timeZone: string,
  startDate: string,
  endDate: string,
  options: GetWasteCostReportOptions = {}
): Promise<GetWasteCostReportResult> {
  const includePricing = options.includePricing ?? true;
  const range = customRange(startDate, endDate, timeZone);
  if (typeof range === "string") {
    return { ok: false, reason: "invalid_range", message: "The requested date range is invalid." };
  }

  let events: InventoryWasteEventSummary[];
  try {
    events = await listInventoryWasteEvents(supabase, {
      organizationId,
      locationId: options.locationId ?? null,
      reasonCode: (options.reasonCode as InventoryWasteEventSummary["reasonCode"]) ?? null,
      fromDate: range.start.toISOString(),
      // range.end is exclusive (start of the day AFTER endDate) -- back
      // it up by 1ms so the request stays "on or before endDate" inclusive.
      toDate: new Date(range.end.getTime() - 1).toISOString(),
      limit: MAX_EXPORT_WASTE_ROWS + 1,
    });
  } catch (err) {
    return { ok: false, reason: "data_error", message: err instanceof Error ? err.message : "Could not load waste events." };
  }

  if (events.length > MAX_EXPORT_WASTE_ROWS) {
    return { ok: false, reason: "range_too_large", message: `This date range contains more than ${MAX_EXPORT_WASTE_ROWS} waste events. Narrow the range and try again.` };
  }
  if (options.inventoryItemId) {
    events = events.filter((e) => e.inventoryItemId === options.inventoryItemId);
  }
  if (events.length === 0) {
    return { ok: true, report: emptyReport(startDate, endDate, includePricing) };
  }

  const itemIds = Array.from(new Set(events.map((e) => e.inventoryItemId)));
  const { data: itemRows } = await supabase.from("inventory_items").select("id, category_id").eq("organization_id", organizationId).in("id", itemIds);
  const categoryIdByItemId = new Map(((itemRows ?? []) as { id: string; category_id: string | null }[]).map((r) => [r.id, r.category_id]));
  const categoryIds = Array.from(new Set(Array.from(categoryIdByItemId.values()).filter((id): id is string => Boolean(id))));
  const { data: categoryRows } =
    categoryIds.length > 0 ? await supabase.from("inventory_categories").select("id, name").eq("organization_id", organizationId).in("id", categoryIds) : { data: [] };
  const categoryNameById = new Map(((categoryRows ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name]));

  const eventsByItemId = new Map<string, InventoryWasteEventSummary[]>();
  for (const event of events) {
    if (!eventsByItemId.has(event.inventoryItemId)) eventsByItemId.set(event.inventoryItemId, []);
    eventsByItemId.get(event.inventoryItemId)!.push(event);
  }

  const priceOutcomeByEventId = new Map<string, HistoricalPriceOutcome>();
  if (includePricing) {
    for (const [itemId, itemEvents] of eventsByItemId) {
      const baseUnitCode = itemEvents[0].unitCode; // waste is always recorded in the item's own base unit
      const asOfDates = itemEvents.map((e) => localDateString(e.recordedAt, timeZone));
      const priceByAsOf = await resolveHistoricalUnitCostsForItem({ supabase, organizationId }, itemId, baseUnitCode, asOfDates);
      itemEvents.forEach((event, index) => {
        priceOutcomeByEventId.set(event.wasteEventId, priceByAsOf.get(asOfDates[index]) ?? { status: "no_price" });
      });
    }
  }

  const lines: WasteCostLineRow[] = events.map((event) => {
    const quantity = Number(event.quantity);
    const { date: wasteDate, time: wasteTime } = splitLocalDateTime(event.recordedAt, timeZone);
    const categoryId = categoryIdByItemId.get(event.inventoryItemId) ?? null;
    const categoryName = categoryId ? (categoryNameById.get(categoryId) ?? null) : null;
    const reasonLabel = WASTE_REASON_LABEL[event.reasonCode] ?? event.reasonCode;

    if (!includePricing) {
      return {
        wasteEventId: event.wasteEventId,
        inventoryItemId: event.inventoryItemId,
        wasteDate,
        wasteTime,
        locationName: event.locationName,
        itemName: event.itemName,
        categoryName,
        reasonCode: event.reasonCode,
        reasonLabel,
        quantity,
        baseUnitCode: event.unitCode,
        unitPrice: null,
        priceUnitCode: null,
        estimatedCost: null,
        currency: null,
        costBasisDate: null,
        costBasisVendorName: null,
        costBasisDocumentId: null,
        costBasisDocumentNumber: null,
        pricingStatus: "not_requested",
        pricingLimitation: null,
        movementId: event.inventoryMovementId,
      };
    }

    const outcome = priceOutcomeByEventId.get(event.wasteEventId) ?? { status: "no_price" as const };

    if (outcome.status === "resolved") {
      const estimatedCost = quantity * outcome.price.unitCostPerBaseUnit;
      return {
        wasteEventId: event.wasteEventId,
        inventoryItemId: event.inventoryItemId,
        wasteDate,
        wasteTime,
        locationName: event.locationName,
        itemName: event.itemName,
        categoryName,
        reasonCode: event.reasonCode,
        reasonLabel,
        quantity,
        baseUnitCode: event.unitCode,
        unitPrice: outcome.price.unitCostPerBaseUnit,
        priceUnitCode: outcome.price.baseUnitCode,
        estimatedCost,
        currency: outcome.price.currency,
        costBasisDate: outcome.price.documentDate,
        costBasisVendorName: outcome.price.vendorName,
        costBasisDocumentId: outcome.price.documentId,
        costBasisDocumentNumber: outcome.price.documentNumber,
        pricingStatus: "priced",
        pricingLimitation: null,
        movementId: event.inventoryMovementId,
      };
    }

    return {
      wasteEventId: event.wasteEventId,
      inventoryItemId: event.inventoryItemId,
      wasteDate,
      wasteTime,
      locationName: event.locationName,
      itemName: event.itemName,
      categoryName,
      reasonCode: event.reasonCode,
      reasonLabel,
      quantity,
      baseUnitCode: event.unitCode,
      unitPrice: null,
      priceUnitCode: null,
      estimatedCost: null,
      currency: null,
      costBasisDate: null,
      costBasisVendorName: null,
      costBasisDocumentId: null,
      costBasisDocumentNumber: null,
      pricingStatus: "unpriced",
      pricingLimitation: outcome.status === "incomplete" ? outcome.reason : "No verified purchase price was found on or before this waste event.",
      movementId: event.inventoryMovementId,
    };
  });

  const pricedCount = lines.filter((line) => line.pricingStatus === "priced").length;
  const unpricedCount = lines.filter((line) => line.pricingStatus === "unpriced").length;

  const currencyTotalsMap = new Map<string, number>();
  for (const line of lines) {
    if (line.pricingStatus === "priced" && line.currency && line.estimatedCost !== null) {
      currencyTotalsMap.set(line.currency, (currencyTotalsMap.get(line.currency) ?? 0) + line.estimatedCost);
    }
  }

  return {
    ok: true,
    report: {
      startDate,
      endDate,
      pricingRequested: includePricing,
      eventCount: events.length,
      lineCount: lines.length,
      pricedCount,
      unpricedCount,
      priceCoveragePercent: lines.length > 0 ? (pricedCount / lines.length) * 100 : 0,
      currencyTotals: Array.from(currencyTotalsMap.entries()).map(([currency, estimatedCost]) => ({ currency, estimatedCost })),
      lines,
      byItem: buildByItem(lines),
      byReason: buildByReason(lines),
    },
  };
}
