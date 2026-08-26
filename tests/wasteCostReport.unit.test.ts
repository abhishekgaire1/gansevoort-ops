import { describe, expect, it, vi } from "vitest";
import { getWasteCostReport } from "@/app/lib/reports/wasteCostReport";

// CI-safe: a hand-built fake Supabase client stands in for every table
// read and both RPC calls (list_inventory_waste_events,
// get_inventory_item_price_history) -- no network, no database. This
// exercises the REAL getWasteCostReport function, including the REAL
// resolveHistoricalUnitCostsForItem historical-price resolution it calls
// (the same hardened helper get_item_purchase_cost uses) -- never a mock
// reshaped to already contain the desired output.

const ORG_ID = "org-1";
const TZ = "America/New_York";

interface WasteEventRowLike {
  out_waste_event_id: string;
  out_location_id: string;
  out_location_name: string;
  out_inventory_item_id: string;
  out_item_name: string;
  out_quantity: string | number;
  out_unit_code: string;
  out_reason_code: string;
  out_note: string | null;
  out_recorded_by_app_user_id: string;
  out_recorded_at: string;
  out_inventory_movement_id: string;
  out_cycle_count_id: string | null;
}

function wasteEvent(overrides: Partial<WasteEventRowLike> & { id: string }): WasteEventRowLike {
  return {
    out_waste_event_id: overrides.id,
    out_location_id: "loc-1",
    out_location_name: "Walk-in Cooler",
    out_inventory_item_id: "item-milk",
    out_item_name: "Whole Milk Quart",
    out_quantity: "5",
    out_unit_code: "QT",
    out_reason_code: "EXPIRED",
    out_note: null,
    out_recorded_by_app_user_id: "user-1",
    out_recorded_at: "2026-08-20T14:00:00Z",
    out_inventory_movement_id: `mv-${overrides.id}`,
    out_cycle_count_id: null,
    ...overrides,
  };
}

interface PriceHistoryRowLike {
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

function priceRow(overrides: Partial<PriceHistoryRowLike>): PriceHistoryRowLike {
  return {
    out_inventory_item_id: "item-milk",
    out_rank: 1,
    out_purchase_document_id: "doc-1",
    out_document_number: "PO-1",
    out_document_date: "2026-08-10",
    out_vendor_id: "vendor-1",
    out_vendor_name: "Dairy Co",
    out_package_quantity: 10,
    out_package_unit: "QT",
    out_line_total: 25,
    out_base_quantity: 10,
    out_base_unit_code: "QT",
    out_unit_cost: 2.5,
    ...overrides,
  };
}

interface FakeConfig {
  wasteEvents?: WasteEventRowLike[];
  inventoryItems?: { id: string; category_id: string | null }[];
  categories?: { id: string; name: string }[];
  /** vendorId -> posting-line dataset for THAT item (keyed for real
   * keyset-paginated discovery, one document/posting per price row). */
  documentsByVendor?: Record<string, { documentId: string }[]>;
  rpcByVendor?: Record<string, PriceHistoryRowLike[]>;
  itemUnits?: { code: string; conversion_factor: number | null; requires_actual_measurement: boolean }[];
  documentCurrency?: Record<string, string>;
}

function fakeSupabase(config: FakeConfig) {
  // Derive the posting-line/posting/document dataset directly from
  // rpcByVendor, keyed by the ITEM each price row actually belongs to
  // (out_inventory_item_id) -- so vendor discovery for one item can
  // never see another item's posting lines, exactly matching the real
  // schema's inventory_item_id-scoped discovery query. Each document row
  // carries ALL fields it needs (vendor_id, currency, revision fields)
  // in one single row -- never split into two, which would let a
  // Map(...).set() last-write-wins collision silently clobber currency
  // with an unrelated revision-only row (a real bug this fixture used
  // to have).
  const postingLinesByItem = new Map<string, { id: string; posting_id: string }[]>();
  const postings: { id: string; purchase_document_id: string }[] = [];
  const documents: { id: string; vendor_id: string; currency: string; revision_group_id: string; revision_number: number; status: string }[] = [];
  let seq = 0;
  for (const [vendorId, rows] of Object.entries(config.rpcByVendor ?? {})) {
    for (const priceHistoryRow of rows) {
      seq += 1;
      const itemId = priceHistoryRow.out_inventory_item_id;
      const documentId = priceHistoryRow.out_purchase_document_id;
      const postingId = `posting-${seq}`;
      if (!postingLinesByItem.has(itemId)) postingLinesByItem.set(itemId, []);
      postingLinesByItem.get(itemId)!.push({ id: `pl-${String(seq).padStart(6, "0")}`, posting_id: postingId });
      postings.push({ id: postingId, purchase_document_id: documentId });
      if (!documents.some((d) => d.id === documentId)) {
        documents.push({
          id: documentId,
          vendor_id: vendorId,
          currency: config.documentCurrency?.[documentId] ?? "USD",
          revision_group_id: documentId,
          revision_number: 1,
          status: "VERIFIED",
        });
      }
    }
  }

  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    if (name === "list_inventory_waste_events") {
      const limit = (params.p_limit as number) ?? 50;
      return { data: (config.wasteEvents ?? []).slice(0, limit), error: null };
    }
    if (name === "get_inventory_item_price_history") {
      const requestedItemIds = params.p_inventory_item_ids as string[];
      const rows = (config.rpcByVendor?.[params.p_vendor_id as string] ?? []).filter((r) => requestedItemIds.includes(r.out_inventory_item_id));
      return { data: rows, error: null };
    }
    return { data: null, error: null };
  });

  function builder(table: string) {
    if (table === "purchase_document_inventory_posting_lines") {
      let gtId: string | null = null;
      let limitN = 1000;
      let itemFilter: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "inventory_item_id") itemFilter = val;
          return chain;
        },
        order: () => chain,
        gt: (_col: string, val: string) => {
          gtId = val;
          return chain;
        },
        limit: (n: number) => {
          limitN = n;
          return chain;
        },
        then: (resolve: (value: { data: unknown; error: unknown }) => void) => {
          const all = (postingLinesByItem.get(itemFilter ?? "") ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          const startIdx = gtId === null ? 0 : all.findIndex((r) => r.id > (gtId as string));
          const sliceStart = gtId === null ? 0 : startIdx === -1 ? all.length : startIdx;
          const page = all.slice(sliceStart, sliceStart + limitN);
          resolve({ data: page, error: null });
        },
      };
      return chain;
    }

    const filters: { in: [string, unknown[]][] } = { in: [] };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: (col: string, vals: unknown[]) => {
        filters.in.push([col, vals]);
        return chain;
      },
      maybeSingle: () => {
        const rows = applyInFilters(sourceRows(table), filters);
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then: (resolve: (value: { data: unknown; error: null }) => void) => {
        resolve({ data: applyInFilters(sourceRows(table), filters), error: null });
      },
    };
    return chain;

    function applyInFilters(rows: Record<string, unknown>[], f: { in: [string, unknown[]][] }): Record<string, unknown>[] {
      return rows.filter((row) => f.in.every(([col, vals]) => vals.includes(row[col])));
    }

    function sourceRows(t: string): Record<string, unknown>[] {
      if (t === "inventory_items") return (config.inventoryItems ?? []) as unknown as Record<string, unknown>[];
      if (t === "inventory_categories") return (config.categories ?? []) as unknown as Record<string, unknown>[];
      if (t === "purchase_document_inventory_postings") return postings as unknown as Record<string, unknown>[];
      if (t === "purchase_documents") return documents as unknown as Record<string, unknown>[];
      if (t === "inventory_item_units") {
        return (config.itemUnits ?? []).map((u) => ({ conversion_factor: u.conversion_factor, requires_actual_measurement: u.requires_actual_measurement, units: { code: u.code } }));
      }
      return [];
    }
  }

  return { from: vi.fn(builder), rpc, __postingLinesCallCount: () => rpc.mock.calls.filter((c) => c[0] === "get_inventory_item_price_history").length };
}

describe("getWasteCostReport -- date range", () => {
  it("resolves an invalid custom range without querying waste events", async () => {
    const supabase = fakeSupabase({});
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "not-a-date", "2026-08-25");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_range");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("passes the resolved UTC instant bounds (inclusive of the full end date) to list_inventory_waste_events", async () => {
    const supabase = fakeSupabase({ wasteEvents: [] });
    await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(supabase.rpc).toHaveBeenCalledWith(
      "list_inventory_waste_events",
      expect.objectContaining({ p_organization_id: ORG_ID, p_from_date: expect.any(String), p_to_date: expect.any(String) })
    );
  });

  it("returns a valid, all-zero empty report when no waste events fall in range", async () => {
    const supabase = fakeSupabase({ wasteEvents: [] });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.eventCount).toBe(0);
      expect(result.report.lineCount).toBe(0);
      expect(result.report.pricedCount).toBe(0);
      expect(result.report.unpricedCount).toBe(0);
      expect(result.report.currencyTotals).toEqual([]);
      expect(result.report.lines).toEqual([]);
    }
  });

  it("fails closed (range_too_large) rather than silently truncating when the event count exceeds the export ceiling", async () => {
    const wasteEvents = Array.from({ length: 5001 }, (_, i) => wasteEvent({ id: `w-${i}`, out_recorded_at: "2026-08-20T00:00:00Z" }));
    const supabase = fakeSupabase({ wasteEvents });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("range_too_large");
      expect(result.message).toContain("Narrow the range");
    }
  });
});

describe("getWasteCostReport -- pricing (reuses the SAME hardened historical-price resolution as get_item_purchase_cost)", () => {
  it("a waste line with an eligible on-or-before purchase is priced with the correct arithmetic (quantity x unit cost)", async () => {
    const supabase = fakeSupabase({
      wasteEvents: [wasteEvent({ id: "w1", out_quantity: "5", out_recorded_at: "2026-08-20T14:00:00Z" })],
      rpcByVendor: { "vendor-1": [priceRow({ out_document_date: "2026-08-10", out_line_total: 25, out_base_quantity: 10, out_unit_cost: 2.5 })] },
    });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [line] = result.report.lines;
    expect(line.pricingStatus).toBe("priced");
    expect(line.unitPrice).toBe(2.5);
    expect(line.estimatedCost).toBe(12.5); // 5 * 2.5
    expect(line.currency).toBe("USD");
    expect(result.report.pricedCount).toBe(1);
    expect(result.report.currencyTotals).toEqual([{ currency: "USD", estimatedCost: 12.5 }]);
  });

  it("never uses a purchase dated AFTER the waste event (no future-price leakage) -- picks the latest purchase on or before it", async () => {
    const supabase = fakeSupabase({
      wasteEvents: [wasteEvent({ id: "w1", out_recorded_at: "2026-08-15T00:00:00Z" })],
      rpcByVendor: {
        "vendor-1": [
          priceRow({ out_purchase_document_id: "doc-old", out_document_date: "2026-08-01", out_unit_cost: 2.0, out_line_total: 20, out_base_quantity: 10 }),
          priceRow({ out_purchase_document_id: "doc-future", out_document_date: "2026-08-20", out_unit_cost: 9.0, out_line_total: 90, out_base_quantity: 10 }),
        ],
      },
    });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-01", "2026-08-25");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [line] = result.report.lines;
    expect(line.unitPrice).toBe(2.0);
    expect(line.costBasisDate).toBe("2026-08-01");
  });

  it("a waste line with no eligible purchase price is left unpriced -- never substituted with a current or average price", async () => {
    const supabase = fakeSupabase({ wasteEvents: [wasteEvent({ id: "w1" })], rpcByVendor: {} });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [line] = result.report.lines;
    expect(line.pricingStatus).toBe("unpriced");
    expect(line.estimatedCost).toBeNull();
    expect(line.unitPrice).toBeNull();
    expect(line.pricingLimitation).toBe("No verified purchase price was found on or before this waste event.");
    expect(result.report.unpricedCount).toBe(1);
    expect(result.report.pricedCount).toBe(0);
  });

  it("a partial (incompletely posted) purchase is excluded, matching get_item_purchase_cost's own completeness rule -- the line stays unpriced rather than using an inflated per-unit figure", async () => {
    const supabase = fakeSupabase({
      wasteEvents: [wasteEvent({ id: "w1" })],
      // Posted only 5 of an expected 10 base units -- far outside the
      // fixed absolute tolerance -- so this can never be used as a cost basis.
      rpcByVendor: { "vendor-1": [priceRow({ out_base_quantity: 5, out_package_quantity: 10, out_package_unit: "QT", out_line_total: 25 })] },
    });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.lines[0].pricingStatus).toBe("unpriced");
  });

  it("resolves historical price ONCE PER ITEM (not once per waste line) -- three waste events for the same item cost only one vendor-discovery/history pass", async () => {
    const supabase = fakeSupabase({
      wasteEvents: [
        wasteEvent({ id: "w1", out_recorded_at: "2026-08-18T00:00:00Z" }),
        wasteEvent({ id: "w2", out_recorded_at: "2026-08-20T00:00:00Z" }),
        wasteEvent({ id: "w3", out_recorded_at: "2026-08-22T00:00:00Z" }),
      ],
      rpcByVendor: { "vendor-1": [priceRow({})] },
    });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(true);
    // Exactly one get_inventory_item_price_history call for the one
    // distinct vendor discovered for this one item -- not three.
    expect(supabase.__postingLinesCallCount()).toBe(1);
  });

  it("multiple items are resolved independently and grouped correctly in By Item -- never merged across different items", async () => {
    const supabase = fakeSupabase({
      wasteEvents: [
        wasteEvent({ id: "w1", out_inventory_item_id: "item-milk", out_item_name: "Whole Milk Quart", out_quantity: "5", out_unit_code: "QT" }),
        wasteEvent({ id: "w2", out_inventory_item_id: "item-bread", out_item_name: "Sourdough Loaf", out_quantity: "2", out_unit_code: "EA" }),
      ],
      rpcByVendor: {
        "vendor-1": [priceRow({ out_inventory_item_id: "item-milk", out_unit_cost: 2.5, out_line_total: 25, out_base_quantity: 10 })],
        "vendor-2": [priceRow({ out_inventory_item_id: "item-bread", out_purchase_document_id: "doc-bread", out_unit_cost: 3, out_line_total: 30, out_base_quantity: 10, out_base_unit_code: "EA", out_package_unit: "EA" })],
      },
    });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.byItem).toHaveLength(2);
    const milkRow = result.report.byItem.find((r) => r.itemName === "Whole Milk Quart");
    const breadRow = result.report.byItem.find((r) => r.itemName === "Sourdough Loaf");
    expect(milkRow?.wasteQuantity).toBe(5);
    expect(milkRow?.baseUnitCode).toBe("QT");
    expect(breadRow?.wasteQuantity).toBe(2);
    expect(breadRow?.baseUnitCode).toBe("EA");
  });

  it("does not combine two different currencies into one total", async () => {
    const supabase = fakeSupabase({
      wasteEvents: [
        wasteEvent({ id: "w1", out_inventory_item_id: "item-milk", out_item_name: "Whole Milk Quart" }),
        wasteEvent({ id: "w2", out_inventory_item_id: "item-cheese", out_item_name: "Cheddar Block", out_unit_code: "LB" }),
      ],
      rpcByVendor: {
        "vendor-1": [priceRow({ out_inventory_item_id: "item-milk", out_unit_cost: 2.5, out_line_total: 25, out_base_quantity: 10 })],
        "vendor-2": [priceRow({ out_inventory_item_id: "item-cheese", out_purchase_document_id: "doc-cheese", out_unit_cost: 4, out_line_total: 40, out_base_quantity: 10, out_base_unit_code: "LB", out_package_unit: "LB" })],
      },
      documentCurrency: { "doc-cheese": "CAD" },
    });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.currencyTotals).toEqual(
      expect.arrayContaining([
        { currency: "USD", estimatedCost: 12.5 }, // 5 qty x $2.50/QT
        { currency: "CAD", estimatedCost: 20 }, // 5 qty x $4.00/LB
      ])
    );
    expect(result.report.currencyTotals).toHaveLength(2);
  });

  it("resolves the item's category name when set, and leaves it null when the item has no category", async () => {
    const supabase = fakeSupabase({
      wasteEvents: [wasteEvent({ id: "w1" })],
      inventoryItems: [{ id: "item-milk", category_id: "cat-dairy" }],
      categories: [{ id: "cat-dairy", name: "Dairy" }],
      rpcByVendor: {},
    });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.lines[0].categoryName).toBe("Dairy");
  });
});

describe("getWasteCostReport -- By Reason aggregation", () => {
  it("groups priced/unpriced counts and totals correctly by reason", async () => {
    const supabase = fakeSupabase({
      wasteEvents: [
        wasteEvent({ id: "w1", out_reason_code: "EXPIRED" }),
        wasteEvent({ id: "w2", out_reason_code: "EXPIRED", out_recorded_at: "2026-08-21T00:00:00Z" }),
        wasteEvent({ id: "w3", out_reason_code: "DAMAGED", out_recorded_at: "2026-08-22T00:00:00Z" }),
      ],
      rpcByVendor: { "vendor-1": [priceRow({ out_unit_cost: 2.5, out_line_total: 25, out_base_quantity: 10 })] },
    });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expired = result.report.byReason.find((r) => r.reasonLabel === "Expired");
    const damaged = result.report.byReason.find((r) => r.reasonLabel === "Damaged");
    expect(expired?.lineCount).toBe(2);
    expect(expired?.pricedCount).toBe(2);
    expect(expired?.estimatedCost).toBe(25); // 2 events x 5 qty x 2.5
    expect(damaged?.lineCount).toBe(1);
  });
});

describe("getWasteCostReport -- General Report Builder options (location/reason/item filters, includePricing gating)", () => {
  it("passes locationId and reasonCode through to list_inventory_waste_events", async () => {
    const supabase = fakeSupabase({ wasteEvents: [] });
    await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25", { locationId: "loc-1", reasonCode: "DAMAGED" });
    expect(supabase.rpc).toHaveBeenCalledWith("list_inventory_waste_events", expect.objectContaining({ p_location_id: "loc-1", p_reason_code: "DAMAGED" }));
  });

  it("applies an item filter client-side (list_inventory_waste_events has no item parameter of its own)", async () => {
    const supabase = fakeSupabase({
      wasteEvents: [
        wasteEvent({ id: "w1", out_inventory_item_id: "item-milk" }),
        wasteEvent({ id: "w2", out_inventory_item_id: "item-bread", out_item_name: "Sourdough Loaf" }),
      ],
    });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25", { inventoryItemId: "item-bread" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.lines).toHaveLength(1);
    expect(result.report.lines[0].itemName).toBe("Sourdough Loaf");
  });

  it("skips historical price resolution entirely when includePricing is false -- never runs it just to discard the result", async () => {
    const supabase = fakeSupabase({ wasteEvents: [wasteEvent({ id: "w1" })], rpcByVendor: { "vendor-1": [priceRow({})] } });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25", { includePricing: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.pricingRequested).toBe(false);
    expect(result.report.lines[0].pricingStatus).toBe("not_requested");
    expect(result.report.lines[0].unitPrice).toBeNull();
    expect(result.report.pricedCount).toBe(0);
    expect(result.report.unpricedCount).toBe(0);
    expect(supabase.__postingLinesCallCount()).toBe(0);
  });

  it("defaults to includePricing true when the option is omitted (backward compatible)", async () => {
    const supabase = fakeSupabase({ wasteEvents: [wasteEvent({ id: "w1" })], rpcByVendor: { "vendor-1": [priceRow({})] } });
    const result = await getWasteCostReport(supabase as never, ORG_ID, TZ, "2026-08-16", "2026-08-25");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.pricingRequested).toBe(true);
    expect(result.report.lines[0].pricingStatus).toBe("priced");
  });
});
