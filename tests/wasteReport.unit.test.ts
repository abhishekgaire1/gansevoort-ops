import { describe, expect, it, vi } from "vitest";
import { getWasteReport } from "@/app/lib/reports/wasteReport";

// CI-safe: no network, no database -- fakes supabase.rpc() directly.

describe("getWasteReport", () => {
  it("forwards every filter to get_inventory_waste_report, defaulting unset ones to null", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { eventCount: 0, byItem: [], byReason: [] }, error: null });
    const supabase = { rpc } as never;

    await getWasteReport(supabase, "org-1", "2026-08-01", "2026-08-21", { reasonCode: "EXPIRED" });

    expect(rpc).toHaveBeenCalledWith("get_inventory_waste_report", {
      p_organization_id: "org-1",
      p_date_from: "2026-08-01",
      p_date_to: "2026-08-21",
      p_inventory_item_id: null,
      p_location_id: null,
      p_reason_code: "EXPIRED",
      p_inventory_category_id: null,
    });
  });

  it("maps every field from the jsonb shape", async () => {
    const data = { eventCount: 2, byItem: [{ itemId: "i1", itemName: "Oat Milk", unitCode: "PIECE", quantity: 21 }], byReason: [{ reasonCode: "EXPIRED", eventCount: 2 }] };
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    const supabase = { rpc } as never;

    const report = await getWasteReport(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(report).toEqual(data);
  });

  it("defaults every field to a safe empty shape when the RPC returns nothing", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = { rpc } as never;

    const report = await getWasteReport(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(report).toEqual({ eventCount: 0, byItem: [], byReason: [] });
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const supabase = { rpc } as never;

    await expect(getWasteReport(supabase, "org-1", "2026-08-01", "2026-08-21")).rejects.toThrow("boom");
  });
});
