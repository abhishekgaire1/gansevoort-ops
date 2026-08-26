import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ask Gansevoort -- item-level purchase cost lookup.
 *
 * Reuses the SAME authoritative, already-established normalization
 * pattern as Purchase Price Change Intelligence
 * (get_inventory_item_price_history, 20260811100106, and its TS caller
 * app/lib/purchasing/priceComparison.ts): unit cost is always
 * purchase_document_lines.line_total divided by a base-unit quantity --
 * never a fresh client-side unit conversion, and never averaged from
 * individual unit prices without quantity weighting. This file adds NO
 * new SQL/RPC and NO migration.
 *
 * ============================================================
 * Final correctness closure (this file's third revision)
 * ============================================================
 * Three additional gaps closed here, each with the same posture: when a
 * fact cannot be PROVEN from existing authoritative data, the row/vendor/
 * result is excluded or downgraded -- never silently trusted, never
 * "fixed" by guessing.
 *
 * 1. MEASURED/MANUAL-COUNT ITEMS: a purchase whose base quantity depends
 *    on a per-delivery measurement (MEASURE_EACH_DELIVERY/
 *    COUNT_EACH_DELIVERY -- no fixed conversion factor by design) can no
 *    longer contribute to an `exact` result AT ALL. Previously such rows
 *    were included with a disclosed caveat; that is no longer considered
 *    sufficient for a financial answer. They are now fully excluded
 *    (tracked in excludedUnverifiableMeasurementCount), and if nothing
 *    else survives, the result is `no_verified_cost`.
 *
 * 2. TOLERANCE AND DENOMINATOR: the prior 1%-of-quantity relative
 *    tolerance could accept e.g. posted=99 against expected=100 (a whole
 *    unit short) as "close enough," and then divided by the SHORT posted
 *    quantity -- silently overstating cost. Tolerance is now a small,
 *    FIXED absolute amount only (COMPLETION_ABSOLUTE_TOLERANCE, decimal-
 *    rounding-noise sized, never growing with quantity), and once a line
 *    passes that check, the calculation ALWAYS divides by the
 *    authoritative EXPECTED full base quantity -- never the raw posted
 *    figure, even when it technically fell inside tolerance. $500 over
 *    an expected 100 base units is always $5.00, never $500/99.
 *
 * 3. VENDOR-CAP COMPLETENESS: vendor discovery is now EXPLICITLY
 *    paginated (discoverVendorIds/VENDOR_DISCOVERY_PAGE_SIZE) -- never a
 *    single unbounded `.in(...)`/select with no `.limit()`. Supabase/
 *    PostgREST can enforce its own implicit server-side row cap even
 *    when the application supplies none, which would let a query LOOK
 *    complete while silently truncating -- an unbounded query can never
 *    prove it saw everything. Discovery instead reads fixed-size pages
 *    in a stable, uniquely-tie-broken order (posting-line id, keyset
 *    pagination) and only ever concludes "complete" when a page comes
 *    back shorter than the page size (the one condition that PROVES no
 *    more rows exist -- never inferred from an implicit limit). It stops
 *    the instant more than MAX_VENDORS distinct vendors are seen (no
 *    further pages, no further per-vendor RPC calls -- the result is
 *    already going to be `incomplete` either way), and if a documented
 *    scan-safety ceiling of pages is reached without ever proving
 *    exhaustion, or if any single page's query fails, the result is
 *    `incomplete` too -- never computed from a partial vendor set.
 *
 * 4. AMENDMENT/REVISION SAFETY: purchase_documents carries
 *    revision_group_id/revision_number, and an amendment
 *    (initiate_purchase_document_amendment, 20260811100029/100033)
 *    creates a NEW row rather than mutating the old one -- the prior
 *    revision's own `status` is never demoted away from VERIFIED, so
 *    the "current" revision is identified ONLY by holding the highest
 *    revision_number among VERIFIED rows in its group. This is the EXACT
 *    rule current_verified_purchase_document_revision_id already applies
 *    (verified by reading that function's own SQL, not assumed) --
 *    replicated here in application code (never a new RPC/migration)
 *    over the small, already-fetched set of relevant documents, so a
 *    superseded revision's posting data can never be selected as the
 *    latest purchase or folded into the weighted average.
 */

// Deliberately much larger than any display/evidence cap -- this bounds
// the AGGREGATION input, not what is ever shown to the model/manager.
// Bounded (never literally unlimited), but generous enough that
// truncation for one item's real purchase frequency within a 90-day
// window is the exceptional case this module explicitly detects and
// discloses rather than silently ignores.
const AGGREGATE_HISTORY_LIMIT_PER_VENDOR = 500;
// The most vendors this module is willing to fully process for one
// lookup. If more than this many distinct vendors are found during
// discovery, the result is reported `incomplete` rather than silently
// processing only the first MAX_VENDORS.
const MAX_VENDORS = 20;
// Fixed page size for vendor-discovery pagination -- deliberately
// explicit rather than relying on any implicit server-side default.
const VENDOR_DISCOVERY_PAGE_SIZE = 200;
// Documented scan-safety ceiling: at most this many pages (i.e. at most
// VENDOR_DISCOVERY_MAX_PAGES * VENDOR_DISCOVERY_PAGE_SIZE posting-line
// records) are ever scanned for one lookup. Reaching this ceiling without
// a page ever coming back short means exhaustion was never proven, so
// the result is `incomplete` -- never assumed complete just because
// only MAX_VENDORS-or-fewer vendors happened to appear in what WAS scanned.
const VENDOR_DISCOVERY_MAX_PAGES = 25;
// A small, FIXED absolute tolerance for decimal/rounding noise ONLY --
// deliberately NOT a percentage of quantity (a percentage would let an
// increasingly large absolute shortfall pass as "complete" the bigger an
// order gets, which is exactly the defect being closed here).
const COMPLETION_ABSOLUTE_TOLERANCE = 0.01;

export const ITEM_COST_BASE_LIMITATIONS = [
  "Reflects the verified purchase line amount only -- excludes unallocated document-level tax, freight, or other charges.",
  "Only purchases that were verified AND actually posted to inventory are counted -- a draft or awaiting-verification document never contributes.",
  "Credit and free lines (zero or negative line amount) are excluded, matching the existing Purchasing Report's own convention -- this is a verified purchase price, never a net-of-credits cost.",
] as const;

export interface ResolvedItem {
  id: string;
  name: string;
  baseUnitCode: string;
}

export interface LatestVerifiedPurchase {
  vendorId: string;
  vendorName: string;
  documentId: string;
  documentNumber: string | null;
  documentDate: string;
  packageQuantity: number | null;
  packageUnit: string | null;
  lineTotal: number;
  /** The AUTHORITATIVE expected full base-unit quantity -- never the
   * raw posted quantity, even when the two differ by less than the
   * completion tolerance. */
  baseQuantity: number;
  baseUnitCode: string;
  unitCostPerBaseUnit: number;
  /** null when the original package quantity is missing/zero. */
  unitCostPerPackage: number | null;
}

export interface WeightedAverageCost {
  windowDays: number;
  startDate: string;
  endDate: string;
  totalEligibleLineAmount: number;
  totalEligibleBaseQuantity: number;
  weightedAverageBaseUnitCost: number;
  recordCount: number;
}

export interface ItemPurchaseCostExact {
  status: "exact";
  item: ResolvedItem;
  latest: LatestVerifiedPurchase;
  /** Always true when status is "exact" -- a structural guarantee, not a
   * variable outcome: this status is only ever returned once every
   * exclusion/completeness check below has already been applied. */
  latestPurchaseComplete: true;
  weightedAverage: WeightedAverageCost | null;
  weightedAverageComplete: boolean;
  /** True only when weightedAverage is null because the eligible-period
   * sample could not be proven complete (vendor pool truncation) --
   * distinct from "genuinely zero eligible purchases in this window,"
   * which also yields weightedAverage: null but this flag false. */
  weightedAverageTruncated: boolean;
  /** How many otherwise-eligible rows were excluded because posted
   * quantity did not reach the authoritative expected full quantity. */
  excludedPartialCount: number;
  /** How many rows were excluded because their base quantity depends on
   * a per-delivery measurement with no fixed conversion factor, so
   * completeness could not be proven at all. */
  excludedUnverifiableMeasurementCount: number;
  /** Always false when status is "exact" (see the "incomplete" status
   * for the vendor-overflow case). */
  vendorSetTruncated: false;
  /** Always true when status is "exact" -- explicit attestation that
   * every candidate was checked against its revision group's current
   * VERIFIED revision before being used. */
  revisionSafetyVerified: true;
  limitations: string[];
}

export type ItemPurchaseCostLookup =
  | { status: "not_found" }
  | { status: "ambiguous"; candidateNames: string[] }
  | { status: "no_verified_cost"; item: ResolvedItem }
  /** Neither a latest price nor a weighted average can be safely
   * presented -- currently only reached via vendor-set overflow (more
   * than MAX_VENDORS distinct vendors), where processing only a subset
   * could silently miss the true organization-wide latest purchase. */
  | { status: "incomplete"; item: ResolvedItem; reason: string }
  | ItemPurchaseCostExact;

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

type ItemResolution =
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "exact"; id: string; name: string; baseUnitId: string };

/**
 * Item names are guaranteed unique per organization, case-insensitively,
 * by inventory_items_org_lower_name_key (a real DB unique index, not an
 * assumption) -- so an "exact" case-insensitive match can never be
 * ambiguous. Ambiguity can only arise from the substring fallback below,
 * and is always surfaced explicitly rather than silently resolved.
 */
async function resolveItemByName(supabase: SupabaseClient, organizationId: string, rawQuery: string): Promise<ItemResolution> {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return { status: "not_found" };

  const { data } = await supabase.from("inventory_items").select("id, name, base_unit_id").eq("organization_id", organizationId);
  const items = (data ?? []) as { id: string; name: string; base_unit_id: string }[];

  const exact = items.filter((i) => i.name.trim().toLowerCase() === query);
  if (exact.length === 1) return { status: "exact", id: exact[0].id, name: exact[0].name, baseUnitId: exact[0].base_unit_id };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact.map((i) => i.name) };

  const substring = items.filter((i) => {
    const name = i.name.toLowerCase();
    return name.includes(query) || query.includes(name);
  });
  if (substring.length === 1) return { status: "exact", id: substring[0].id, name: substring[0].name, baseUnitId: substring[0].base_unit_id };
  if (substring.length > 1) return { status: "ambiguous", candidates: substring.slice(0, 5).map((i) => i.name) };

  return { status: "not_found" };
}

export type VendorDiscoveryResult =
  | { status: "complete"; vendorIds: string[] }
  /** More than MAX_VENDORS distinct vendors were already seen -- stopped
   * scanning immediately; the caller must never process any of them as
   * if this were the complete vendor set. */
  | { status: "overflow" }
  /** VENDOR_DISCOVERY_MAX_PAGES pages were scanned and every one came
   * back full -- exhaustion was never proven, so more vendors might
   * still exist beyond what was scanned. */
  | { status: "ceiling_reached" }
  /** A page's own query failed -- never compute from the pages that DID
   * succeed; the whole discovery is treated as unavailable. */
  | { status: "page_error" };

/**
 * Explicit, deterministic, keyset-paginated vendor discovery -- replaces
 * a prior unbounded `.in(...)` query. Supabase/PostgREST can enforce its
 * own implicit maximum row count even when the application supplies no
 * `.limit()`, which would let a query LOOK complete while silently
 * truncating; an unbounded query can never prove it saw every row. This
 * function instead reads fixed-size pages of
 * purchase_document_inventory_posting_lines ordered by its own primary
 * key (`id` -- already unique, so it is its own stable tie-breaker; no
 * separate tie-break column is needed), using keyset pagination
 * (`id > lastSeenId`) rather than OFFSET (keyset never skips/duplicates
 * rows if data changes between pages). Each page's own posting-line
 * batch drives that page's own bounded postings/documents lookups (never
 * more than VENDOR_DISCOVERY_PAGE_SIZE ids at a time), so no step in the
 * whole discovery pipeline is ever unbounded.
 *
 * Vendor active/inactive status is deliberately NOT filtered: a purchase
 * from a since-deactivated vendor is still a real historical financial
 * fact.
 */
async function discoverVendorIds(supabase: SupabaseClient, organizationId: string, inventoryItemId: string): Promise<VendorDiscoveryResult> {
  const vendorIds = new Set<string>();
  let lastId: string | null = null;

  for (let page = 0; page < VENDOR_DISCOVERY_MAX_PAGES; page++) {
    let query = supabase
      .from("purchase_document_inventory_posting_lines")
      .select("id, posting_id")
      .eq("organization_id", organizationId)
      .eq("inventory_item_id", inventoryItemId)
      .order("id", { ascending: true })
      .limit(VENDOR_DISCOVERY_PAGE_SIZE);
    if (lastId !== null) query = query.gt("id", lastId);

    const { data: postingLinesPage, error: postingLinesError } = await query;
    if (postingLinesError) return { status: "page_error" };
    const pageRows = (postingLinesPage ?? []) as { id: string; posting_id: string }[];
    if (pageRows.length === 0) {
      // An empty page (including the very first) PROVES no more rows
      // exist -- the only condition this module ever treats as exhaustion.
      return { status: "complete", vendorIds: Array.from(vendorIds) };
    }

    const pagePostingIds = Array.from(new Set(pageRows.map((r) => r.posting_id)));
    const { data: postingsPage, error: postingsError } = await supabase
      .from("purchase_document_inventory_postings")
      .select("purchase_document_id")
      .eq("organization_id", organizationId)
      .in("id", pagePostingIds);
    if (postingsError) return { status: "page_error" };
    const pageDocumentIds = Array.from(new Set(((postingsPage ?? []) as { purchase_document_id: string }[]).map((r) => r.purchase_document_id)));

    if (pageDocumentIds.length > 0) {
      const { data: documentsPage, error: documentsError } = await supabase
        .from("purchase_documents")
        .select("vendor_id")
        .eq("organization_id", organizationId)
        .in("id", pageDocumentIds);
      if (documentsError) return { status: "page_error" };
      for (const d of (documentsPage ?? []) as { vendor_id: string | null }[]) {
        if (d.vendor_id) vendorIds.add(d.vendor_id);
      }
    }

    if (vendorIds.size > MAX_VENDORS) {
      // Overflow already proven -- stop scanning immediately, and never
      // make a per-vendor get_inventory_item_price_history RPC call for
      // any of them, since the result is incomplete regardless.
      return { status: "overflow" };
    }

    lastId = pageRows[pageRows.length - 1].id;
    if (pageRows.length < VENDOR_DISCOVERY_PAGE_SIZE) {
      // A short page proves exhaustion just as much as an empty one.
      return { status: "complete", vendorIds: Array.from(vendorIds) };
    }
  }

  // Every page came back full -- exhaustion was never proven.
  return { status: "ceiling_reached" };
}

interface ItemUnitConfig {
  conversionFactor: number | null;
  requiresActualMeasurement: boolean;
}

/** Fetched ONCE per lookup (not per row, not per vendor) -- LEGACY
 * fallback only. inventory_item_units is the shared, per-item table the
 * purchase-versus-usage unit model (20260811100119/100120) now treats as
 * "vestigial" the moment a vendor-specific vendor_item_purchase_units row
 * exists for a unit code -- it can hold only ONE factor per (item, unit)
 * at a time, so trusting it here would let a second vendor's (or SKU's)
 * later-configured factor silently reprice an EARLIER purchase that used
 * the SAME unit code from a DIFFERENT vendor/SKU. Used ONLY when no
 * vendor-specific package version exists for a given row (pre-model data,
 * or a genuinely un-migrated item) -- see fetchVendorPackageVersions/
 * resolveVendorPackageAsOf for the authoritative, vendor-scoped path. */
async function fetchLegacyItemUnitConfigByCode(supabase: SupabaseClient, inventoryItemId: string): Promise<Map<string, ItemUnitConfig>> {
  const { data } = await supabase
    .from("inventory_item_units")
    .select("conversion_factor, requires_actual_measurement, units(code)")
    .eq("inventory_item_id", inventoryItemId);
  const map = new Map<string, ItemUnitConfig>();
  for (const row of (data ?? []) as { conversion_factor: number | null; requires_actual_measurement: boolean; units: { code?: string } | { code?: string }[] | null }[]) {
    const unit = Array.isArray(row.units) ? row.units[0] : row.units;
    const code = unit?.code;
    if (!code) continue;
    map.set(code.toUpperCase(), { conversionFactor: row.conversion_factor, requiresActualMeasurement: row.requires_actual_measurement });
  }
  return map;
}

interface VendorPackageVersion extends ItemUnitConfig {
  purchaseUnitCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** EVERY confirmed purchase-package VERSION (not only the currently
 * active one) this vendor has ever had for this item -- fetched once per
 * vendor per lookup, never per row. Superseded versions are deliberately
 * included: resolveVendorPackageAsOf below is what lets a historical
 * purchase be evaluated against the package that was ACTUALLY in effect
 * on its own document date, never today's current package (approved-plan
 * §14 -- "never use a current vendor package to reprice history"). */
async function fetchVendorPackageVersions(
  supabase: SupabaseClient,
  organizationId: string,
  inventoryItemId: string,
  vendorId: string
): Promise<VendorPackageVersion[]> {
  const { data } = await supabase
    .from("vendor_item_purchase_units")
    .select("conversion_factor, requires_actual_measurement, effective_from, effective_to, units(code)")
    .eq("organization_id", organizationId)
    .eq("inventory_item_id", inventoryItemId)
    .eq("vendor_id", vendorId);

  const versions: VendorPackageVersion[] = [];
  for (const row of (data ?? []) as {
    conversion_factor: number | null;
    requires_actual_measurement: boolean;
    effective_from: string;
    effective_to: string | null;
    units: { code?: string } | { code?: string }[] | null;
  }[]) {
    const unit = Array.isArray(row.units) ? row.units[0] : row.units;
    const code = unit?.code;
    if (!code) continue;
    versions.push({
      purchaseUnitCode: code.toUpperCase(),
      conversionFactor: row.conversion_factor,
      requiresActualMeasurement: row.requires_actual_measurement,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    });
  }
  return versions;
}

/** Picks whichever version's effective range covers documentDate,
 * compared at end-of-day so a purchase dated the SAME calendar day as a
 * package's effective_from still counts (mirrors this module's existing
 * "on or before" asOf convention elsewhere). Returns null when no version
 * claims this unit code as of that date -- the caller falls back to the
 * legacy shared table, never guesses. */
function resolveVendorPackageAsOf(versions: VendorPackageVersion[], unitCode: string, documentDate: string): ItemUnitConfig | null {
  const asOf = `${documentDate}T23:59:59.999Z`;
  const candidates = versions.filter((v) => v.purchaseUnitCode === unitCode && v.effectiveFrom <= asOf && (v.effectiveTo === null || v.effectiveTo > asOf));
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => (a.effectiveFrom > b.effectiveFrom ? a : b));
  return { conversionFactor: best.conversionFactor, requiresActualMeasurement: best.requiresActualMeasurement };
}

/** The line's EXPECTED FULL base-unit quantity, independent of how much
 * has posted so far -- null when it cannot be determined deterministically
 * (missing package info, or an item purchased in a unit requiring actual
 * per-delivery measurement, which has no fixed conversion by design).
 * Resolves the conversion via THIS vendor's own package version as of the
 * row's document date first; only consults the legacy shared per-item
 * table when no vendor-specific version claims that unit code at all
 * (approved-plan §14). */
function expectedFullBaseQuantity(row: PriceHistoryRow, baseUnitCode: string, legacyUnitConfigByCode: Map<string, ItemUnitConfig>, vendorPackageVersions: VendorPackageVersion[]): number | null {
  if (row.out_package_quantity === null || row.out_package_quantity <= 0 || !row.out_package_unit) return null;
  const packageUnitCode = row.out_package_unit.toUpperCase();
  if (packageUnitCode === baseUnitCode.toUpperCase()) {
    return row.out_package_quantity; // SAME_UNIT -- package IS the base unit, no conversion needed
  }
  const vendorConfig = row.out_document_date ? resolveVendorPackageAsOf(vendorPackageVersions, packageUnitCode, row.out_document_date) : null;
  const config = vendorConfig ?? legacyUnitConfigByCode.get(packageUnitCode) ?? null;
  if (!config || config.requiresActualMeasurement || config.conversionFactor === null || config.conversionFactor <= 0) {
    return null; // MEASURE_EACH_DELIVERY/COUNT_EACH_DELIVERY, or no known fixed conversion
  }
  return row.out_package_quantity * config.conversionFactor;
}

/** True only when the row's already-posted base_quantity is within a
 * small, FIXED absolute tolerance of the line's expected full quantity --
 * deliberately never a percentage of quantity (see module doc comment,
 * gap 2). A null expected quantity always returns false. */
function isProvenComplete(row: PriceHistoryRow, expected: number | null): boolean {
  if (expected === null) return false;
  return row.out_base_quantity >= expected - COMPLETION_ABSOLUTE_TOLERANCE;
}

/** Deterministic ordering used for BOTH "pick the global latest" and
 * "break a same-date tie" -- mirrors the RPC's own
 * `order by document_date desc nulls last, purchase_document_id desc`
 * exactly. */
function isNewer(a: PriceHistoryRow, b: PriceHistoryRow): boolean {
  const aDate = a.out_document_date ?? "";
  const bDate = b.out_document_date ?? "";
  if (aDate !== bDate) return aDate > bDate;
  return a.out_purchase_document_id > b.out_purchase_document_id;
}

interface PurchaseDocumentRevisionRow {
  id: string;
  revision_group_id: string;
  revision_number: number;
  status: string;
}

/**
 * Applies the EXACT SAME rule public.current_verified_purchase_document_
 * revision_id already uses (verified by reading that function's SQL,
 * 20260811100029): within a revision_group, the current revision is the
 * highest revision_number among rows whose status is VERIFIED. Amending
 * a document never demotes the prior revision's status away from
 * VERIFIED -- it is distinguished ONLY by revision_number -- so this
 * check cannot be skipped or assumed away.
 *
 * Two flat, org-scoped reads (never more, regardless of history depth):
 * one to learn each candidate row's revision_group_id, one to learn
 * every VERIFIED revision_number within just those groups.
 */
async function filterToCurrentRevisions(supabase: SupabaseClient, organizationId: string, rows: PriceHistoryRow[]): Promise<PriceHistoryRow[]> {
  if (rows.length === 0) return rows;
  const documentIds = Array.from(new Set(rows.map((r) => r.out_purchase_document_id)));

  const { data: docs } = await supabase
    .from("purchase_documents")
    .select("id, revision_group_id, revision_number, status")
    .eq("organization_id", organizationId)
    .in("id", documentIds);
  const docById = new Map(((docs ?? []) as PurchaseDocumentRevisionRow[]).map((d) => [d.id, d]));

  const groupIds = Array.from(new Set(Array.from(docById.values()).map((d) => d.revision_group_id)));
  const { data: groupDocs } =
    groupIds.length > 0
      ? await supabase.from("purchase_documents").select("id, revision_group_id, revision_number, status").eq("organization_id", organizationId).in("revision_group_id", groupIds)
      : { data: [] };

  const currentByGroup = new Map<string, { id: string; revisionNumber: number }>();
  for (const d of (groupDocs ?? []) as PurchaseDocumentRevisionRow[]) {
    if (d.status !== "VERIFIED") continue;
    const existing = currentByGroup.get(d.revision_group_id);
    if (!existing || d.revision_number > existing.revisionNumber) {
      currentByGroup.set(d.revision_group_id, { id: d.id, revisionNumber: d.revision_number });
    }
  }

  return rows.filter((row) => {
    const doc = docById.get(row.out_purchase_document_id);
    if (!doc) return false; // could not confirm this document's own revision group -- never trust it by default
    const current = currentByGroup.get(doc.revision_group_id);
    return current?.id === row.out_purchase_document_id;
  });
}

export interface ItemPurchaseCostContext {
  supabase: SupabaseClient;
  organizationId: string;
  now: Date;
}

export async function lookupItemPurchaseCost(
  ctx: ItemPurchaseCostContext,
  itemNameQuery: string,
  windowDays: 7 | 30 | 90 = 30
): Promise<ItemPurchaseCostLookup> {
  const resolved = await resolveItemByName(ctx.supabase, ctx.organizationId, itemNameQuery);
  if (resolved.status === "not_found") return { status: "not_found" };
  if (resolved.status === "ambiguous") return { status: "ambiguous", candidateNames: resolved.candidates };

  const { data: unitRow } = await ctx.supabase.from("units").select("code").eq("id", resolved.baseUnitId).maybeSingle();
  const baseUnitCode = (unitRow?.code as string | undefined) ?? "unit";
  const item: ResolvedItem = { id: resolved.id, name: resolved.name, baseUnitCode };

  const discovery = await discoverVendorIds(ctx.supabase, ctx.organizationId, resolved.id);
  if (discovery.status === "page_error") {
    return {
      status: "incomplete",
      item,
      reason: "This item's purchase history could not be fully retrieved due to a data-access error -- the latest purchase and weighted average cannot be safely determined in this pass.",
    };
  }
  if (discovery.status === "overflow") {
    return {
      status: "incomplete",
      item,
      reason: `This item has verified purchases from more than ${MAX_VENDORS} vendors -- the overall latest purchase and weighted average cannot be safely determined in this pass.`,
    };
  }
  if (discovery.status === "ceiling_reached") {
    return {
      status: "incomplete",
      item,
      reason: `This item's purchase history is large enough that it could not be fully scanned in this pass -- the overall latest purchase and weighted average cannot be safely determined.`,
    };
  }
  const vendorIdsAll = discovery.vendorIds;
  if (vendorIdsAll.length === 0) return { status: "no_verified_cost", item };

  const legacyUnitConfigByCode = await fetchLegacyItemUnitConfigByCode(ctx.supabase, resolved.id);

  const windowStart = new Date(ctx.now);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);
  const windowStartStr = windowStart.toISOString().slice(0, 10);
  const windowEndStr = ctx.now.toISOString().slice(0, 10);

  const allRows: PriceHistoryRow[] = [];
  const vendorPackageVersionsByVendorId = new Map<string, VendorPackageVersion[]>();
  let anyVendorPoolTruncated = false;
  for (const vendorId of vendorIdsAll) {
    const [{ data }, versions] = await Promise.all([
      ctx.supabase.rpc("get_inventory_item_price_history", {
        p_organization_id: ctx.organizationId,
        p_vendor_id: vendorId,
        p_inventory_item_ids: [resolved.id],
        p_limit_per_item: AGGREGATE_HISTORY_LIMIT_PER_VENDOR,
      }),
      fetchVendorPackageVersions(ctx.supabase, ctx.organizationId, resolved.id, vendorId),
    ]);
    vendorPackageVersionsByVendorId.set(vendorId, versions);
    const vendorRows = (data ?? []) as PriceHistoryRow[];
    allRows.push(...vendorRows);
    if (vendorRows.length >= AGGREGATE_HISTORY_LIMIT_PER_VENDOR) {
      const oldest = vendorRows[vendorRows.length - 1];
      if ((oldest.out_document_date ?? "") >= windowStartStr) anyVendorPoolTruncated = true;
    }
  }
  if (allRows.length === 0) return { status: "no_verified_cost", item };

  const currentRevisionRows = await filterToCurrentRevisions(ctx.supabase, ctx.organizationId, allRows);
  if (currentRevisionRows.length === 0) return { status: "no_verified_cost", item };

  let excludedPartialCount = 0;
  let excludedUnverifiableMeasurementCount = 0;
  interface UsableRow {
    row: PriceHistoryRow;
    expectedBaseQuantity: number;
  }
  const usableRows: UsableRow[] = [];
  for (const row of currentRevisionRows) {
    const expected = expectedFullBaseQuantity(row, baseUnitCode, legacyUnitConfigByCode, vendorPackageVersionsByVendorId.get(row.out_vendor_id) ?? []);
    if (expected === null) {
      excludedUnverifiableMeasurementCount += 1;
      continue;
    }
    if (isProvenComplete(row, expected)) {
      usableRows.push({ row, expectedBaseQuantity: expected });
    } else {
      excludedPartialCount += 1;
    }
  }
  if (usableRows.length === 0) return { status: "no_verified_cost", item };

  let latestUsable = usableRows[0];
  for (const u of usableRows) {
    if (isNewer(u.row, latestUsable.row)) latestUsable = u;
  }
  const latestRow = latestUsable.row;
  const latestExpected = latestUsable.expectedBaseQuantity;

  const packageQuantity = latestRow.out_package_quantity;
  const unitCostPerPackage = packageQuantity !== null && packageQuantity > 0 ? latestRow.out_line_total / packageQuantity : null;

  const latest: LatestVerifiedPurchase = {
    vendorId: latestRow.out_vendor_id,
    vendorName: latestRow.out_vendor_name ?? "Unknown vendor",
    documentId: latestRow.out_purchase_document_id,
    documentNumber: latestRow.out_document_number,
    documentDate: latestRow.out_document_date as string,
    packageQuantity,
    packageUnit: latestRow.out_package_unit,
    lineTotal: latestRow.out_line_total,
    // Always the AUTHORITATIVE expected quantity -- never the raw posted
    // figure, even though this row already passed the completeness
    // check (gap 2: never let a tolerance-passing shortfall change the
    // denominator actually used).
    baseQuantity: latestExpected,
    baseUnitCode: latestRow.out_base_unit_code ?? baseUnitCode,
    unitCostPerBaseUnit: latestRow.out_line_total / latestExpected,
    unitCostPerPackage,
  };

  const eligible = usableRows.filter((u) => u.row.out_document_date !== null && (u.row.out_document_date as string) >= windowStartStr);
  let weightedAverage: WeightedAverageCost | null = null;
  if (!anyVendorPoolTruncated && eligible.length > 0) {
    // Weighted by quantity, using each row's own authoritative expected
    // quantity (never its raw posted figure) -- NEVER a plain average of
    // already-divided unit prices.
    const totalEligibleLineAmount = eligible.reduce((sum, u) => sum + u.row.out_line_total, 0);
    const totalEligibleBaseQuantity = eligible.reduce((sum, u) => sum + u.expectedBaseQuantity, 0);
    if (totalEligibleBaseQuantity > 0) {
      weightedAverage = {
        windowDays,
        startDate: windowStartStr,
        endDate: windowEndStr,
        totalEligibleLineAmount,
        totalEligibleBaseQuantity,
        weightedAverageBaseUnitCost: totalEligibleLineAmount / totalEligibleBaseQuantity,
        recordCount: eligible.length,
      };
    }
  }

  const limitations: string[] = [...ITEM_COST_BASE_LIMITATIONS];
  if (excludedPartialCount > 0) {
    limitations.push(
      `${excludedPartialCount} purchase(s) were excluded because only part of the invoiced quantity has been posted to inventory so far -- never used as a cost basis.`
    );
  }
  if (excludedUnverifiableMeasurementCount > 0) {
    limitations.push(
      `${excludedUnverifiableMeasurementCount} purchase(s) of this item are received by measured weight or manual count with no fixed conversion, so complete posting could not be independently verified -- excluded rather than risk an inflated figure.`
    );
  }
  if (anyVendorPoolTruncated) {
    limitations.push("The weighted average for this window could not be proven complete from available data and is not reported.");
  }

  return {
    status: "exact",
    item,
    latest,
    latestPurchaseComplete: true,
    weightedAverage,
    weightedAverageComplete: weightedAverage !== null,
    weightedAverageTruncated: anyVendorPoolTruncated,
    excludedPartialCount,
    excludedUnverifiableMeasurementCount,
    vendorSetTruncated: false,
    revisionSafetyVerified: true,
    limitations,
  };
}

export interface HistoricalUnitCost {
  vendorId: string;
  vendorName: string;
  documentId: string;
  documentNumber: string | null;
  documentDate: string;
  currency: string;
  unitCostPerBaseUnit: number;
  baseUnitCode: string;
}

export type HistoricalPriceOutcome = { status: "resolved"; price: HistoricalUnitCost } | { status: "no_price" } | { status: "incomplete"; reason: string };

/**
 * Resolves the latest verified, fully-posted, current-revision unit
 * price for ONE item at or before EACH of several requested calendar-
 * date strings (already in the organization's own timezone), in a
 * single vendor-discovery + history-fetch pass -- built for exports that
 * need many "as of" lookups for the same item (one per waste event,
 * potentially) without repeating vendor discovery or per-vendor RPC
 * calls for every lookup. Reuses the IDENTICAL partial-posting/
 * measurement/tolerance/vendor-completeness/revision-safety rules as
 * lookupItemPurchaseCost above -- never a separate, looser calculation.
 *
 * "asOf" is always a plain YYYY-MM-DD string compared against
 * out_document_date (also a plain date) -- a purchase dated the SAME
 * calendar day as the asOf date counts as eligible ("on or before"),
 * matching "never use a purchase dated after the waste event."
 */
export async function resolveHistoricalUnitCostsForItem(
  ctx: { supabase: SupabaseClient; organizationId: string },
  inventoryItemId: string,
  baseUnitCode: string,
  asOfDateStrings: string[]
): Promise<Map<string, HistoricalPriceOutcome>> {
  const results = new Map<string, HistoricalPriceOutcome>();
  const uniqueAsOf = Array.from(new Set(asOfDateStrings));
  if (uniqueAsOf.length === 0) return results;

  const discovery = await discoverVendorIds(ctx.supabase, ctx.organizationId, inventoryItemId);
  if (discovery.status !== "complete") {
    const reason =
      discovery.status === "overflow"
        ? `This item has verified purchases from more than ${MAX_VENDORS} vendors -- historical pricing cannot be safely determined in this pass.`
        : discovery.status === "ceiling_reached"
          ? "This item's purchase history is large enough that it could not be fully scanned in this pass."
          : "This item's purchase history could not be fully retrieved due to a data-access error.";
    for (const asOf of uniqueAsOf) results.set(asOf, { status: "incomplete", reason });
    return results;
  }
  const vendorIds = discovery.vendorIds;
  if (vendorIds.length === 0) {
    for (const asOf of uniqueAsOf) results.set(asOf, { status: "no_price" });
    return results;
  }

  const legacyUnitConfigByCode = await fetchLegacyItemUnitConfigByCode(ctx.supabase, inventoryItemId);

  const allRows: PriceHistoryRow[] = [];
  const vendorPackageVersionsByVendorId = new Map<string, VendorPackageVersion[]>();
  for (const vendorId of vendorIds) {
    const [{ data }, versions] = await Promise.all([
      ctx.supabase.rpc("get_inventory_item_price_history", {
        p_organization_id: ctx.organizationId,
        p_vendor_id: vendorId,
        p_inventory_item_ids: [inventoryItemId],
        p_limit_per_item: AGGREGATE_HISTORY_LIMIT_PER_VENDOR,
      }),
      fetchVendorPackageVersions(ctx.supabase, ctx.organizationId, inventoryItemId, vendorId),
    ]);
    vendorPackageVersionsByVendorId.set(vendorId, versions);
    allRows.push(...((data ?? []) as PriceHistoryRow[]));
  }
  if (allRows.length === 0) {
    for (const asOf of uniqueAsOf) results.set(asOf, { status: "no_price" });
    return results;
  }

  const currentRevisionRows = await filterToCurrentRevisions(ctx.supabase, ctx.organizationId, allRows);

  const usableRows: { row: PriceHistoryRow; expectedBaseQuantity: number }[] = [];
  for (const row of currentRevisionRows) {
    const expected = expectedFullBaseQuantity(row, baseUnitCode, legacyUnitConfigByCode, vendorPackageVersionsByVendorId.get(row.out_vendor_id) ?? []);
    if (expected === null) continue; // unverifiable -- never used as a historical cost basis
    if (isProvenComplete(row, expected)) usableRows.push({ row, expectedBaseQuantity: expected });
  }
  if (usableRows.length === 0) {
    for (const asOf of uniqueAsOf) results.set(asOf, { status: "no_price" });
    return results;
  }

  // Currency fetched once for only the distinct documents actually used.
  const documentIds = Array.from(new Set(usableRows.map((u) => u.row.out_purchase_document_id)));
  const { data: currencyRows } = await ctx.supabase.from("purchase_documents").select("id, currency").eq("organization_id", ctx.organizationId).in("id", documentIds);
  const currencyByDocumentId = new Map(((currencyRows ?? []) as { id: string; currency: string | null }[]).map((d) => [d.id, d.currency ?? "USD"]));

  for (const asOf of uniqueAsOf) {
    const eligible = usableRows.filter((u) => (u.row.out_document_date ?? "") <= asOf);
    if (eligible.length === 0) {
      results.set(asOf, { status: "no_price" });
      continue;
    }
    let best = eligible[0];
    for (const u of eligible) {
      if (isNewer(u.row, best.row)) best = u;
    }
    results.set(asOf, {
      status: "resolved",
      price: {
        vendorId: best.row.out_vendor_id,
        vendorName: best.row.out_vendor_name ?? "Unknown vendor",
        documentId: best.row.out_purchase_document_id,
        documentNumber: best.row.out_document_number,
        documentDate: best.row.out_document_date as string,
        currency: currencyByDocumentId.get(best.row.out_purchase_document_id) ?? "USD",
        unitCostPerBaseUnit: best.row.out_line_total / best.expectedBaseQuantity,
        baseUnitCode: best.row.out_base_unit_code ?? baseUnitCode,
      },
    });
  }
  return results;
}

export interface VerifiedPurchaseHistoryRow {
  vendorId: string;
  vendorName: string;
  documentId: string;
  documentNumber: string | null;
  documentDate: string;
  packageQuantity: number | null;
  packageUnit: string | null;
  lineTotal: number;
  baseQuantity: number;
  baseUnitCode: string;
  unitCostPerBaseUnit: number;
  currency: string;
}

export type VerifiedPurchaseHistoryResult = { status: "resolved"; rows: VerifiedPurchaseHistoryRow[] } | { status: "incomplete"; reason: string };

/**
 * General Report Builder -- Item Cost History. Returns every verified,
 * fully-posted, current-revision purchase line for ONE item (Section 12
 * "Require a resolved item. Use the hardened authoritative cost rules"),
 * newest first, optionally narrowed to one vendor and/or a document-date
 * range -- reusing the IDENTICAL discovery/completeness/revision-safety
 * pipeline as lookupItemPurchaseCost/resolveHistoricalUnitCostsForItem
 * above, never a separate, looser calculation. Unlike those two
 * functions (which each answer "what's the ONE latest/asOf price"), this
 * one is a listing -- built for a report that shows the full history,
 * not a single figure.
 */
export async function listVerifiedPurchaseHistoryForItem(
  ctx: { supabase: SupabaseClient; organizationId: string },
  inventoryItemId: string,
  baseUnitCode: string,
  options: { vendorId?: string | null; startDate?: string | null; endDate?: string | null } = {}
): Promise<VerifiedPurchaseHistoryResult> {
  const discovery = await discoverVendorIds(ctx.supabase, ctx.organizationId, inventoryItemId);
  if (discovery.status !== "complete") {
    const reason =
      discovery.status === "overflow"
        ? `This item has verified purchases from more than ${MAX_VENDORS} vendors -- its full history cannot be safely determined in this pass.`
        : discovery.status === "ceiling_reached"
          ? "This item's purchase history is large enough that it could not be fully scanned in this pass."
          : "This item's purchase history could not be fully retrieved due to a data-access error.";
    return { status: "incomplete", reason };
  }
  const vendorIds = options.vendorId ? discovery.vendorIds.filter((id) => id === options.vendorId) : discovery.vendorIds;
  if (vendorIds.length === 0) return { status: "resolved", rows: [] };

  const legacyUnitConfigByCode = await fetchLegacyItemUnitConfigByCode(ctx.supabase, inventoryItemId);

  const allRows: PriceHistoryRow[] = [];
  const vendorPackageVersionsByVendorId = new Map<string, VendorPackageVersion[]>();
  for (const vendorId of vendorIds) {
    const [{ data }, versions] = await Promise.all([
      ctx.supabase.rpc("get_inventory_item_price_history", {
        p_organization_id: ctx.organizationId,
        p_vendor_id: vendorId,
        p_inventory_item_ids: [inventoryItemId],
        p_limit_per_item: AGGREGATE_HISTORY_LIMIT_PER_VENDOR,
      }),
      fetchVendorPackageVersions(ctx.supabase, ctx.organizationId, inventoryItemId, vendorId),
    ]);
    vendorPackageVersionsByVendorId.set(vendorId, versions);
    allRows.push(...((data ?? []) as PriceHistoryRow[]));
  }
  if (allRows.length === 0) return { status: "resolved", rows: [] };

  const currentRevisionRows = await filterToCurrentRevisions(ctx.supabase, ctx.organizationId, allRows);

  const usableRows: { row: PriceHistoryRow; expectedBaseQuantity: number }[] = [];
  for (const row of currentRevisionRows) {
    const expected = expectedFullBaseQuantity(row, baseUnitCode, legacyUnitConfigByCode, vendorPackageVersionsByVendorId.get(row.out_vendor_id) ?? []);
    if (expected === null) continue;
    if (isProvenComplete(row, expected)) usableRows.push({ row, expectedBaseQuantity: expected });
  }
  if (usableRows.length === 0) return { status: "resolved", rows: [] };

  const dateFiltered = usableRows.filter((u) => {
    const date = u.row.out_document_date ?? "";
    if (options.startDate && date < options.startDate) return false;
    if (options.endDate && date > options.endDate) return false;
    return true;
  });

  const documentIds = Array.from(new Set(dateFiltered.map((u) => u.row.out_purchase_document_id)));
  const { data: currencyRows } =
    documentIds.length > 0 ? await ctx.supabase.from("purchase_documents").select("id, currency").eq("organization_id", ctx.organizationId).in("id", documentIds) : { data: [] };
  const currencyByDocumentId = new Map(((currencyRows ?? []) as { id: string; currency: string | null }[]).map((d) => [d.id, d.currency ?? "USD"]));

  const sorted = dateFiltered.sort((a, b) => (isNewer(a.row, b.row) ? -1 : isNewer(b.row, a.row) ? 1 : 0));

  return {
    status: "resolved",
    rows: sorted.map((u) => ({
      vendorId: u.row.out_vendor_id,
      vendorName: u.row.out_vendor_name ?? "Unknown vendor",
      documentId: u.row.out_purchase_document_id,
      documentNumber: u.row.out_document_number,
      documentDate: u.row.out_document_date as string,
      packageQuantity: u.row.out_package_quantity,
      packageUnit: u.row.out_package_unit,
      lineTotal: u.row.out_line_total,
      baseQuantity: u.expectedBaseQuantity,
      baseUnitCode: u.row.out_base_unit_code ?? baseUnitCode,
      unitCostPerBaseUnit: u.row.out_line_total / u.expectedBaseQuantity,
      currency: currencyByDocumentId.get(u.row.out_purchase_document_id) ?? "USD",
    })),
  };
}
