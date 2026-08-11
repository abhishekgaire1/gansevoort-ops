import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listActiveStationsForOrganization } from "@/app/lib/kiosk/stations";

// CI-safe: no network, no database -- fakes the Supabase query builder chain,
// same pattern as tests/verifyPin.unit.test.ts's createFakeSupabase.

function createFakeSupabase(rows: Record<string, unknown>[] | null, error: unknown = null) {
  const order = vi.fn().mockResolvedValue({ data: rows, error });
  const eqIsActive = vi.fn().mockReturnValue({ order });
  const eqOrg = vi.fn().mockReturnValue({ eq: eqIsActive });
  const select = vi.fn().mockReturnValue({ eq: eqOrg });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as unknown as SupabaseClient, from, select, eqOrg, eqIsActive, order };
}

describe("listActiveStationsForOrganization", () => {
  it("queries the stations table scoped to organization_id and is_active=true, ordered by name", async () => {
    const { client, from, select, eqOrg, eqIsActive, order } = createFakeSupabase([]);
    await listActiveStationsForOrganization(client, "org-1");

    expect(from).toHaveBeenCalledWith("stations");
    expect(select).toHaveBeenCalledWith("id, name, code");
    expect(eqOrg).toHaveBeenCalledWith("organization_id", "org-1");
    expect(eqIsActive).toHaveBeenCalledWith("is_active", true);
    expect(order).toHaveBeenCalledWith("name");
  });

  it("maps rows to the KioskStation shape, defaulting a null code to null", async () => {
    const { client } = createFakeSupabase([
      { id: "station-1", name: "Grill", code: "GRL" },
      { id: "station-2", name: "Prep", code: null },
    ]);
    const stations = await listActiveStationsForOrganization(client, "org-1");
    expect(stations).toEqual([
      { id: "station-1", name: "Grill", code: "GRL" },
      { id: "station-2", name: "Prep", code: null },
    ]);
  });

  it("returns an empty array when there are no active stations", async () => {
    const { client } = createFakeSupabase(null);
    expect(await listActiveStationsForOrganization(client, "org-1")).toEqual([]);
  });

  it("throws on a Postgres error", async () => {
    const { client } = createFakeSupabase(null, { message: "boom" });
    await expect(listActiveStationsForOrganization(client, "org-1")).rejects.toThrow("boom");
  });
});
