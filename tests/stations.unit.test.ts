import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAllActiveStationsForOrganization, listAssignedActiveStationsForEmployee } from "@/app/lib/kiosk/stations";

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

describe("listAllActiveStationsForOrganization -- Admin-only, no per-employee filter", () => {
  it("queries the stations table scoped to organization_id and is_active=true, ordered by name", async () => {
    const { client, from, select, eqOrg, eqIsActive, order } = createFakeSupabase([]);
    await listAllActiveStationsForOrganization(client, "org-1");

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
    const stations = await listAllActiveStationsForOrganization(client, "org-1");
    expect(stations).toEqual([
      { id: "station-1", name: "Grill", code: "GRL" },
      { id: "station-2", name: "Prep", code: null },
    ]);
  });

  it("returns an empty array when there are no active stations", async () => {
    const { client } = createFakeSupabase(null);
    expect(await listAllActiveStationsForOrganization(client, "org-1")).toEqual([]);
  });

  it("throws on a Postgres error", async () => {
    const { client } = createFakeSupabase(null, { message: "boom" });
    await expect(listAllActiveStationsForOrganization(client, "org-1")).rejects.toThrow("boom");
  });
});

describe("listAssignedActiveStationsForEmployee -- the ONLY list the kiosk itself shows", () => {
  function fakeRpc(data: unknown, error: unknown = null) {
    const rpc = vi.fn().mockResolvedValue({ data, error });
    return { client: { rpc } as unknown as SupabaseClient, rpc };
  }

  it("calls list_employee_station_assignments scoped to organization and employee", async () => {
    const { client, rpc } = fakeRpc([]);
    await listAssignedActiveStationsForEmployee(client, "org-1", "employee-1");
    expect(rpc).toHaveBeenCalledWith("list_employee_station_assignments", { p_organization_id: "org-1", p_employee_id: "employee-1" });
  });

  it("maps rows to the KioskStation shape", async () => {
    const { client } = fakeRpc([
      { out_station_id: "station-1", out_station_name: "Grill", out_station_code: "GRL" },
      { out_station_id: "station-2", out_station_name: "Prep", out_station_code: null },
    ]);
    const stations = await listAssignedActiveStationsForEmployee(client, "org-1", "employee-1");
    expect(stations).toEqual([
      { id: "station-1", name: "Grill", code: "GRL" },
      { id: "station-2", name: "Prep", code: null },
    ]);
  });

  it("returns an empty array when the employee has zero active assignments -- never falls back to every organization station", async () => {
    const { client } = fakeRpc([]);
    expect(await listAssignedActiveStationsForEmployee(client, "org-1", "employee-1")).toEqual([]);
  });

  it("throws on an RPC error rather than silently returning an empty list", async () => {
    const { client } = fakeRpc(null, { message: "boom" });
    await expect(listAssignedActiveStationsForEmployee(client, "org-1", "employee-1")).rejects.toThrow("boom");
  });
});
