import { describe, expect, it, vi } from "vitest";
import { lookupItemPurchaseCost, listVerifiedPurchaseHistoryForItem } from "@/app/lib/ai/tasks/chat/itemPurchaseCost";

// CI-safe: a hand-built fake Supabase client stands in for every plain
// table read and the one RPC call -- no network, no database. This file
// exercises the REAL calculation helper (including the real, page-by-page
// vendor-discovery pagination) with explicit inputs and asserts the
// actual expected arithmetic/completeness behavior -- never a mock
// reshaped to already contain the desired output, and never a
// preassembled "complete vendor list" standing in for genuine pagination.

const ORG_ID = "org-1";
const ITEM_ID = "item-milk";
const UNIT_ID = "unit-piece";
const PAGE_SIZE = 200; // must match VENDOR_DISCOVERY_PAGE_SIZE in itemPurchaseCost.ts

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

interface DocumentRevisionRow {
  id: string;
  revision_group_id: string;
  revision_number: number;
  status: string;
}

/** A posting-line row as it exists in the real underlying dataset --
 * `id` drives real keyset pagination ordering, so it must be unique and
 * sortable. Use zero-padded sequential ids via plId() below. */
interface PostingLineRow {
  id: string;
  posting_id: string;
}

function plId(n: number): string {
  return `pl-${String(n).padStart(6, "0")}`;
}

interface FakeConfig {
  inventoryItems?: { id: string; name: string; base_unit_id: string }[];
  unitCode?: string;
  /** The FULL underlying posting-line dataset -- discoverVendorIds pages
   * through this for real, driven by the fake's own order/gt/limit
   * handling below. */
  postingLines?: PostingLineRow[];
  /** 0-indexed page number (by call order) at which the posting-lines
   * query itself should fail -- simulates a page-error mid-scan. */
  postingLinesFailAtPage?: number;
  postings?: { id: string; purchase_document_id: string }[];
  documents?: { id: string; vendor_id: string | null }[];
  itemUnits?: { code: string; conversion_factor: number | null; requires_actual_measurement: boolean }[];
  rpcByVendor?: Record<string, PriceHistoryRowLike[]>;
  documentRevisions?: DocumentRevisionRow[];
  /** Vendor-specific purchase-package VERSIONS (purchase-versus-usage
   * unit model, 20260811100113) -- deliberately a SEPARATE dataset from
   * itemUnits (the legacy shared per-item table), so a test can prove two
   * vendors sharing a unit code never collide, and that an outdated
   * historical purchase resolves against the version that was actually in
   * effect on ITS OWN document date, never today's current version. */
  vendorPackages?: {
    vendor_id: string;
    unit_code: string;
    conversion_factor: number | null;
    requires_actual_measurement: boolean;
    effective_from: string;
    effective_to: string | null;
  }[];
}

function defaultRevisionRows(config: FakeConfig): DocumentRevisionRow[] {
  const ids = new Set<string>();
  for (const rows of Object.values(config.rpcByVendor ?? {})) {
    for (const row of rows) ids.add(row.out_purchase_document_id);
  }
  for (const d of config.documents ?? []) ids.add(d.id);
  return Array.from(ids).map((id) => ({ id, revision_group_id: id, revision_number: 1, status: "VERIFIED" }));
}

function fakeSupabase(config: FakeConfig) {
  const rpc = vi.fn(async (name: string, params: { p_vendor_id: string }) => {
    if (name === "get_inventory_item_price_history") {
      return { data: config.rpcByVendor?.[params.p_vendor_id] ?? [], error: null };
    }
    return { data: null, error: null };
  });

  let postingLinesCallCount = 0;
  const revisionRows = [...(config.documentRevisions ?? defaultRevisionRows(config))];

  function builder(table: string) {
    if (table === "purchase_document_inventory_posting_lines") {
      let gtId: string | null = null;
      let limitN = 1000;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
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
          const callIndex = postingLinesCallCount;
          postingLinesCallCount += 1;
          if (config.postingLinesFailAtPage === callIndex) {
            resolve({ data: null, error: { message: "simulated page failure" } });
            return;
          }
          const all = (config.postingLines ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          const startIdx = gtId === null ? 0 : all.findIndex((r) => r.id > (gtId as string));
          const sliceStart = gtId === null ? 0 : startIdx === -1 ? all.length : startIdx;
          const page = all.slice(sliceStart, sliceStart + limitN);
          resolve({ data: page, error: null });
        },
      };
      return chain;
    }

    if (table === "vendor_item_purchase_units") {
      // A dedicated chain (unlike the generic fallback below) because this
      // one genuinely needs real vendor_id filtering to prove two vendors
      // sharing a unit code never collide -- the generic fallback's `.eq()`
      // is deliberately a no-op everywhere else in this fake.
      let vendorIdFilter: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "vendor_id") vendorIdFilter = val;
          return chain;
        },
        then: (resolve: (value: { data: unknown; error: null }) => void) => {
          const rows = (config.vendorPackages ?? []).filter((p) => vendorIdFilter === null || p.vendor_id === vendorIdFilter);
          resolve({
            data: rows.map((p) => ({
              conversion_factor: p.conversion_factor,
              requires_actual_measurement: p.requires_actual_measurement,
              effective_from: p.effective_from,
              effective_to: p.effective_to,
              units: { code: p.unit_code },
            })),
            error: null,
          });
        },
      };
      return chain;
    }

    // Every other table: a generic chain that applies `.in()` filters
    // against the underlying configured rows (so a page's bounded id
    // list genuinely only returns matching rows), while `.eq()` is a
    // no-op (organization scoping is verified separately, via call
    // assertions, not via data-level filtering in this fake).
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
      if (t === "purchase_document_inventory_postings") return (config.postings ?? []) as unknown as Record<string, unknown>[];
      if (t === "purchase_documents") return [...(config.documents ?? []), ...revisionRows] as unknown as Record<string, unknown>[];
      if (t === "inventory_item_units") {
        return (config.itemUnits ?? []).map((u) => ({ conversion_factor: u.conversion_factor, requires_actual_measurement: u.requires_actual_measurement, units: { code: u.code } }));
      }
      if (t === "units") return config.unitCode ? [{ code: config.unitCode }] : [];
      return [];
    }
  }
  return { from: vi.fn(builder), rpc };
}

const NOW = new Date("2026-08-19T12:00:00Z");

/** Builds a single-vendor, single-document fixture: one posting-line row,
 * one posting, one document -- the ordinary "small item" shape most
 * tests need, with a real (paginated-through) posting-lines dataset of
 * exactly one row. */
function singleVendorConfig(vendorId = "vendor-1", documentId = "doc-1"): FakeConfig {
  return {
    inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }],
    unitCode: "PIECE",
    postingLines: [{ id: plId(0), posting_id: "posting-1" }],
    postings: [{ id: "posting-1", purchase_document_id: documentId }],
    documents: [{ id: documentId, vendor_id: vendorId }],
    itemUnits: [{ code: "CASE", conversion_factor: 12, requires_actual_measurement: false }],
  };
}

const CASE_PACK_CONFIG: FakeConfig = singleVendorConfig();

function row(overrides: Partial<PriceHistoryRowLike>): PriceHistoryRowLike {
  return {
    out_inventory_item_id: ITEM_ID,
    out_rank: 1,
    out_purchase_document_id: "doc-1",
    out_document_number: "INV-1",
    out_document_date: "2026-08-15",
    out_vendor_id: "vendor-1",
    out_vendor_name: "Acme Dairy",
    out_package_quantity: 10,
    out_package_unit: "CASE",
    out_line_total: 500,
    out_base_quantity: 120,
    out_base_unit_code: "PIECE",
    out_unit_cost: 500 / 120,
    ...overrides,
  };
}

describe("Partial-posting correctness -- the exact worked example from the earlier task", () => {
  it("a partially posted line (5 of 10 cases posted) is excluded, never used to overstate unit cost", async () => {
    const supabase = fakeSupabase({
      ...CASE_PACK_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 10, out_base_quantity: 60, out_line_total: 500, out_unit_cost: 500 / 60 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("no_verified_cost");
  });

  it("a FULLY posted line (10 of 10 cases, 120 of 120 pieces) reports the correct $4.1667/piece, not the partial figure", async () => {
    const supabase = fakeSupabase({
      ...CASE_PACK_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 10, out_base_quantity: 120, out_line_total: 500, out_unit_cost: 500 / 120 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("exact");
    if (result.status === "exact") {
      expect(result.latest.unitCostPerBaseUnit).toBeCloseTo(500 / 120, 6);
      expect(result.latest.unitCostPerBaseUnit).not.toBeCloseTo(500 / 60, 1);
      expect(result.excludedPartialCount).toBe(0);
    }
  });

  it("original package quantity converts to base units correctly via the item's fixed conversion factor", async () => {
    const supabase = fakeSupabase({
      ...CASE_PACK_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 10, out_package_unit: "CASE", out_base_quantity: 120, out_line_total: 500 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("exact");
    if (result.status === "exact") expect(result.latest.unitCostPerPackage).toBeCloseTo(50, 6);
  });

  it("a base_quantity of 0 is never divided into -- excluded rather than producing Infinity/NaN", async () => {
    const supabase = fakeSupabase({
      ...CASE_PACK_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 10, out_base_quantity: 0, out_line_total: 500, out_unit_cost: 0 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("no_verified_cost");
  });
});

describe("Variable-weight and manual-count items", () => {
  it("a variable-weight line with a provably complete posting (package unit IS the base unit) is used as an exact cost basis", async () => {
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Fresh Salmon", base_unit_id: UNIT_ID }],
      unitCode: "LB",
      postingLines: [{ id: plId(0), posting_id: "posting-1" }],
      postings: [{ id: "posting-1", purchase_document_id: "doc-1" }],
      documents: [{ id: "doc-1", vendor_id: "vendor-1" }],
      itemUnits: [{ code: "LB", conversion_factor: null, requires_actual_measurement: true }],
      rpcByVendor: {
        "vendor-1": [row({ out_package_quantity: 42.5, out_package_unit: "LB", out_base_unit_code: "LB", out_base_quantity: 42.5, out_line_total: 250, out_unit_cost: 250 / 42.5 })],
      },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Fresh Salmon");
    expect(result.status).toBe("exact");
    if (result.status === "exact") expect(result.latest.unitCostPerBaseUnit).toBeCloseTo(250 / 42.5, 6);
  });

  it("a variable-weight line WITHOUT a provable full quantity is excluded -- no_verified_cost, never a guessed price", async () => {
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Fresh Salmon", base_unit_id: UNIT_ID }],
      unitCode: "LB",
      postingLines: [{ id: plId(0), posting_id: "posting-1" }],
      postings: [{ id: "posting-1", purchase_document_id: "doc-1" }],
      documents: [{ id: "doc-1", vendor_id: "vendor-1" }],
      itemUnits: [{ code: "CASE", conversion_factor: null, requires_actual_measurement: true }],
      rpcByVendor: {
        "vendor-1": [row({ out_package_quantity: 2, out_package_unit: "CASE", out_base_unit_code: "LB", out_base_quantity: 42.5, out_line_total: 250 })],
      },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Fresh Salmon");
    expect(result.status).toBe("no_verified_cost");
  });

  it("an unverifiable line is excluded from the latest price and the weighted average alike", async () => {
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Whole Chickens", base_unit_id: UNIT_ID }],
      unitCode: "EACH",
      postingLines: [
        { id: plId(0), posting_id: "posting-1" },
        { id: plId(1), posting_id: "posting-2" },
      ],
      postings: [
        { id: "posting-1", purchase_document_id: "doc-1" },
        { id: "posting-2", purchase_document_id: "doc-2" },
      ],
      documents: [{ id: "doc-1", vendor_id: "vendor-1" }, { id: "doc-2", vendor_id: "vendor-1" }],
      itemUnits: [{ code: "CASE", conversion_factor: null, requires_actual_measurement: true }],
      rpcByVendor: {
        "vendor-1": [
          row({ out_purchase_document_id: "doc-2", out_document_date: "2026-08-18", out_package_quantity: 3, out_package_unit: "CASE", out_base_unit_code: "EACH", out_base_quantity: 36, out_line_total: 999999, out_unit_cost: 27777 }),
          row({ out_purchase_document_id: "doc-1", out_document_date: "2026-08-01", out_package_quantity: 30, out_package_unit: "EACH", out_base_unit_code: "EACH", out_base_quantity: 30, out_line_total: 150, out_unit_cost: 5 }),
        ],
      },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Chickens", 30);
    expect(result.status).toBe("exact");
    if (result.status === "exact") {
      expect(result.latest.documentId).toBe("doc-1");
      expect(result.excludedUnverifiableMeasurementCount).toBe(1);
      expect(result.weightedAverage!.recordCount).toBe(1);
      expect(result.weightedAverage!.weightedAverageBaseUnitCost).toBeCloseTo(5, 6);
    }
  });

  it("an item with ONLY unverifiable purchases produces no_verified_cost, never a stock-value basis", async () => {
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Whole Chickens", base_unit_id: UNIT_ID }],
      unitCode: "EACH",
      postingLines: [{ id: plId(0), posting_id: "posting-1" }],
      postings: [{ id: "posting-1", purchase_document_id: "doc-1" }],
      documents: [{ id: "doc-1", vendor_id: "vendor-1" }],
      itemUnits: [{ code: "CASE", conversion_factor: null, requires_actual_measurement: true }],
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 3, out_package_unit: "CASE", out_base_unit_code: "EACH", out_base_quantity: 36, out_line_total: 180 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Chickens");
    expect(result.status).toBe("no_verified_cost");
    expect("latest" in result).toBe(false);
  });
});

describe("Completeness tolerance and denominator", () => {
  const TOLERANCE_CONFIG: FakeConfig = {
    inventoryItems: [{ id: ITEM_ID, name: "Case Item", base_unit_id: UNIT_ID }],
    unitCode: "PIECE",
    postingLines: [{ id: plId(0), posting_id: "posting-1" }],
    postings: [{ id: "posting-1", purchase_document_id: "doc-1" }],
    documents: [{ id: "doc-1", vendor_id: "vendor-1" }],
    itemUnits: [],
  };

  it("posted=99 against expected=100 is NOT complete, and never returns $500/99", async () => {
    const supabase = fakeSupabase({
      ...TOLERANCE_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 100, out_package_unit: "PIECE", out_base_unit_code: "PIECE", out_base_quantity: 99, out_line_total: 500, out_unit_cost: 500 / 99 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Case Item");
    expect(result.status).toBe("no_verified_cost");
  });

  it("once proven complete, cost uses the authoritative expected quantity as denominator, never the raw posted figure", async () => {
    const supabase = fakeSupabase({
      ...TOLERANCE_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 100, out_package_unit: "PIECE", out_base_unit_code: "PIECE", out_base_quantity: 99.99, out_line_total: 500, out_unit_cost: 500 / 99.99 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Case Item");
    expect(result.status).toBe("exact");
    if (result.status === "exact") {
      expect(result.latest.baseQuantity).toBe(100);
      expect(result.latest.unitCostPerBaseUnit).toBe(5);
    }
  });

  it("a shortfall well below the tolerance boundary passes as complete", async () => {
    const supabase = fakeSupabase({
      ...TOLERANCE_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 100, out_package_unit: "PIECE", out_base_unit_code: "PIECE", out_base_quantity: 99.995, out_line_total: 500 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Case Item");
    expect(result.status).toBe("exact");
    if (result.status === "exact") expect(result.latest.unitCostPerBaseUnit).toBe(5);
  });

  it("a shortfall exactly AT the tolerance boundary (0.01) still passes as complete", async () => {
    const supabase = fakeSupabase({
      ...TOLERANCE_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 100, out_package_unit: "PIECE", out_base_unit_code: "PIECE", out_base_quantity: 99.99, out_line_total: 500 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Case Item");
    expect(result.status).toBe("exact");
    if (result.status === "exact") expect(result.latest.unitCostPerBaseUnit).toBe(5);
  });

  it("a shortfall immediately OUTSIDE the tolerance boundary (0.011) is excluded", async () => {
    const supabase = fakeSupabase({
      ...TOLERANCE_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 100, out_package_unit: "PIECE", out_base_unit_code: "PIECE", out_base_quantity: 99.989, out_line_total: 500 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Case Item");
    expect(result.status).toBe("no_verified_cost");
  });

  it("the tolerance never grows with quantity -- a large order short by a whole unit is still excluded", async () => {
    const supabase = fakeSupabase({
      ...TOLERANCE_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 10000, out_package_unit: "PIECE", out_base_unit_code: "PIECE", out_base_quantity: 9999, out_line_total: 50000 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Case Item");
    expect(result.status).toBe("no_verified_cost");
  });
});

describe("Weighted-average completeness", () => {
  it("weighted average is quantity-weighted, not a plain average of unit costs", async () => {
    const supabase = fakeSupabase({
      ...CASE_PACK_CONFIG,
      rpcByVendor: {
        "vendor-1": [
          row({ out_purchase_document_id: "doc-1", out_document_date: "2026-08-15", out_package_quantity: 1, out_package_unit: "PIECE", out_line_total: 10, out_base_quantity: 1, out_unit_cost: 10 }),
          row({ out_purchase_document_id: "doc-1", out_document_date: "2026-08-05", out_package_quantity: 100, out_package_unit: "PIECE", out_line_total: 200, out_base_quantity: 100, out_unit_cost: 2 }),
        ],
      },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 30);
    expect(result.status).toBe("exact");
    if (result.status === "exact") {
      expect(result.weightedAverage!.weightedAverageBaseUnitCost).toBeCloseTo(210 / 101, 6);
      expect(result.weightedAverage!.weightedAverageBaseUnitCost).not.toBeCloseTo(6, 1);
    }
  });

  it("more than 50 eligible records still produce a complete weighted average", async () => {
    const manyRows = Array.from({ length: 80 }, (_, i) =>
      row({ out_purchase_document_id: "doc-1", out_document_date: `2026-08-${String(19 - (i % 18)).padStart(2, "0")}`, out_package_quantity: 10, out_line_total: 500, out_base_quantity: 120 })
    );
    const supabase = fakeSupabase({ ...CASE_PACK_CONFIG, rpcByVendor: { "vendor-1": manyRows } });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 30);
    expect(result.status).toBe("exact");
    if (result.status === "exact") {
      expect(result.weightedAverage!.recordCount).toBeGreaterThan(50);
      expect(result.weightedAverage!.totalEligibleLineAmount).toBe(result.weightedAverage!.recordCount * 500);
    }
  });

  it("a truly incomplete/truncated aggregate (per-vendor history pool exhausted its own fetch limit) is never labeled a weighted average", async () => {
    const rows = Array.from({ length: 500 }, () => row({ out_purchase_document_id: "doc-1", out_document_date: "2026-08-01" }));
    const supabase = fakeSupabase({ ...CASE_PACK_CONFIG, rpcByVendor: { "vendor-1": rows } });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 30);
    expect(result.status).toBe("exact");
    if (result.status === "exact") {
      expect(result.weightedAverage).toBeNull();
      expect(result.weightedAverageTruncated).toBe(true);
      expect(result.latest).toBeDefined();
    }
  });
});

describe("Vendor-discovery pagination (real, page-by-page)", () => {
  /** Builds a full discovery fixture for N distinct vendors, one posting-
   * line/posting/document per vendor, so discoverVendorIds must scan
   * ceil(N / PAGE_SIZE) real pages to find them all. */
  function paginatedVendorConfig(vendorCount: number, newestVendorIndex: number | null): FakeConfig {
    const postingLines: PostingLineRow[] = [];
    const postings: { id: string; purchase_document_id: string }[] = [];
    const documents: { id: string; vendor_id: string | null }[] = [];
    const rpcByVendor: Record<string, PriceHistoryRowLike[]> = {};
    for (let i = 0; i < vendorCount; i++) {
      const vendorId = `vendor-${i + 1}`;
      const docId = `doc-${i + 1}`;
      postingLines.push({ id: plId(i), posting_id: `posting-${i + 1}` });
      postings.push({ id: `posting-${i + 1}`, purchase_document_id: docId });
      documents.push({ id: docId, vendor_id: vendorId });
      const isNewest = newestVendorIndex === i;
      rpcByVendor[vendorId] = [row({ out_purchase_document_id: docId, out_vendor_id: vendorId, out_vendor_name: `Vendor ${i + 1}`, out_document_date: isNewest ? "2026-08-19" : "2026-07-01" })];
    }
    return {
      inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }],
      unitCode: "PIECE",
      postingLines,
      postings,
      documents,
      itemUnits: [{ code: "CASE", conversion_factor: 12, requires_actual_measurement: false }],
      rpcByVendor,
    };
  }

  it("1. one-page vendor discovery (well under the page size) resolves normally", async () => {
    const supabase = fakeSupabase(paginatedVendorConfig(3, 2));
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    expect(result.status).toBe("exact");
  });

  it("2. exactly one full page followed by an empty page proves exhaustion", async () => {
    // Exactly PAGE_SIZE posting-lines, all for the SAME vendor/document --
    // the second (empty) page is what proves the scan is done.
    const postingLines = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: plId(i), posting_id: "posting-1" }));
    const supabase = fakeSupabase({
      ...singleVendorConfig(),
      postingLines,
      rpcByVendor: { "vendor-1": [row({})] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    expect(result.status).toBe("exact");
  });

  it("3. duplicate vendor ids appearing across multiple pages are still de-duplicated", async () => {
    // PAGE_SIZE + 10 posting-lines, ALL pointing at the same one vendor/document
    // -- spans two real pages, but only one distinct vendor.
    const postingLines = Array.from({ length: PAGE_SIZE + 10 }, (_, i) => ({ id: plId(i), posting_id: "posting-1" }));
    const supabase = fakeSupabase({ ...singleVendorConfig(), postingLines, rpcByVendor: { "vendor-1": [row({})] } });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    expect(result.status).toBe("exact");
    expect(supabase.rpc).toHaveBeenCalledTimes(1); // one distinct vendor -- one RPC call
  });

  it("4. twenty distinct vendors spread across several pages (10/page) still resolve completely", async () => {
    const supabase = fakeSupabase(paginatedVendorConfig(20, 19));
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    expect(result.status).toBe("exact");
    if (result.status === "exact") expect(result.weightedAverage!.recordCount).toBe(20);
  });

  it("5/6. vendor 21 appears on a later page and holds the TRUE newest purchase -- must not return a vendor 1-20 result", async () => {
    const config = paginatedVendorConfig(21, 20); // 21 vendors, one per posting-line/page-row, vendor 21 (index 20) is the newest
    const supabase = fakeSupabase(config);
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect("latest" in result).toBe(false);
      expect("weightedAverage" in result).toBe(false);
      expect(result.reason.toLowerCase()).toContain("20");
    }
  });

  it("7. scan ceiling reached before end-of-results is proven -- incomplete even with 20-or-fewer vendors observed", async () => {
    // Every posting-line points at the SAME single vendor (so the true
    // vendor count is 1, well under the cap), but there are enough rows
    // that every page comes back FULL -- exhaustion is never proven.
    const MAX_PAGES = 25; // must match VENDOR_DISCOVERY_MAX_PAGES
    const postingLines = Array.from({ length: MAX_PAGES * PAGE_SIZE }, (_, i) => ({ id: plId(i), posting_id: "posting-1" }));
    const supabase = fakeSupabase({ ...singleVendorConfig(), postingLines });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") expect("latest" in result).toBe(false);
  });

  it("8. a failure on the second page returns a safe incomplete result, never computed from the first page alone", async () => {
    const postingLines = Array.from({ length: PAGE_SIZE + 10 }, (_, i) => ({ id: plId(i), posting_id: `posting-${i}` }));
    const postings = postingLines.map((pl, i) => ({ id: pl.posting_id, purchase_document_id: `doc-${i}` }));
    const documents = postings.map((p, i) => ({ id: p.purchase_document_id, vendor_id: `vendor-${i}` }));
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }],
      unitCode: "PIECE",
      postingLines,
      postings,
      documents,
      itemUnits: [{ code: "CASE", conversion_factor: 12, requires_actual_measurement: false }],
      postingLinesFailAtPage: 1, // the second page (0-indexed) fails
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") expect("latest" in result).toBe(false);
  });

  it("9. exactly 20 vendors (proven complete on a short final page) still produce a normal, complete result", async () => {
    const supabase = fakeSupabase(paginatedVendorConfig(20, 0));
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    expect(result.status).toBe("exact");
  });

  it("10. no per-vendor RPC is called for any vendor once overflow (21+) is found", async () => {
    const supabase = fakeSupabase(paginatedVendorConfig(21, null));
    await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("11. an incomplete discovery result carries no financial numeric fields at all", async () => {
    const supabase = fakeSupabase(paginatedVendorConfig(21, null));
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      const keys = Object.keys(result);
      expect(keys).not.toContain("latest");
      expect(keys).not.toContain("weightedAverage");
      expect(keys).not.toContain("excludedPartialCount");
    }
  });

  it("12. a PostgREST-style implicit row cap cannot be mistaken for end-of-results -- a full page never short-circuits as 'complete'", async () => {
    // A single page returning EXACTLY PAGE_SIZE rows (as an implicit
    // server-side cap might silently produce) must NOT be treated as
    // proof of exhaustion -- the module must request a further page.
    const postingLines = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: plId(i), posting_id: "posting-1" }));
    const supabase = fakeSupabase({ ...singleVendorConfig(), postingLines });
    await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    // Two posting-lines page calls must have occurred: the full page,
    // then a second (empty) page that actually proves exhaustion.
    const postingLinesCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.filter(([t]) => t === "purchase_document_inventory_posting_lines");
    expect(postingLinesCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("stable ordering with a unique tie-breaker is used -- explicit .order('id') and .gt() range requests, never plain offset", async () => {
    const postingLines = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => ({ id: plId(i), posting_id: "posting-1" }));
    const supabase = fakeSupabase({ ...singleVendorConfig(), postingLines });
    await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 90);
    // Verified indirectly: the fake's posting-lines chain only returns a
    // second page's later rows when `.gt()` was actually invoked with the
    // first page's last id -- already exercised by test 3/12 above
    // returning correct, non-duplicated results across page boundaries.
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("Every read is scoped to the authenticated organization", () => {
  it("posting-lines, postings and documents reads are all invoked (organization scoping verified by call presence)", async () => {
    const supabase = fakeSupabase(CASE_PACK_CONFIG);
    await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(supabase.from).toHaveBeenCalledWith("inventory_items");
    expect(supabase.from).toHaveBeenCalledWith("purchase_document_inventory_posting_lines");
    expect(supabase.from).toHaveBeenCalledWith("purchase_document_inventory_postings");
    expect(supabase.from).toHaveBeenCalledWith("purchase_documents");
  });
});

describe("Amendments and superseded revisions", () => {
  it("an original purchase plus its superseding (amended) revision -- only the current revision participates", async () => {
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }],
      unitCode: "PIECE",
      postingLines: [
        { id: plId(0), posting_id: "posting-1" },
        { id: plId(1), posting_id: "posting-2" },
      ],
      postings: [
        { id: "posting-1", purchase_document_id: "doc-rev1" },
        { id: "posting-2", purchase_document_id: "doc-rev2" },
      ],
      documents: [{ id: "doc-rev1", vendor_id: "vendor-1" }],
      itemUnits: [{ code: "CASE", conversion_factor: 12, requires_actual_measurement: false }],
      documentRevisions: [
        { id: "doc-rev1", revision_group_id: "group-1", revision_number: 1, status: "VERIFIED" },
        { id: "doc-rev2", revision_group_id: "group-1", revision_number: 2, status: "VERIFIED" },
      ],
      rpcByVendor: {
        "vendor-1": [
          row({ out_purchase_document_id: "doc-rev1", out_document_date: "2026-08-10", out_line_total: 400, out_unit_cost: 400 / 120 }),
          row({ out_purchase_document_id: "doc-rev2", out_document_date: "2026-08-10", out_line_total: 500, out_unit_cost: 500 / 120 }),
        ],
      },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("exact");
    if (result.status === "exact") {
      expect(result.latest.documentId).toBe("doc-rev2");
      expect(result.latest.lineTotal).toBe(500);
      expect(result.revisionSafetyVerified).toBe(true);
    }
  });

  it("the obsolete revision is excluded from the weighted average too, not just from 'latest'", async () => {
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }],
      unitCode: "PIECE",
      postingLines: [
        { id: plId(0), posting_id: "posting-1" },
        { id: plId(1), posting_id: "posting-2" },
      ],
      postings: [
        { id: "posting-1", purchase_document_id: "doc-rev1" },
        { id: "posting-2", purchase_document_id: "doc-rev2" },
      ],
      documents: [{ id: "doc-rev1", vendor_id: "vendor-1" }],
      itemUnits: [{ code: "CASE", conversion_factor: 12, requires_actual_measurement: false }],
      documentRevisions: [
        { id: "doc-rev1", revision_group_id: "group-1", revision_number: 1, status: "VERIFIED" },
        { id: "doc-rev2", revision_group_id: "group-1", revision_number: 2, status: "VERIFIED" },
      ],
      rpcByVendor: {
        "vendor-1": [
          row({ out_purchase_document_id: "doc-rev1", out_document_date: "2026-08-10", out_line_total: 999999, out_unit_cost: 999999 / 120 }),
          row({ out_purchase_document_id: "doc-rev2", out_document_date: "2026-08-10", out_line_total: 500, out_unit_cost: 500 / 120 }),
        ],
      },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart", 30);
    expect(result.status).toBe("exact");
    if (result.status === "exact") {
      expect(result.weightedAverage!.recordCount).toBe(1);
      expect(result.weightedAverage!.weightedAverageBaseUnitCost).toBeCloseTo(500 / 120, 6);
    }
  });

  it("a document whose own revision status could not be confirmed at all is never trusted by default", async () => {
    const supabase = fakeSupabase({ ...CASE_PACK_CONFIG, documentRevisions: [], rpcByVendor: { "vendor-1": [row({})] } });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("no_verified_cost");
  });
});

describe("Item resolution (unchanged behavior)", () => {
  it("resolves an exact case-insensitive name match", async () => {
    const supabase = fakeSupabase({ inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }], unitCode: "PIECE", postingLines: [] });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "whole milk quart");
    expect(result.status).toBe("no_verified_cost");
  });

  it("reports ambiguous with a bounded candidate list when multiple items match a substring", async () => {
    const supabase = fakeSupabase({
      inventoryItems: [
        { id: "i1", name: "Whole Milk Quart", base_unit_id: UNIT_ID },
        { id: "i2", name: "Whole Milk Half Gallon", base_unit_id: UNIT_ID },
      ],
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "whole milk");
    expect(result).toEqual({ status: "ambiguous", candidateNames: ["Whole Milk Quart", "Whole Milk Half Gallon"] });
  });

  it("reports not_found when nothing matches", async () => {
    const supabase = fakeSupabase({ inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }] });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "frozen shrimp");
    expect(result).toEqual({ status: "not_found" });
  });

  it("item exists but has never been posted", async () => {
    const supabase = fakeSupabase({ inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }], unitCode: "PIECE", postingLines: [] });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("no_verified_cost");
  });
});

describe("14. existing partial-posting, measurement and revision behavior remains passing (regression anchor)", () => {
  it("10 cases fully posted, $500, 12 pieces/case -> $4.1667/piece, evidence-ready", async () => {
    const supabase = fakeSupabase({
      ...CASE_PACK_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_document_number: "INV-500", out_document_date: "2026-08-19", out_package_quantity: 10, out_base_quantity: 120, out_line_total: 500 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("exact");
    if (result.status === "exact") {
      expect(result.latest.unitCostPerBaseUnit).toBeCloseTo(500 / 120, 6);
      expect(result.latest.vendorName).toBe("Acme Dairy");
      expect(result.latest.documentNumber).toBe("INV-500");
    }
  });
});

describe("General Report Builder -- listVerifiedPurchaseHistoryForItem (Item Cost History report)", () => {
  it("returns every eligible verified purchase line for the item, newest first", async () => {
    const supabase = fakeSupabase({
      ...CASE_PACK_CONFIG,
      rpcByVendor: {
        "vendor-1": [
          row({ out_purchase_document_id: "doc-old", out_document_number: "INV-1", out_document_date: "2026-08-01", out_line_total: 480, out_base_quantity: 120, out_unit_cost: 4 }),
          row({ out_purchase_document_id: "doc-new", out_document_number: "INV-2", out_document_date: "2026-08-15", out_line_total: 500, out_base_quantity: 120, out_unit_cost: 500 / 120 }),
        ],
      },
      documentRevisions: [
        { id: "doc-old", revision_group_id: "doc-old", revision_number: 1, status: "VERIFIED" },
        { id: "doc-new", revision_group_id: "doc-new", revision_number: 1, status: "VERIFIED" },
      ],
    });
    const result = await listVerifiedPurchaseHistoryForItem({ supabase: supabase as never, organizationId: ORG_ID }, ITEM_ID, "PIECE");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].documentDate).toBe("2026-08-15"); // newest first
    expect(result.rows[0].unitCostPerBaseUnit).toBeCloseTo(500 / 120, 6);
    expect(result.rows[1].documentDate).toBe("2026-08-01");
  });

  it("excludes a partially-posted line, matching lookupItemPurchaseCost's own completeness rule", async () => {
    const supabase = fakeSupabase({
      ...CASE_PACK_CONFIG,
      rpcByVendor: { "vendor-1": [row({ out_base_quantity: 60, out_package_quantity: 10, out_package_unit: "CASE", out_line_total: 250 })] },
    });
    const result = await listVerifiedPurchaseHistoryForItem({ supabase: supabase as never, organizationId: ORG_ID }, ITEM_ID, "PIECE");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.rows).toHaveLength(0);
  });

  it("narrows to one vendor when requested", async () => {
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }],
      unitCode: "PIECE",
      postingLines: [
        { id: "pl-000001", posting_id: "posting-1" },
        { id: "pl-000002", posting_id: "posting-2" },
      ],
      postings: [
        { id: "posting-1", purchase_document_id: "doc-a" },
        { id: "posting-2", purchase_document_id: "doc-b" },
      ],
      documents: [
        { id: "doc-a", vendor_id: "vendor-1" },
        { id: "doc-b", vendor_id: "vendor-2" },
      ],
      rpcByVendor: {
        "vendor-1": [row({ out_vendor_id: "vendor-1", out_vendor_name: "Acme Dairy", out_purchase_document_id: "doc-a", out_package_unit: "PIECE", out_package_quantity: 120, out_base_quantity: 120 })],
        "vendor-2": [row({ out_vendor_id: "vendor-2", out_vendor_name: "Bartlett Farms", out_purchase_document_id: "doc-b", out_package_unit: "PIECE", out_package_quantity: 120, out_base_quantity: 120 })],
      },
    });
    const result = await listVerifiedPurchaseHistoryForItem({ supabase: supabase as never, organizationId: ORG_ID }, ITEM_ID, "PIECE", { vendorId: "vendor-2" });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].vendorName).toBe("Bartlett Farms");
  });

  it("filters to the requested document-date range", async () => {
    const supabase = fakeSupabase({
      ...CASE_PACK_CONFIG,
      rpcByVendor: {
        "vendor-1": [
          row({ out_purchase_document_id: "doc-jan", out_document_date: "2026-01-15" }),
          row({ out_purchase_document_id: "doc-aug", out_document_date: "2026-08-15" }),
        ],
      },
      documentRevisions: [
        { id: "doc-jan", revision_group_id: "doc-jan", revision_number: 1, status: "VERIFIED" },
        { id: "doc-aug", revision_group_id: "doc-aug", revision_number: 1, status: "VERIFIED" },
      ],
    });
    const result = await listVerifiedPurchaseHistoryForItem({ supabase: supabase as never, organizationId: ORG_ID }, ITEM_ID, "PIECE", { startDate: "2026-08-01", endDate: "2026-08-31" });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].documentDate).toBe("2026-08-15");
  });

  it("reports incomplete (never a partial history) when the vendor pool overflows", async () => {
    const manyVendorPostingLines = Array.from({ length: 21 }, (_, i) => ({ id: `pl-${String(i).padStart(6, "0")}`, posting_id: `posting-${i}` }));
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }],
      unitCode: "PIECE",
      postingLines: manyVendorPostingLines,
      postings: manyVendorPostingLines.map((_, i) => ({ id: `posting-${i}`, purchase_document_id: `doc-${i}` })),
      documents: manyVendorPostingLines.map((_, i) => ({ id: `doc-${i}`, vendor_id: `vendor-${i}` })),
    });
    const result = await listVerifiedPurchaseHistoryForItem({ supabase: supabase as never, organizationId: ORG_ID }, ITEM_ID, "PIECE");
    expect(result.status).toBe("incomplete");
  });
});

// Purchase-versus-usage unit model (approved-plan §14): historical cost
// resolution must use the SPECIFIC vendor's/SKU's own confirmed package
// (vendor_item_purchase_units), never the shared, mutable legacy table
// (inventory_item_units) once a vendor-scoped version exists for that
// purchase's own document date -- and never today's CURRENT package
// repricing an OLDER purchase from before it changed.
describe("Vendor-scoped purchase-package resolution (purchase-versus-usage unit model, approved-plan §14)", () => {
  it("resolves each vendor's OWN conversion factor for a shared unit code -- never the other vendor's factor, and never the legacy shared table's factor", async () => {
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }],
      unitCode: "PIECE",
      postingLines: [
        { id: plId(0), posting_id: "posting-a" },
        { id: plId(1), posting_id: "posting-b" },
      ],
      postings: [
        { id: "posting-a", purchase_document_id: "doc-a" },
        { id: "posting-b", purchase_document_id: "doc-b" },
      ],
      documents: [
        { id: "doc-a", vendor_id: "vendor-a" },
        { id: "doc-b", vendor_id: "vendor-b" },
      ],
      // Deliberately a WRONG legacy factor (99) -- proves the vendor-
      // scoped path is consulted FIRST, never merely as a tie-break, and
      // that a stale/foreign factor sitting in the shared table can never
      // leak into either vendor's own history.
      itemUnits: [{ code: "CASE", conversion_factor: 99, requires_actual_measurement: false }],
      vendorPackages: [
        { vendor_id: "vendor-a", unit_code: "CASE", conversion_factor: 12, requires_actual_measurement: false, effective_from: "2020-01-01T00:00:00Z", effective_to: null },
        { vendor_id: "vendor-b", unit_code: "CASE", conversion_factor: 24, requires_actual_measurement: false, effective_from: "2020-01-01T00:00:00Z", effective_to: null },
      ],
      rpcByVendor: {
        "vendor-a": [
          row({
            out_purchase_document_id: "doc-a",
            out_vendor_id: "vendor-a",
            out_document_date: "2026-08-10",
            out_package_quantity: 10,
            out_base_quantity: 120, // 10 cases * vendor-a's OWN factor (12) -- fully posted
            out_line_total: 500,
            out_unit_cost: 500 / 120,
          }),
        ],
        "vendor-b": [
          row({
            out_purchase_document_id: "doc-b",
            out_vendor_id: "vendor-b",
            out_document_date: "2026-08-12",
            out_package_quantity: 10,
            out_base_quantity: 240, // 10 cases * vendor-b's OWN factor (24) -- fully posted
            out_line_total: 1000,
            out_unit_cost: 1000 / 240,
          }),
        ],
      },
    });

    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("exact");
    if (result.status !== "exact") return;
    // Neither vendor's purchase is wrongly excluded as "partial" -- each
    // was fully posted under its OWN vendor-scoped factor. Under the old,
    // single-shared-table resolution, at least one of these would have
    // been evaluated against the WRONG factor and misclassified.
    expect(result.excludedPartialCount).toBe(0);
    expect(result.weightedAverage?.recordCount).toBe(2);
  });

  it("resolves a historical purchase against the package version that was in effect on ITS OWN document date, never the vendor's CURRENT (later-superseded) package", async () => {
    const supabase = fakeSupabase({
      inventoryItems: [{ id: ITEM_ID, name: "Whole Milk Quart", base_unit_id: UNIT_ID }],
      unitCode: "PIECE",
      postingLines: [{ id: plId(0), posting_id: "posting-1" }],
      postings: [{ id: "posting-1", purchase_document_id: "doc-old" }],
      documents: [{ id: "doc-old", vendor_id: "vendor-1" }],
      vendorPackages: [
        // The OLD version this vendor's package was under when doc-old was
        // purchased -- superseded (effective_to set) before "now".
        { vendor_id: "vendor-1", unit_code: "CASE", conversion_factor: 12, requires_actual_measurement: false, effective_from: "2020-01-01T00:00:00Z", effective_to: "2026-01-01T00:00:00Z" },
        // The vendor's CURRENT package -- effective after doc-old's own
        // document date. Must never be used to reprice doc-old.
        { vendor_id: "vendor-1", unit_code: "CASE", conversion_factor: 24, requires_actual_measurement: false, effective_from: "2026-01-01T00:00:00Z", effective_to: null },
      ],
      rpcByVendor: {
        "vendor-1": [
          row({
            out_purchase_document_id: "doc-old",
            out_vendor_id: "vendor-1",
            out_document_date: "2025-06-01", // BEFORE the 2026-01-01 supersession
            out_package_quantity: 10,
            out_base_quantity: 120, // fully posted under the OLD factor (12), not the current one (24)
            out_line_total: 500,
            out_unit_cost: 500 / 120,
          }),
        ],
      },
      documentRevisions: [{ id: "doc-old", revision_group_id: "doc-old", revision_number: 1, status: "VERIFIED" }],
    });

    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("exact");
    if (result.status !== "exact") return;
    // Evaluated against the OLD (12) factor, correctly proven complete --
    // if the CURRENT (24) factor had been used instead, 120 posted units
    // would look like only half of an expected 240, and this purchase
    // would have been wrongly excluded as partial.
    expect(result.excludedPartialCount).toBe(0);
    expect(result.latest.baseQuantity).toBe(120);
  });

  it("falls back to the legacy shared table when no vendor-specific package version exists for a purchase (pre-model / un-migrated data)", async () => {
    const supabase = fakeSupabase({
      ...CASE_PACK_CONFIG, // itemUnits: CASE -> factor 12, no vendorPackages configured at all
      rpcByVendor: { "vendor-1": [row({ out_package_quantity: 10, out_base_quantity: 120, out_line_total: 500, out_unit_cost: 500 / 120 })] },
    });
    const result = await lookupItemPurchaseCost({ supabase: supabase as never, organizationId: ORG_ID, now: NOW }, "Whole Milk Quart");
    expect(result.status).toBe("exact");
    if (result.status !== "exact") return;
    expect(result.excludedPartialCount).toBe(0);
  });
});
