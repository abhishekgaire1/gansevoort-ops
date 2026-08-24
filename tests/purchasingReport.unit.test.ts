import { describe, expect, it, vi } from "vitest";
import { getPurchasingReport, getPurchasingReportPriceChanges } from "@/app/lib/reports/purchasingReport";

// CI-safe: no network, no database -- fakes supabase.rpc() directly.
// Proves this file's own job: forwarding filters verbatim and mapping the
// RPC's jsonb shape into a typed result, never aggregating client-side.

describe("getPurchasingReport", () => {
  it("forwards every filter to get_purchasing_report, defaulting unset ones to null", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { totalPurchaseValue: 0, documentCount: 0, vendorCount: 0, itemCount: 0, byVendor: [], byCategory: [], byItem: [] }, error: null });
    const supabase = { rpc } as never;

    await getPurchasingReport(supabase, "org-1", "2026-08-01", "2026-08-21", { vendorId: "vendor-1" });

    expect(rpc).toHaveBeenCalledWith("get_purchasing_report", {
      p_organization_id: "org-1",
      p_date_from: "2026-08-01",
      p_date_to: "2026-08-21",
      p_vendor_id: "vendor-1",
      p_inventory_category_id: null,
      p_inventory_item_id: null,
    });
  });

  it("maps the jsonb summary and every breakdown array into typed rows", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        totalPurchaseValue: 3336,
        documentCount: 4,
        vendorCount: 2,
        itemCount: 40,
        byVendor: [{ vendorId: "v-1", vendorName: "Capital Paper", totalValue: 3336 }],
        byCategory: [{ categoryId: null, categoryName: null, totalValue: 100 }],
        byItem: [{ itemId: "item-1", itemName: "Napkins", totalValue: 42 }],
      },
      error: null,
    });
    const supabase = { rpc } as never;

    const report = await getPurchasingReport(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(report.totalPurchaseValue).toBe(3336);
    expect(report.byVendor).toEqual([{ id: "v-1", name: "Capital Paper", totalValue: 3336 }]);
    expect(report.byCategory).toEqual([{ id: null, name: "—", totalValue: 100 }]);
    expect(report.byItem).toEqual([{ id: "item-1", name: "Napkins", totalValue: 42 }]);
  });

  it("throws (never silently returns an empty report) when the RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const supabase = { rpc } as never;

    await expect(getPurchasingReport(supabase, "org-1", "2026-08-01", "2026-08-21")).rejects.toThrow("boom");
  });

  // Reports closeout, Phase 2 -- "Purchasing Report uses current-document
  // value." Capital Paper Inc #178606 is a real dev-org document whose
  // subtotal (current-document activity) is $3,336.00 but whose printed
  // total/amountDue (account balance including prior invoices) is
  // $15,565.50. get_purchasing_report never reads purchase_documents.total
  // or amountDue at all -- it sums purchase_document_lines.line_total
  // directly, which is exactly $3,336.00 for this real document (verified
  // live against the actual dev database as part of this fix). This test
  // documents that guarantee at the TS layer: whatever the RPC returns is
  // passed straight through, so the real protection is structural (the
  // RPC's SQL simply never has access to the header total/amountDue
  // fields to begin with), not a client-side recalculation that could
  // drift from what the SQL actually does.
  it("Capital Paper regression: totalPurchaseValue reflects current-document line-sum ($3,336), never the account-balance total ($15,565.50)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { totalPurchaseValue: 3336, documentCount: 1, vendorCount: 1, itemCount: 58, byVendor: [], byCategory: [], byItem: [] },
      error: null,
    });
    const supabase = { rpc } as never;

    const report = await getPurchasingReport(supabase, "org-1", "2026-08-01", "2026-08-31", { vendorId: "capital-paper" });

    expect(report.totalPurchaseValue).toBe(3336);
    expect(report.totalPurchaseValue).not.toBe(15565.5);
  });
});

describe("getPurchasingReportPriceChanges", () => {
  it("forwards the vendor filter and limit to get_purchasing_report_price_changes", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { increases: [], decreases: [] }, error: null });
    const supabase = { rpc } as never;

    await getPurchasingReportPriceChanges(supabase, "org-1", "2026-08-01", "2026-08-21", "vendor-1", null, 5);

    expect(rpc).toHaveBeenCalledWith("get_purchasing_report_price_changes", {
      p_organization_id: "org-1",
      p_date_from: "2026-08-01",
      p_date_to: "2026-08-21",
      p_vendor_id: "vendor-1",
      p_inventory_category_id: null,
      p_limit: 5,
    });
  });

  it("forwards the category filter -- bug fix, previously silently dropped from the Price Changes panel", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { increases: [], decreases: [] }, error: null });
    const supabase = { rpc } as never;

    await getPurchasingReportPriceChanges(supabase, "org-1", "2026-08-01", "2026-08-21", null, "category-1");

    expect(rpc).toHaveBeenCalledWith("get_purchasing_report_price_changes", expect.objectContaining({ p_inventory_category_id: "category-1" }));
  });

  it("defaults to no vendor/category filter and a limit of 10", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { increases: [], decreases: [] }, error: null });
    const supabase = { rpc } as never;

    await getPurchasingReportPriceChanges(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(rpc).toHaveBeenCalledWith("get_purchasing_report_price_changes", expect.objectContaining({ p_vendor_id: null, p_inventory_category_id: null, p_limit: 10 }));
  });

  it("passes increases/decreases through untouched", async () => {
    const increases = [{ itemId: "i1", itemName: "Heavy Cream", vendorId: "v1", vendorName: "Bartlett", baseUnitCode: "PIECE", currentUnitCost: 4.25, previousUnitCost: 4.0, deltaAbs: 0.25, deltaPct: 6.25, currentDocumentNumber: "INV-2", currentDocumentDate: "2026-08-21", previousDocumentNumber: "INV-1", previousDocumentDate: "2026-08-14" }];
    const rpc = vi.fn().mockResolvedValue({ data: { increases, decreases: [] }, error: null });
    const supabase = { rpc } as never;

    const result = await getPurchasingReportPriceChanges(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(result.increases).toEqual(increases);
    expect(result.decreases).toEqual([]);
  });
});
