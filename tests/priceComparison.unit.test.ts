import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceivingLineInfo } from "@/app/lib/receiving/getReceivingLines";

// CI-safe: pure-function tests need no mocking at all; the orchestration
// tests mock every Supabase/RPC collaborator -- no network, no database.

import { classifyLineForPriceComparison, comparePrices, computeCurrentBaseQuantity } from "@/app/lib/purchasing/priceComparison";

function line(overrides: Partial<ReceivingLineInfo> = {}): ReceivingLineInfo {
  return {
    lineKey: "line-1",
    description: null,
    vendorSku: null,
    invoicePackageQuantity: null,
    invoicePackageUnit: null,
    disposition: "INVENTORY",
    inventoryItemId: "item-1",
    baseUnitCode: "PIECE",
    baseUnitId: "unit-piece",
    purchaseUnitCode: "CASE",
    receivingBehavior: "FIXED_CONVERSION",
    fixedConversionFactor: 12,
    requiresVerifiedMeasurement: false,
    defaultReceivingLocationId: null,
    confirmedInvoiceUnitCode: null,
    ...overrides,
  };
}

describe("computeCurrentBaseQuantity -- real Bartlett Dairy regression (double-normalization bug)", () => {
  // ============================================================
  // The bug: a FIXED_CONVERSION item's invoice quantity was ALWAYS
  // multiplied by fixedConversionFactor, assuming it was always stated in
  // the item's purchase/case unit. Real Bartlett invoices bill this exact
  // item in PIECE (the base unit) -- vendor_item_mappings.
  // confirmed_invoice_unit_id already records this. Multiplying anyway
  // silently divided an already-correct per-PIECE price by the case-pack
  // size a second time.
  // ============================================================

  it("Case 1 -- HEAVY CREAM 40% QUART (12): confirmed invoice unit is PIECE (the base unit) -- quantity 48 means 48 PIECE, NOT 48 CASE", () => {
    const l = line({
      description: "HEAVY CREAM 40% QUART (12)",
      vendorSku: "101102",
      invoicePackageQuantity: 48,
      confirmedInvoiceUnitCode: "PIECE",
    });
    const baseQuantity = computeCurrentBaseQuantity(l, null);
    expect(baseQuantity).toBe(48); // NOT 576 (48 * 12)
    const currentUnitCost = 210.15 / baseQuantity!;
    expect(currentUnitCost).toBeCloseTo(4.37808, 2); // NOT 0.36484
  });

  it("Case 2 -- FML HALF & HALF QT (12): same fix, quantity 12 means 12 PIECE", () => {
    const l = line({ description: "FML HALF & HALF QT (12)", invoicePackageQuantity: 12, confirmedInvoiceUnitCode: "PIECE" });
    const baseQuantity = computeCurrentBaseQuantity(l, null);
    expect(baseQuantity).toBe(12); // NOT 144
    const currentUnitCost = 28.19 / baseQuantity!;
    expect(currentUnitCost).toBeCloseTo(2.34934, 1); // NOT 0.19578
  });

  it("Case 3 -- MILK PLASTIC QT (16): quantity 80 means 80 PIECE, factor 16 must not apply", () => {
    const l = line({ description: "MILK PLASTIC QT (16)", invoicePackageQuantity: 80, fixedConversionFactor: 16, confirmedInvoiceUnitCode: "PIECE" });
    const baseQuantity = computeCurrentBaseQuantity(l, null);
    expect(baseQuantity).toBe(80); // NOT 1280
    const currentUnitCost = 116.2 / baseQuantity!;
    expect(currentUnitCost).toBeCloseTo(1.4525, 2); // NOT 0.09078
  });

  it("Case 4 -- a real CASE-price conversion: confirmed invoice unit IS the purchase unit, factor correctly applies", () => {
    const l = line({ invoicePackageQuantity: 4, purchaseUnitCode: "CASE", fixedConversionFactor: 12, confirmedInvoiceUnitCode: "CASE" });
    const baseQuantity = computeCurrentBaseQuantity(l, null);
    expect(baseQuantity).toBe(48); // 4 CASE * 12 PIECE/CASE
    const currentUnitCost = 192.0 / baseQuantity!;
    expect(currentUnitCost).toBeCloseTo(4.0, 6);
  });

  it("Case 5 -- ambiguous basis (no stated invoice unit, no confirmed mapping): no base quantity, never guessed", () => {
    const l = line({ invoicePackageQuantity: 48, invoicePackageUnit: null, confirmedInvoiceUnitCode: null });
    expect(computeCurrentBaseQuantity(l, null)).toBeNull();
  });

  it("Case 6 -- ordinary currency rounding in line_total does not affect price-basis detection (basis comes from the confirmed unit, not from re-deriving it out of the total)", () => {
    const l = line({ invoicePackageQuantity: 12, confirmedInvoiceUnitCode: "PIECE" });
    // 12 * 2.34934 = 28.19208, rounded to 28.19 on the real invoice --
    // basis detection must still resolve to 12 PIECE regardless.
    expect(computeCurrentBaseQuantity(l, null)).toBe(12);
  });

  it("an EXPLICIT invoice package unit matching the base unit also works without a confirmed mapping", () => {
    const l = line({ invoicePackageQuantity: 48, invoicePackageUnit: "PIECE", confirmedInvoiceUnitCode: null });
    expect(computeCurrentBaseQuantity(l, null)).toBe(48);
  });

  it("a genuine invoice-vs-remembered conflict yields no base quantity (never silently resolved either direction)", () => {
    const l = line({ invoicePackageQuantity: 48, invoicePackageUnit: "CASE", confirmedInvoiceUnitCode: "PIECE" });
    expect(computeCurrentBaseQuantity(l, null)).toBeNull();
  });

  it("SAME_UNIT: the package quantity IS the base quantity", () => {
    const l = line({ receivingBehavior: "SAME_UNIT", invoicePackageQuantity: 24, invoicePackageUnit: null });
    expect(computeCurrentBaseQuantity(l, null)).toBe(24);
  });

  it("SAME_UNIT: a stated invoice unit conflicting with the base unit yields no base quantity", () => {
    const l = line({ receivingBehavior: "SAME_UNIT", invoicePackageQuantity: 24, invoicePackageUnit: "CASE", baseUnitCode: "PIECE" });
    expect(computeCurrentBaseQuantity(l, null)).toBeNull();
  });

  it("MEASURE_EACH_DELIVERY: never derives a base quantity from the invoice alone -- only the manager's own verified measurement counts", () => {
    const l = line({ receivingBehavior: "MEASURE_EACH_DELIVERY", invoicePackageQuantity: 5, fixedConversionFactor: null });
    expect(computeCurrentBaseQuantity(l, null)).toBeNull();
    expect(computeCurrentBaseQuantity(l, 90.4)).toBe(90.4);
  });

  it("COUNT_EACH_DELIVERY: same rule as MEASURE_EACH_DELIVERY", () => {
    const l = line({ receivingBehavior: "COUNT_EACH_DELIVERY", invoicePackageQuantity: 5, fixedConversionFactor: null });
    expect(computeCurrentBaseQuantity(l, null)).toBeNull();
    expect(computeCurrentBaseQuantity(l, 40)).toBe(40);
  });

  it("a missing or non-positive invoice package quantity never produces a base quantity", () => {
    expect(computeCurrentBaseQuantity(line({ invoicePackageQuantity: null }), null)).toBeNull();
    expect(computeCurrentBaseQuantity(line({ invoicePackageQuantity: 0 }), null)).toBeNull();
  });

  it("an unresolved (null) receiving behavior never produces a base quantity", () => {
    expect(computeCurrentBaseQuantity(line({ receivingBehavior: null, invoicePackageQuantity: 24 }), null)).toBeNull();
  });
});

describe("classifyLineForPriceComparison", () => {
  const ELIGIBLE_BASE = { disposition: "INVENTORY" as const, vendorId: "vendor-1", lineTotal: 51, baseQuantity: 12, receivingBehavior: "FIXED_CONVERSION" as const };

  it("a non-inventory line never gets a canonical price comparison", () => {
    expect(classifyLineForPriceComparison({ ...ELIGIBLE_BASE, disposition: "NON_INVENTORY" })).toEqual({ eligible: false, reason: "NON_INVENTORY" });
  });

  it("an unresolved line is not eligible", () => {
    expect(classifyLineForPriceComparison({ ...ELIGIBLE_BASE, disposition: "UNRESOLVED" })).toEqual({ eligible: false, reason: "UNRESOLVED" });
  });

  it("no vendor on the parent document -- comparison unavailable", () => {
    expect(classifyLineForPriceComparison({ ...ELIGIBLE_BASE, vendorId: null })).toEqual({ eligible: false, reason: "NO_VENDOR" });
  });

  it("a free line (line_total === 0) never produces a price-change warning", () => {
    expect(classifyLineForPriceComparison({ ...ELIGIBLE_BASE, lineTotal: 0 })).toEqual({ eligible: false, reason: "FREE_LINE" });
  });

  it("a credit line (negative line_total) never gets a standard purchase-price comparison", () => {
    expect(classifyLineForPriceComparison({ ...ELIGIBLE_BASE, lineTotal: -36 })).toEqual({ eligible: false, reason: "CREDIT_LINE" });
  });

  it("a missing line_total is unavailable, distinct from a genuinely free line", () => {
    expect(classifyLineForPriceComparison({ ...ELIGIBLE_BASE, lineTotal: null })).toEqual({ eligible: false, reason: "MISSING_LINE_TOTAL" });
  });

  it("no computable base quantity for a FIXED_CONVERSION item -- missing/incompatible conversion", () => {
    expect(classifyLineForPriceComparison({ ...ELIGIBLE_BASE, baseQuantity: null, receivingBehavior: "FIXED_CONVERSION" })).toEqual({ eligible: false, reason: "MISSING_CONVERSION" });
  });

  it("no receiving behavior resolved at all -- also a missing-conversion condition, not a normal wait", () => {
    expect(classifyLineForPriceComparison({ ...ELIGIBLE_BASE, baseQuantity: null, receivingBehavior: null })).toEqual({ eligible: false, reason: "MISSING_CONVERSION" });
  });

  it("no computable base quantity for a MEASURE_EACH_DELIVERY item -- a normal, expected wait for Confirm Receiving, not a data problem", () => {
    expect(classifyLineForPriceComparison({ ...ELIGIBLE_BASE, baseQuantity: null, receivingBehavior: "MEASURE_EACH_DELIVERY" })).toEqual({ eligible: false, reason: "AWAITING_RECEIVING_CONFIRMATION" });
  });

  it("no computable base quantity for a COUNT_EACH_DELIVERY item -- same normal-wait treatment", () => {
    expect(classifyLineForPriceComparison({ ...ELIGIBLE_BASE, baseQuantity: null, receivingBehavior: "COUNT_EACH_DELIVERY" })).toEqual({ eligible: false, reason: "AWAITING_RECEIVING_CONFIRMATION" });
  });

  it("a fully eligible line passes classification", () => {
    expect(classifyLineForPriceComparison(ELIGIBLE_BASE)).toEqual({ eligible: true });
  });
});

describe("comparePrices", () => {
  it("previous 4.00 -> current 4.25 is a +6.25% increase", () => {
    const result = comparePrices(4.25, 4.0);
    expect(result.deltaAbs).toBeCloseTo(0.25, 6);
    expect(result.deltaPct).toBeCloseTo(6.25, 6);
    expect(result.direction).toBe("increase");
  });

  it("previous 4.25 -> current 4.00 is a -5.882...% decrease", () => {
    const result = comparePrices(4.0, 4.25);
    expect(result.deltaAbs).toBeCloseTo(-0.25, 6);
    expect(result.deltaPct).toBeCloseTo(-5.882352941, 6);
    expect(result.direction).toBe("decrease");
  });

  it("Heavy Cream regression: previous 4.38, current 4.37808 -- effectively unchanged, never a misleading swing", () => {
    const result = comparePrices(4.37808, 4.38);
    expect(result.direction).toBe("unchanged");
    // The precise percentage is still computed and available (Section 9 --
    // never lost, only the DIRECTION classification is tolerance-widened).
    expect(result.deltaPct).toBeCloseTo(((4.37808 - 4.38) / 4.38) * 100, 6);
  });

  it("an identical price is unchanged", () => {
    const result = comparePrices(4.0, 4.0);
    expect(result.deltaAbs).toBe(0);
    expect(result.direction).toBe("unchanged");
  });

  it("a change right at the tolerance boundary is NOT misclassified as a big swing", () => {
    // previous 1.00, current 0.99 -- 1 cent absolute difference, within
    // the 2-cent absolute tolerance -- unchanged despite being a nominal
    // 1% relative change on a small base price.
    const result = comparePrices(0.99, 1.0);
    expect(result.direction).toBe("unchanged");
  });

  it("a real, meaningful decrease on a small base price is still detected once it exceeds tolerance", () => {
    const result = comparePrices(0.9, 1.0);
    expect(result.direction).toBe("decrease");
  });

  it("full precision is preserved -- percentage is never computed from a UI-rounded display value", () => {
    const result = comparePrices(4.37808, 4.15123);
    expect(result.deltaAbs).toBeCloseTo(4.37808 - 4.15123, 10);
    expect(result.deltaPct).toBeCloseTo(((4.37808 - 4.15123) / 4.15123) * 100, 10);
  });
});

// ============================================================
// Orchestration: getPriceComparisonsForDocument / getPriceHistoryForItem
// ============================================================

const { getReceivingLinesMock } = vi.hoisted(() => ({ getReceivingLinesMock: vi.fn() }));
vi.mock("@/app/lib/receiving/getReceivingLines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/receiving/getReceivingLines")>();
  return { ...actual, getReceivingLines: getReceivingLinesMock };
});

const { getEffectiveReceivingLinesMock } = vi.hoisted(() => ({ getEffectiveReceivingLinesMock: vi.fn() }));
vi.mock("@/app/lib/receiving/effectiveReceivingEdit", () => ({ getEffectiveReceivingLines: getEffectiveReceivingLinesMock }));

import { getPriceComparisonsForDocument, getPriceHistoryForItem } from "@/app/lib/purchasing/priceComparison";

function fakeSupabase(opts: { vendorId: string | null; lineTotals: Record<string, number | null>; rpcRows: Record<string, unknown>[] }) {
  const rpc = vi.fn().mockResolvedValue({ data: opts.rpcRows, error: null });
  const from = vi.fn((table: string) => {
    if (table === "purchase_documents") {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { vendor_id: opts.vendorId }, error: null }) }) }) }) };
    }
    if (table === "purchase_document_lines") {
      const rows = Object.entries(opts.lineTotals).map(([line_key, line_total]) => ({ line_key, line_total }));
      return { select: () => ({ eq: () => ({ eq: async () => ({ data: rows, error: null }) }) }) };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return { from, rpc };
}

beforeEach(() => {
  getReceivingLinesMock.mockReset();
  getEffectiveReceivingLinesMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getPriceComparisonsForDocument", () => {
  it("real Bartlett Heavy Cream end-to-end: current $4.37808/PIECE (48 PIECE, not 576) vs a real previous $4.38/PIECE -- effectively unchanged, never a misleading 91.7% decrease", async () => {
    getReceivingLinesMock.mockResolvedValue([
      line({
        lineKey: "line-cream",
        description: "HEAVY CREAM 40% QUART (12)",
        vendorSku: "101102",
        invoicePackageQuantity: 48,
        confirmedInvoiceUnitCode: "PIECE",
        inventoryItemId: "item-cream",
        baseUnitCode: "PIECE",
      }),
    ]);
    const supabase = fakeSupabase({
      vendorId: "vendor-bartlett",
      lineTotals: { "line-cream": 210.15 },
      rpcRows: [
        {
          out_inventory_item_id: "item-cream",
          out_rank: 1,
          out_purchase_document_id: "pd-prev",
          out_document_number: "3733660",
          out_document_date: "2026-08-14",
          out_vendor_id: "vendor-bartlett",
          out_vendor_name: "Bartlett",
          out_package_quantity: 48,
          out_package_unit: null,
          out_line_total: 210.15,
          out_base_quantity: 48,
          out_base_unit_code: "PIECE",
          out_unit_cost: 4.378125,
        },
      ],
    });

    const result = await getPriceComparisonsForDocument(supabase as never, "pd-current", "org-1");

    const cream = result.get("line-cream");
    expect(cream).toEqual(
      expect.objectContaining({
        available: true,
        currentUnitCost: 4.378125,
        baseUnitCode: "PIECE",
        direction: "unchanged",
      })
    );
    // NOT the old buggy value.
    expect((cream as { currentUnitCost: number }).currentUnitCost).not.toBeCloseTo(0.36484, 2);
  });

  it("batches into exactly one RPC call regardless of how many resolved lines are on the document", async () => {
    getReceivingLinesMock.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) =>
        line({
          lineKey: `line-${i}`,
          inventoryItemId: `item-${i}`,
          baseUnitCode: "EA",
          receivingBehavior: "SAME_UNIT",
          invoicePackageQuantity: 1,
          fixedConversionFactor: null,
        })
      )
    );
    const lineTotals = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`line-${i}`, 10]));
    const supabase = fakeSupabase({ vendorId: "vendor-1", lineTotals, rpcRows: [] });

    await getPriceComparisonsForDocument(supabase as never, "pd-current", "org-1");

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("first recorded purchase produces no fake comparison", async () => {
    getReceivingLinesMock.mockResolvedValue([
      line({ lineKey: "line-new-item", inventoryItemId: "item-new", baseUnitCode: "EA", receivingBehavior: "SAME_UNIT", invoicePackageQuantity: 2, fixedConversionFactor: null }),
    ]);
    const supabase = fakeSupabase({ vendorId: "vendor-bartlett", lineTotals: { "line-new-item": 10 }, rpcRows: [] });

    const result = await getPriceComparisonsForDocument(supabase as never, "pd-current", "org-1");

    expect(result.get("line-new-item")).toEqual({ available: false, reason: "FIRST_PURCHASE" });
  });
});

describe("getPriceHistoryForItem", () => {
  it("requests the drill-down for exactly one item with a higher limit, never eagerly for every line", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { out_inventory_item_id: "item-1", out_rank: 1, out_purchase_document_id: "pd-1", out_document_number: "INV-3", out_document_date: "2026-08-21", out_vendor_id: "v-1", out_vendor_name: "Vendor", out_package_quantity: 1, out_package_unit: "EA", out_line_total: 4.25, out_base_quantity: 1, out_base_unit_code: "EA", out_unit_cost: 4.25 },
        { out_inventory_item_id: "item-1", out_rank: 2, out_purchase_document_id: "pd-2", out_document_number: "INV-2", out_document_date: "2026-08-14", out_vendor_id: "v-1", out_vendor_name: "Vendor", out_package_quantity: 1, out_package_unit: "EA", out_line_total: 4.0, out_base_quantity: 1, out_base_unit_code: "EA", out_unit_cost: 4.0 },
      ],
      error: null,
    });
    const supabase = { rpc } as never;

    const history = await getPriceHistoryForItem(supabase, "org-1", "vendor-1", "item-1", 8);

    expect(rpc).toHaveBeenCalledWith("get_inventory_item_price_history", {
      p_organization_id: "org-1",
      p_vendor_id: "vendor-1",
      p_inventory_item_ids: ["item-1"],
      p_limit_per_item: 8,
    });
    expect(history).toEqual([
      { purchaseDocumentId: "pd-1", documentNumber: "INV-3", documentDate: "2026-08-21", vendorName: "Vendor", unitCost: 4.25 },
      { purchaseDocumentId: "pd-2", documentNumber: "INV-2", documentDate: "2026-08-14", vendorName: "Vendor", unitCost: 4.0 },
    ]);
  });
});
