import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Focused on the RC1 error-handling fix
// for recordInventoryWasteAction -- mirrors tests/cycleCountActions.unit.test.ts.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { recordInventoryWasteMock } = vi.hoisted(() => ({ recordInventoryWasteMock: vi.fn() }));
vi.mock("@/app/lib/inventory/waste", () => ({ recordInventoryWaste: recordInventoryWasteMock }));

vi.mock("@/app/lib/inventory/cycleCounts", () => ({ listStorageEligibleLocations: vi.fn() }));

import { recordInventoryWasteAction } from "@/app/actions/inventoryWaste";
import { InsufficientInventoryError, InvalidStorageLocationError, WasteRequestConflictError } from "@/app/lib/inventory/errors";

const MANAGER_AUTH = { ok: true as const, manager: { appUserId: "app-user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] } };
const SENSITIVE_TEXT = "postgres internal relation inventory_secret_table";

const INPUT = { locationId: "loc-1", inventoryItemId: "item-1", quantity: "3", reasonCode: "SPOILED" as const, clientRequestId: "req-1" };

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER_AUTH);
  getServiceRoleClientMock.mockReset().mockReturnValue({});
  recordInventoryWasteMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordInventoryWasteAction -- unexpected-error handling", () => {
  it("1. an unexpected Error with sensitive-looking internal text is never returned to the client", async () => {
    recordInventoryWasteMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    const result = await recordInventoryWasteAction(INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain(SENSITIVE_TEXT);
  });

  it("2. a non-Error thrown value is not stringified and returned to the client", async () => {
    recordInventoryWasteMock.mockRejectedValue({ weird: "raw object", detail: SENSITIVE_TEXT });
    const result = await recordInventoryWasteAction(INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(SENSITIVE_TEXT);
      expect(result.message).not.toContain("[object Object]");
    }
  });

  it("3. the generic safe message is returned for an unexpected failure", async () => {
    recordInventoryWasteMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    const result = await recordInventoryWasteAction(INPUT);
    expect(result).toEqual({ ok: false, reason: "misconfigured", message: "Something went wrong. Try again." });
  });

  it("4. the internal unexpected error is logged server-side", async () => {
    recordInventoryWasteMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    await recordInventoryWasteAction(INPUT);
    expect(console.error).toHaveBeenCalledWith(
      "recordInventoryWasteAction: unexpected error",
      expect.objectContaining({ locationId: "loc-1", inventoryItemId: "item-1", error: expect.objectContaining({ message: SENSITIVE_TEXT }) })
    );
  });

  it("5a. existing recognized error mapping (InsufficientInventoryError) is unchanged", async () => {
    const err = new InsufficientInventoryError("not enough", JSON.stringify({ availableQuantity: 2, requestedQuantity: 3 }));
    recordInventoryWasteMock.mockRejectedValue(err);
    const result = await recordInventoryWasteAction(INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "insufficient_inventory") {
      expect(result.message).toBe("This quantity exceeds what's currently available at this location.");
    } else {
      throw new Error("expected reason 'insufficient_inventory'");
    }
    expect(console.error).not.toHaveBeenCalled();
  });

  it("5b. existing recognized error mapping (InvalidStorageLocationError) is unchanged", async () => {
    recordInventoryWasteMock.mockRejectedValue(new InvalidStorageLocationError("bad location"));
    const result = await recordInventoryWasteAction(INPUT);
    expect(result).toEqual({ ok: false, reason: "invalid_location", message: "This location is not an active storage location." });
  });

  it("5c. existing recognized error mapping (WasteRequestConflictError) is unchanged", async () => {
    recordInventoryWasteMock.mockRejectedValue(new WasteRequestConflictError("conflict"));
    const result = await recordInventoryWasteAction(INPUT);
    expect(result).toEqual({ ok: false, reason: "request_conflict", message: "This request conflicts with a previous submission. Please try again." });
  });

  it("6. successful waste-recording behavior is unchanged", async () => {
    const rpcResult = { wasteEventId: "we-1", movementId: "mv-1" };
    recordInventoryWasteMock.mockResolvedValue(rpcResult);
    const result = await recordInventoryWasteAction(INPUT);
    expect(result).toEqual({ ok: true, result: rpcResult });
  });

  it("7. RPC parameters and authorization are unchanged", async () => {
    recordInventoryWasteMock.mockResolvedValue({ wasteEventId: "we-1", movementId: "mv-1" });
    await recordInventoryWasteAction(INPUT);
    expect(requireManagerOrAdminMock).toHaveBeenCalledTimes(1);
    expect(recordInventoryWasteMock).toHaveBeenCalledWith(expect.anything(), {
      recordedByAppUserId: "app-user-1",
      locationId: "loc-1",
      inventoryItemId: "item-1",
      quantity: "3",
      reasonCode: "SPOILED",
      note: undefined,
      clientRequestId: "req-1",
    });
  });
});
