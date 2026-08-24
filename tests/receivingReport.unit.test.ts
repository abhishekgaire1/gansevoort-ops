import { describe, expect, it, vi } from "vitest";
import { getReceivingReport } from "@/app/lib/reports/receivingReport";

// CI-safe: no network, no database -- fakes supabase.rpc() directly.

describe("getReceivingReport", () => {
  it("forwards the date range and vendor filter to get_receiving_report", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { documentCount: 0, byStatus: [], byVendor: [], creditLineCount: 0, readyToPostCount: 0, partiallyPostedCount: 0, postedCount: 0 },
      error: null,
    });
    const supabase = { rpc } as never;

    await getReceivingReport(supabase, "org-1", "2026-08-01", "2026-08-21", "vendor-1");

    expect(rpc).toHaveBeenCalledWith("get_receiving_report", {
      p_organization_id: "org-1",
      p_date_from: "2026-08-01",
      p_date_to: "2026-08-21",
      p_vendor_id: "vendor-1",
    });
  });

  it("defaults the vendor filter to null when omitted", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { documentCount: 0, byStatus: [], byVendor: [], creditLineCount: 0, readyToPostCount: 0, partiallyPostedCount: 0, postedCount: 0 },
      error: null,
    });
    const supabase = { rpc } as never;

    await getReceivingReport(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(rpc).toHaveBeenCalledWith("get_receiving_report", expect.objectContaining({ p_vendor_id: null }));
  });

  // Regression: readyToPostCount fix (20260811100110) -- a VERIFIED
  // document with zero required inventory lines must never be counted as
  // "ready to post." This test proves the TS layer passes the RPC's
  // already-correct count straight through, unmodified -- the actual
  // exclusion logic lives in the SQL function itself, verified live
  // against real dev data as part of the fix.
  it("passes readyToPostCount straight through from the RPC, never recomputing or re-deriving it client-side", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { documentCount: 6, byStatus: [{ status: "VERIFIED", count: 6 }], byVendor: [], creditLineCount: 2, readyToPostCount: 1, partiallyPostedCount: 0, postedCount: 4 },
      error: null,
    });
    const supabase = { rpc } as never;

    const report = await getReceivingReport(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(report.readyToPostCount).toBe(1);
    expect(report.postedCount).toBe(4);
    expect(report.partiallyPostedCount).toBe(0);
  });

  it("maps every field from the jsonb shape", async () => {
    const data = {
      documentCount: 8,
      byStatus: [{ status: "VERIFIED", count: 6 }, { status: "DRAFT", count: 1 }],
      byVendor: [{ vendorId: "v-1", vendorName: "Bartlett", count: 5 }],
      creditLineCount: 2,
      readyToPostCount: 1,
      partiallyPostedCount: 0,
      postedCount: 4,
    };
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    const supabase = { rpc } as never;

    const report = await getReceivingReport(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(report).toEqual(data);
  });

  it("defaults every field to a safe empty shape when the RPC returns nothing", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = { rpc } as never;

    const report = await getReceivingReport(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(report).toEqual({ documentCount: 0, byStatus: [], byVendor: [], creditLineCount: 0, readyToPostCount: 0, partiallyPostedCount: 0, postedCount: 0 });
  });

  it("throws (never silently returns an empty report) when the RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const supabase = { rpc } as never;

    await expect(getReceivingReport(supabase, "org-1", "2026-08-01", "2026-08-21")).rejects.toThrow("boom");
  });
});
