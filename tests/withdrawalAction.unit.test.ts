import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Focused on the RC1 error-handling fix
// for recordWithdrawal (app/actions/withdrawal.ts), mirroring
// tests/cycleCountActions.unit.test.ts / tests/inventoryWasteActions.unit.test.ts.

const { verifyKioskTokenMock } = vi.hoisted(() => ({ verifyKioskTokenMock: vi.fn() }));
vi.mock("@/app/lib/auth/kioskToken", () => ({ verifyKioskToken: verifyKioskTokenMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { recordInventoryWithdrawalMock } = vi.hoisted(() => ({ recordInventoryWithdrawalMock: vi.fn() }));
vi.mock("@/app/lib/inventory/withdrawal", () => ({ recordInventoryWithdrawal: recordInventoryWithdrawalMock }));

import { recordWithdrawal, type RecordWithdrawalInput } from "@/app/actions/withdrawal";
import { InsufficientInventoryError, InvalidStorageLocationError } from "@/app/lib/inventory/errors";

const SENSITIVE_TEXT = "postgres internal relation inventory_secret_table";

const INPUT: RecordWithdrawalInput = {
  stationId: "station-1",
  inventoryItemId: "item-1",
  sourceLocationId: "loc-1",
  enteredQuantity: "3",
  enteredUnitId: "unit-1",
  clientRequestId: "req-1",
};

const VALID_TOKEN_VERIFICATION = { ok: true as const, payload: { appUserId: "app-user-1", organizationId: "org-1", issuedAt: 0, sessionStartedAt: 0, nonce: "n" } };

beforeEach(() => {
  process.env.KIOSK_TOKEN_SECRET = "test-secret";
  verifyKioskTokenMock.mockReset().mockReturnValue(VALID_TOKEN_VERIFICATION);
  getServiceRoleClientMock.mockReset().mockReturnValue({});
  recordInventoryWithdrawalMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordWithdrawal -- unexpected-error handling", () => {
  it("1. an unexpected Error with sensitive-looking internal text is never returned to the client", async () => {
    recordInventoryWithdrawalMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    const result = await recordWithdrawal("token", INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain(SENSITIVE_TEXT);
  });

  it("2. a non-Error thrown value is not stringified and returned to the client", async () => {
    recordInventoryWithdrawalMock.mockRejectedValue({ weird: "raw object", detail: SENSITIVE_TEXT });
    const result = await recordWithdrawal("token", INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(SENSITIVE_TEXT);
      expect(result.message).not.toContain("[object Object]");
    }
  });

  it("3. the generic safe message is returned for an unexpected failure", async () => {
    recordInventoryWithdrawalMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    const result = await recordWithdrawal("token", INPUT);
    expect(result).toEqual({ ok: false, reason: "rpc_error", message: "Something went wrong. Try again." });
  });

  it("4. the internal unexpected error is logged server-side", async () => {
    recordInventoryWithdrawalMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    await recordWithdrawal("token", INPUT);
    expect(console.error).toHaveBeenCalledWith(
      "recordWithdrawal: unexpected error",
      expect.objectContaining({ stationId: "station-1", inventoryItemId: "item-1", sourceLocationId: "loc-1", error: expect.objectContaining({ message: SENSITIVE_TEXT }) })
    );
  });

  it("5a. existing recognized error mapping (InsufficientInventoryError) is unchanged", async () => {
    const err = new InsufficientInventoryError("not enough", JSON.stringify({ availableQuantity: 2, requestedQuantity: 3 }));
    recordInventoryWithdrawalMock.mockRejectedValue(err);
    const result = await recordWithdrawal("token", INPUT);
    expect(result).toEqual({ ok: false, reason: "insufficient_inventory", message: "Only 2 is currently available at this location.", availableQuantity: 2 });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("5b. existing recognized error mapping (InvalidStorageLocationError) is unchanged", async () => {
    recordInventoryWithdrawalMock.mockRejectedValue(new InvalidStorageLocationError("bad location"));
    const result = await recordWithdrawal("token", INPUT);
    expect(result).toEqual({ ok: false, reason: "invalid_location", message: "That location is no longer available. Reload and choose again." });
  });

  it("5c. invalid/expired kiosk token mapping is unchanged", async () => {
    verifyKioskTokenMock.mockReturnValue({ ok: false, reason: "expired" });
    const result = await recordWithdrawal("token", INPUT);
    expect(result).toEqual({ ok: false, reason: "invalid_token", message: "Your session has expired. Please sign in again." });
    expect(recordInventoryWithdrawalMock).not.toHaveBeenCalled();
  });

  it("6. successful withdrawal behavior is unchanged", async () => {
    const rpcResult = { movementId: "mv-1" };
    recordInventoryWithdrawalMock.mockResolvedValue(rpcResult);
    const result = await recordWithdrawal("token", INPUT);
    expect(result).toEqual({ ok: true, result: rpcResult });
  });

  it("7. kiosk-token verification and RPC parameters are unchanged", async () => {
    recordInventoryWithdrawalMock.mockResolvedValue({ movementId: "mv-1" });
    await recordWithdrawal("a-real-token", INPUT);
    expect(verifyKioskTokenMock).toHaveBeenCalledWith("a-real-token", "test-secret");
    expect(recordInventoryWithdrawalMock).toHaveBeenCalledWith(expect.anything(), {
      performedByAppUserId: "app-user-1",
      stationId: "station-1",
      inventoryItemId: "item-1",
      sourceLocationId: "loc-1",
      enteredQuantity: "3",
      enteredUnitId: "unit-1",
      measuredBaseQuantity: null,
      notes: null,
      clientRequestId: "req-1",
    });
  });
});
