import { describe, expect, it, vi } from "vitest";
import { getUsageReport } from "@/app/lib/reports/usageReport";

// CI-safe: no network, no database -- fakes supabase.rpc() directly.

describe("getUsageReport", () => {
  it("forwards every filter to get_inventory_usage_report, defaulting unset ones to null", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { movementCount: 0, byItem: [], byStation: [] }, error: null });
    const supabase = { rpc } as never;

    await getUsageReport(supabase, "org-1", "2026-08-01", "2026-08-21", { stationId: "station-1" });

    expect(rpc).toHaveBeenCalledWith("get_inventory_usage_report", {
      p_organization_id: "org-1",
      p_date_from: "2026-08-01",
      p_date_to: "2026-08-21",
      p_station_id: "station-1",
      p_inventory_item_id: null,
      p_location_id: null,
    });
  });

  it("never sums quantities across items -- byItem carries each item's own base unit code alongside its quantity", async () => {
    const data = { movementCount: 2, byItem: [{ itemId: "i1", itemName: "Sour Cream", baseUnitCode: "LB", quantity: 8 }, { itemId: "i2", itemName: "Almond Milk", baseUnitCode: "PIECE", quantity: 11 }], byStation: [] };
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    const supabase = { rpc } as never;

    const report = await getUsageReport(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(report.byItem).toEqual(data.byItem);
    expect(report.byItem[0].baseUnitCode).not.toBe(report.byItem[1].baseUnitCode);
  });

  it("defaults every field to a safe empty shape when the RPC returns nothing", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = { rpc } as never;

    const report = await getUsageReport(supabase, "org-1", "2026-08-01", "2026-08-21");

    expect(report).toEqual({ movementCount: 0, byItem: [], byStation: [] });
  });

  it("throws when the RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const supabase = { rpc } as never;

    await expect(getUsageReport(supabase, "org-1", "2026-08-01", "2026-08-21")).rejects.toThrow("boom");
  });
});
