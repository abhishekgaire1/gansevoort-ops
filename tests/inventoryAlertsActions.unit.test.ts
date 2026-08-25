import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. requireManagerOrAdmin, the service
// role client, and resolveEmployeeDisplayNames are all mocked.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { resolveEmployeeDisplayNamesMock } = vi.hoisted(() => ({ resolveEmployeeDisplayNamesMock: vi.fn() }));
vi.mock("@/app/lib/inventory/cycleCounts", () => ({ resolveEmployeeDisplayNames: resolveEmployeeDisplayNamesMock }));

import { listHighWithdrawalAlertsAction, getHighWithdrawalAlertAction } from "@/app/actions/inventoryAlerts";

const ORG_ID = "org-1";
const MANAGER_AUTH = { ok: true as const, manager: { appUserId: "app-user-1", organizationId: ORG_ID, authUserId: "auth-1", roles: ["manager"] } };

const EXCEPTION_ROW_NEW = {
  id: "exc-new",
  opened_at: "2026-08-24T18:00:00Z",
  inventory_item_id: "item-1",
  station_id: "station-1",
  observed_quantity: 42,
  threshold_quantity_at_detection: 20,
  base_unit_id: "unit-1",
  source_movement_id: "mv-1",
  status: "open",
};
const EXCEPTION_ROW_OLD = { ...EXCEPTION_ROW_NEW, id: "exc-old", opened_at: "2026-08-01T18:00:00Z" };

/** A minimal, chainable, thenable stand-in for a PostgREST query builder --
 * every table this action layer queries is keyed by name in `tableData`. */
function fakeServiceClient(tableData: Record<string, unknown[]>) {
  function builder(table: string) {
    let single = false;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        single = true;
        return chain;
      },
      then: (resolve: (value: { data: unknown; error: null }) => void) => {
        const rows = tableData[table] ?? [];
        resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
      },
    };
    return chain;
  }
  return { from: vi.fn(builder) };
}

const REFERENCE_TABLES = {
  inventory_items: [{ id: "item-1", name: "Chicken Breast" }],
  stations: [{ id: "station-1", name: "Grill" }],
  units: [{ id: "unit-1", code: "LB" }],
  inventory_movements: [{ id: "mv-1", performed_by_app_user_id: "app-user-2", location_id: "loc-1" }],
  locations: [{ id: "loc-1", name: "Walk-in Cooler" }],
};

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER_AUTH);
  getServiceRoleClientMock.mockReset();
  resolveEmployeeDisplayNamesMock.mockReset().mockResolvedValue(new Map([["app-user-2", "Jordan Lee"]]));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listHighWithdrawalAlertsAction", () => {
  it("1. requires manager/admin authorization", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authorized" });
    const result = await listHighWithdrawalAlertsAction();
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
  });

  it("2. organization comes from the authenticated context, not a client input -- no organizationId parameter exists on this action at all", async () => {
    getServiceRoleClientMock.mockReturnValue(fakeServiceClient({ exceptions: [EXCEPTION_ROW_NEW], ...REFERENCE_TABLES }));
    const result = await listHighWithdrawalAlertsAction();
    expect(result.ok).toBe(true);
    // the function signature itself takes zero arguments -- there is no
    // way to influence which organization is queried from the caller.
    expect(listHighWithdrawalAlertsAction.length).toBe(0);
  });

  it("4. alerts are ordered newest first", async () => {
    getServiceRoleClientMock.mockReturnValue(fakeServiceClient({ exceptions: [EXCEPTION_ROW_NEW, EXCEPTION_ROW_OLD], ...REFERENCE_TABLES }));
    const result = await listHighWithdrawalAlertsAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The DB query itself requests `order("opened_at", {ascending:
      // false})` -- this test asserts the resolved rows preserve
      // whatever order the query returned (the fake client returns them
      // in the order supplied, i.e. already-sorted from the real DB).
      expect(result.alerts.map((a) => a.exceptionId)).toEqual(["exc-new", "exc-old"]);
    }
  });

  it("5. an empty result is a supported, non-error state", async () => {
    getServiceRoleClientMock.mockReturnValue(fakeServiceClient({ exceptions: [], ...REFERENCE_TABLES }));
    const result = await listHighWithdrawalAlertsAction();
    expect(result).toEqual({ ok: true, alerts: [] });
  });

  it("resolves item/station/unit/employee/location names instead of raw ids", async () => {
    getServiceRoleClientMock.mockReturnValue(fakeServiceClient({ exceptions: [EXCEPTION_ROW_NEW], ...REFERENCE_TABLES }));
    const result = await listHighWithdrawalAlertsAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alerts[0]).toMatchObject({
        itemName: "Chicken Breast",
        stationName: "Grill",
        unitCode: "LB",
        employeeName: "Jordan Lee",
        sourceLocationName: "Walk-in Cooler",
        observedQuantity: 42,
        thresholdQuantity: 20,
        status: "open",
      });
    }
  });

  it("8. a raw/unexpected server error is never exposed to the browser", async () => {
    getServiceRoleClientMock.mockReturnValue({
      from: vi.fn(() => ({
        select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: { message: "relation inventory_secret_table does not exist" } }) }) }) }),
      })),
    });
    const result = await listHighWithdrawalAlertsAction();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Something went wrong. Try again.");
      expect(result.message).not.toContain("inventory_secret_table");
    }
  });
});

describe("getHighWithdrawalAlertAction", () => {
  it("1. requires manager/admin authorization", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authorized" });
    const result = await getHighWithdrawalAlertAction("exc-new");
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
  });

  it("3. a cross-organization (or nonexistent) exceptionId resolves to alert: null, never another org's data", async () => {
    // the query is org-scoped (.eq("organization_id", ...)) -- the fake
    // client here simulates the DB simply finding no matching row.
    getServiceRoleClientMock.mockReturnValue(fakeServiceClient({ exceptions: [], ...REFERENCE_TABLES }));
    const result = await getHighWithdrawalAlertAction("exc-from-another-org");
    expect(result).toEqual({ ok: true, alert: null });
  });

  it("returns the enriched alert for a valid, same-organization exceptionId", async () => {
    getServiceRoleClientMock.mockReturnValue(fakeServiceClient({ exceptions: [EXCEPTION_ROW_NEW], ...REFERENCE_TABLES }));
    const result = await getHighWithdrawalAlertAction("exc-new");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alert?.itemName).toBe("Chicken Breast");
  });

  it("8. a raw/unexpected server error is never exposed to the browser", async () => {
    getServiceRoleClientMock.mockReturnValue({
      from: vi.fn(() => ({
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "postgres internal relation inventory_secret_table" } }) }) }) }) }),
      })),
    });
    const result = await getHighWithdrawalAlertAction("exc-new");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Something went wrong. Try again.");
      expect(result.message).not.toContain("inventory_secret_table");
    }
  });
});
