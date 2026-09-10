import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computePriceChange, type PriceChange } from "@/app/lib/inventory/priceHistoryPresentation";

/**
 * Vendor-aware Price History (Current Inventory item detail) -- typed
 * wrappers over get_item_price_history / get_item_price_history_summary
 * (20260811100149). Strictly HISTORICAL PURCHASE PRICING, never an
 * accounting inventory valuation: nothing here computes or implies
 * stock value, weighted-average cost, FIFO, or COGS.
 *
 * All eligibility/normalization decisions live in the SQL (one shared
 * item_price_history_events definition); this module only types the
 * rows, applies the currency-code normalization + group merge the SQL
 * deliberately leaves raw (currency is a free-text per-document field
 * -- real extractions contain "$" alongside "USD"), and derives the
 * latest-vs-previous change for the Overview panel.
 */

export type PriceUnavailableReason = "MISSING_LINE_AMOUNT" | "NON_POSITIVE_LINE_AMOUNT" | "NON_POSITIVE_QUANTITY" | "QUANTITY_MISMATCH";

export interface PriceHistoryEvent {
  purchaseDocumentId: string;
  /** The revision to LINK to -- the group's current verified revision
   * when the posted one was amended, else the posted document itself. */
  currentRevisionId: string;
  isAmended: boolean;
  documentNumber: string | null;
  documentDate: string | null;
  receivedAt: string;
  vendorId: string | null;
  vendorName: string | null;
  vendorSku: string | null;
  lineKey: string;
  packageQuantity: number | null;
  packageUnit: string | null;
  snapshotPurchaseUnitCode: string | null;
  snapshotReceivingBehavior: string | null;
  snapshotConversionFactor: number | null;
  lineTotal: number | null;
  currency: string;
  postedBaseQuantity: number;
  hasCorrection: boolean;
  correctionReason: string | null;
  authoritativeQuantity: number;
  baseUnitCode: string;
  /** Null whenever the price could not be computed safely -- callers
   * must render "price unavailable", never $0.00. */
  normalizedPrice: number | null;
  priceUnavailableReason: PriceUnavailableReason | null;
}

interface PriceHistoryRpcRow {
  out_purchase_document_id: string;
  out_current_revision_id: string;
  out_is_amended: boolean;
  out_document_number: string | null;
  out_document_date: string | null;
  out_received_at: string;
  out_vendor_id: string | null;
  out_vendor_name: string | null;
  out_vendor_sku: string | null;
  out_line_key: string;
  out_package_quantity: string | number | null;
  out_package_unit: string | null;
  out_snapshot_purchase_unit_code: string | null;
  out_snapshot_receiving_behavior: string | null;
  out_snapshot_conversion_factor: string | number | null;
  out_line_total: string | number | null;
  out_currency: string;
  out_posted_base_quantity: string | number;
  out_has_correction: boolean;
  out_correction_reason: string | null;
  out_authoritative_quantity: string | number;
  out_base_unit_code: string;
  out_normalized_price: string | number | null;
  out_price_unavailable_reason: string | null;
}

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const n = toNumber(value);
  return Number.isFinite(n) ? n : null;
}

/** "$"/"US$"/casing/whitespace are extraction artifacts for the same
 * dollar code -- normalized to a canonical code so the summary never
 * splits one real currency into two groups. This is symbol-to-code
 * normalization only; genuinely different codes are NEVER merged and no
 * exchange rate is ever applied. */
export function normalizeCurrencyCode(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "" || trimmed === "$" || trimmed.toUpperCase() === "US$") return "USD";
  return trimmed.toUpperCase();
}

function mapEvent(row: PriceHistoryRpcRow): PriceHistoryEvent {
  return {
    purchaseDocumentId: row.out_purchase_document_id,
    currentRevisionId: row.out_current_revision_id,
    isAmended: row.out_is_amended,
    documentNumber: row.out_document_number,
    documentDate: row.out_document_date,
    receivedAt: row.out_received_at,
    vendorId: row.out_vendor_id,
    vendorName: row.out_vendor_name,
    vendorSku: row.out_vendor_sku,
    lineKey: row.out_line_key,
    packageQuantity: toNullableNumber(row.out_package_quantity),
    packageUnit: row.out_package_unit,
    snapshotPurchaseUnitCode: row.out_snapshot_purchase_unit_code,
    snapshotReceivingBehavior: row.out_snapshot_receiving_behavior,
    snapshotConversionFactor: toNullableNumber(row.out_snapshot_conversion_factor),
    lineTotal: toNullableNumber(row.out_line_total),
    currency: normalizeCurrencyCode(row.out_currency),
    postedBaseQuantity: toNumber(row.out_posted_base_quantity),
    hasCorrection: row.out_has_correction,
    correctionReason: row.out_correction_reason,
    authoritativeQuantity: toNumber(row.out_authoritative_quantity),
    baseUnitCode: row.out_base_unit_code,
    normalizedPrice: toNullableNumber(row.out_normalized_price),
    priceUnavailableReason: (row.out_price_unavailable_reason as PriceUnavailableReason | null) ?? null,
  };
}

export interface PriceHistoryCursor {
  beforeReceivedAt: string;
  beforeDocumentId: string;
  beforeLineKey: string;
}

export interface PriceHistoryFilters {
  vendorId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface PriceHistoryPage {
  events: PriceHistoryEvent[];
  /** Cursor for the next (older) page; null when this page was short. */
  nextCursor: PriceHistoryCursor | null;
}

const PAGE_SIZE = 50;

export async function listItemPriceHistory(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  filters: PriceHistoryFilters = {},
  cursor: PriceHistoryCursor | null = null
): Promise<PriceHistoryPage> {
  const { data, error } = await supabase.rpc("get_item_price_history", {
    p_organization_id: organizationId,
    p_inventory_item_id: inventoryItemId,
    p_vendor_id: filters.vendorId ?? null,
    p_start_date: filters.startDate ?? null,
    p_end_date: filters.endDate ?? null,
    p_limit: PAGE_SIZE,
    p_before_received_at: cursor?.beforeReceivedAt ?? null,
    p_before_document_id: cursor?.beforeDocumentId ?? null,
    p_before_line_key: cursor?.beforeLineKey ?? null,
  });
  if (error) throw new Error(error.message);

  const events = ((data ?? []) as PriceHistoryRpcRow[]).map(mapEvent);
  const last = events[events.length - 1];
  return {
    events,
    nextCursor:
      events.length === PAGE_SIZE && last
        ? { beforeReceivedAt: last.receivedAt, beforeDocumentId: last.purchaseDocumentId, beforeLineKey: last.lineKey }
        : null,
  };
}

export interface VendorPriceSummary {
  vendorId: string | null;
  vendorName: string | null;
  currency: string;
  eventCount: number;
  latestPrice: number;
  latestReceivedAt: string;
  latestPackage: string | null;
  lowestPrice: number;
  highestPrice: number;
  firstPrice: number;
  firstReceivedAt: string;
}

interface SummaryRpcRow {
  out_vendor_id: string | null;
  out_vendor_name: string | null;
  out_currency: string;
  out_event_count: number;
  out_latest_price: string | number;
  out_latest_received_at: string;
  out_latest_package: string | null;
  out_lowest_price: string | number;
  out_highest_price: string | number;
  out_first_price: string | number;
  out_first_received_at: string;
}

/** Merges two same-(vendor, normalized-currency) aggregate rows -- the
 * SQL groups by the RAW currency string, so "$" and "USD" arrive as
 * separate rows for the same real currency and must be recombined
 * losslessly (sum counts, min/max extremes, latest/first by timestamp). */
function mergeSummaries(a: VendorPriceSummary, b: VendorPriceSummary): VendorPriceSummary {
  const aLatest = a.latestReceivedAt >= b.latestReceivedAt;
  const aFirst = a.firstReceivedAt <= b.firstReceivedAt;
  return {
    vendorId: a.vendorId,
    vendorName: a.vendorName ?? b.vendorName,
    currency: a.currency,
    eventCount: a.eventCount + b.eventCount,
    latestPrice: aLatest ? a.latestPrice : b.latestPrice,
    latestReceivedAt: aLatest ? a.latestReceivedAt : b.latestReceivedAt,
    latestPackage: aLatest ? a.latestPackage : b.latestPackage,
    lowestPrice: Math.min(a.lowestPrice, b.lowestPrice),
    highestPrice: Math.max(a.highestPrice, b.highestPrice),
    firstPrice: aFirst ? a.firstPrice : b.firstPrice,
    firstReceivedAt: aFirst ? a.firstReceivedAt : b.firstReceivedAt,
  };
}

export interface PriceHistorySummary {
  /** Aggregates for the currency of the most recent priced purchase --
   * the ONLY currency the summary strip/chart may present as one trend. */
  overall: VendorPriceSummary | null;
  /** Per-vendor rows in the same currency as `overall`, most purchases
   * first -- powers Vendor Comparison. */
  vendors: VendorPriceSummary[];
  /** Count of priced events in OTHER currencies, excluded from the
   * summary/chart and disclosed in the UI (never silently combined). */
  otherCurrencyEventCount: number;
}

export async function getItemPriceHistorySummary(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  filters: PriceHistoryFilters = {}
): Promise<PriceHistorySummary> {
  const { data, error } = await supabase.rpc("get_item_price_history_summary", {
    p_organization_id: organizationId,
    p_inventory_item_id: inventoryItemId,
    p_vendor_id: filters.vendorId ?? null,
    p_start_date: filters.startDate ?? null,
    p_end_date: filters.endDate ?? null,
  });
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as SummaryRpcRow[]).map(
    (r): VendorPriceSummary => ({
      vendorId: r.out_vendor_id,
      vendorName: r.out_vendor_name,
      currency: normalizeCurrencyCode(r.out_currency),
      eventCount: r.out_event_count,
      latestPrice: toNumber(r.out_latest_price),
      latestReceivedAt: r.out_latest_received_at,
      latestPackage: r.out_latest_package,
      lowestPrice: toNumber(r.out_lowest_price),
      highestPrice: toNumber(r.out_highest_price),
      firstPrice: toNumber(r.out_first_price),
      firstReceivedAt: r.out_first_received_at,
    })
  );

  // Recombine rows the raw-currency SQL grouping split apart.
  const merged = new Map<string, VendorPriceSummary>();
  for (const row of rows) {
    const key = `${row.vendorId ?? "ALL"}:${row.currency}`;
    const existing = merged.get(key);
    merged.set(key, existing ? mergeSummaries(existing, row) : row);
  }

  const overallRows = [...merged.values()].filter((r) => r.vendorId === null);
  if (overallRows.length === 0) return { overall: null, vendors: [], otherCurrencyEventCount: 0 };

  // The presented currency is the one the most recent purchase used.
  const presented = overallRows.reduce((a, b) => (a.latestReceivedAt >= b.latestReceivedAt ? a : b));
  const otherCurrencyEventCount = overallRows.filter((r) => r !== presented).reduce((n, r) => n + r.eventCount, 0);
  const vendors = [...merged.values()]
    .filter((r) => r.vendorId !== null && r.currency === presented.currency)
    .sort((a, b) => b.eventCount - a.eventCount || (a.vendorName ?? "").localeCompare(b.vendorName ?? ""));

  return { overall: presented, vendors, otherCurrencyEventCount };
}

export interface LatestPurchasePrice {
  latest: PriceHistoryEvent;
  previous: PriceHistoryEvent | null;
  change: PriceChange | null;
}

/**
 * Overview's "Latest Purchase Price" panel -- the most recent PRICED
 * event plus the previous priced event in the SAME currency (spec: a
 * change line must never compare across currencies). Scans at most one
 * page; if no priced event exists in the newest page, the panel shows
 * its empty state rather than digging arbitrarily deep.
 */
export async function getLatestPurchasePriceForOverview(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string
): Promise<LatestPurchasePrice | null> {
  const page = await listItemPriceHistory(supabase, organizationId, inventoryItemId);
  const priced = page.events.filter((e) => e.normalizedPrice !== null);
  const latest = priced[0];
  if (!latest) return null;
  const previous = priced.find((e) => e !== latest && e.currency === latest.currency) ?? null;
  return {
    latest,
    previous,
    change: computePriceChange(latest.normalizedPrice, previous?.normalizedPrice ?? null),
  };
}
