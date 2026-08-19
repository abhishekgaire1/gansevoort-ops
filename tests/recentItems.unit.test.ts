import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listEmployeeRecentWithdrawnItemIds } from "@/app/lib/kiosk/recentItems";

// CI-safe: no network, no database -- fakes list_employee_recent_withdrawn_item_ids.

function createFakeSupabase(rows: Record<string, unknown>[] | null, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data: rows, error });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("listEmployeeRecentWithdrawnItemIds", () => {
  it("calls the RPC scoped to organization, employee, and the default limit", async () => {
    const { client, rpc } = createFakeSupabase([]);
    await listEmployeeRecentWithdrawnItemIds(client, "org-1", "user-1");
    expect(rpc).toHaveBeenCalledWith("list_employee_recent_withdrawn_item_ids", {
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_limit: 6,
    });
  });

  it("respects a custom limit", async () => {
    const { client, rpc } = createFakeSupabase([]);
    await listEmployeeRecentWithdrawnItemIds(client, "org-1", "user-1", 3);
    expect(rpc).toHaveBeenCalledWith("list_employee_recent_withdrawn_item_ids", {
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_limit: 3,
    });
  });

  it("maps rows to a plain ordered array of item ids", async () => {
    const { client } = createFakeSupabase([
      { out_inventory_item_id: "item-3", out_last_withdrawn_at: "2026-08-19T10:00:00Z" },
      { out_inventory_item_id: "item-1", out_last_withdrawn_at: "2026-08-18T10:00:00Z" },
    ]);
    const ids = await listEmployeeRecentWithdrawnItemIds(client, "org-1", "user-1");
    expect(ids).toEqual(["item-3", "item-1"]);
  });

  it("returns an empty array when the employee has no withdrawal history", async () => {
    const { client } = createFakeSupabase([]);
    expect(await listEmployeeRecentWithdrawnItemIds(client, "org-1", "user-1")).toEqual([]);
  });

  it("returns an empty array when data is null", async () => {
    const { client } = createFakeSupabase(null);
    expect(await listEmployeeRecentWithdrawnItemIds(client, "org-1", "user-1")).toEqual([]);
  });

  it("throws on a Postgres error", async () => {
    const { client } = createFakeSupabase(null, { message: "boom" });
    await expect(listEmployeeRecentWithdrawnItemIds(client, "org-1", "user-1")).rejects.toThrow("boom");
  });
});
