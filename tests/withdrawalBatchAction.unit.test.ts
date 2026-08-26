import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Focused on the RC1 error-handling fix
// for recordWithdrawalBatch (app/actions/withdrawalBatch.ts).

const { verifyKioskTokenMock } = vi.hoisted(() => ({ verifyKioskTokenMock: vi.fn() }));
vi.mock("@/app/lib/auth/kioskToken", () => ({ verifyKioskToken: verifyKioskTokenMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { recordInventoryWithdrawalBatchMock } = vi.hoisted(() => ({ recordInventoryWithdrawalBatchMock: vi.fn() }));
vi.mock("@/app/lib/inventory/withdrawalBatch", () => ({ recordInventoryWithdrawalBatch: recordInventoryWithdrawalBatchMock }));

import { recordWithdrawalBatch, type RecordWithdrawalBatchInput } from "@/app/actions/withdrawalBatch";
import { BatchInsufficientInventoryError, InvalidStorageLocationError, KioskUsageUnitNotAuthorizedError } from "@/app/lib/inventory/errors";

const SENSITIVE_TEXT = "postgres internal relation inventory_secret_table";

const CART_LINES = [
  { inventoryItemId: "item-1", sourceLocationId: "loc-1", enteredQuantity: "2", enteredUnitId: "unit-1", measuredBaseQuantity: null, notes: null },
  { inventoryItemId: "item-2", sourceLocationId: "loc-1", enteredQuantity: "1", enteredUnitId: "unit-2", measuredBaseQuantity: null, notes: null },
];

const INPUT: RecordWithdrawalBatchInput = { stationId: "station-1", cartLines: CART_LINES, clientRequestId: "batch-req-1" };

const VALID_TOKEN_VERIFICATION = { ok: true as const, payload: { appUserId: "app-user-1", organizationId: "org-1", issuedAt: 0, sessionStartedAt: 0, nonce: "n" } };

beforeEach(() => {
  process.env.KIOSK_TOKEN_SECRET = "test-secret";
  verifyKioskTokenMock.mockReset().mockReturnValue(VALID_TOKEN_VERIFICATION);
  getServiceRoleClientMock.mockReset().mockReturnValue({});
  recordInventoryWithdrawalBatchMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordWithdrawalBatch -- unexpected-error handling", () => {
  it("1. an unexpected Error with sensitive-looking internal text is never returned to the client", async () => {
    recordInventoryWithdrawalBatchMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    const result = await recordWithdrawalBatch("token", INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain(SENSITIVE_TEXT);
  });

  it("2. a non-Error thrown value is not stringified and returned to the client", async () => {
    recordInventoryWithdrawalBatchMock.mockRejectedValue({ weird: "raw object", detail: SENSITIVE_TEXT });
    const result = await recordWithdrawalBatch("token", INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(SENSITIVE_TEXT);
      expect(result.message).not.toContain("[object Object]");
    }
  });

  it("3. the generic safe message is returned for an unexpected failure", async () => {
    recordInventoryWithdrawalBatchMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    const result = await recordWithdrawalBatch("token", INPUT);
    expect(result).toEqual({ ok: false, reason: "rpc_error", message: "Something went wrong. Try again." });
  });

  it("4. the internal unexpected error is logged server-side", async () => {
    recordInventoryWithdrawalBatchMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    await recordWithdrawalBatch("token", INPUT);
    expect(console.error).toHaveBeenCalledWith(
      "recordWithdrawalBatch: unexpected error",
      expect.objectContaining({ stationId: "station-1", lineCount: 2, error: expect.objectContaining({ message: SENSITIVE_TEXT }) })
    );
  });

  it("5a. existing recognized error mapping (BatchInsufficientInventoryError) is unchanged, including insufficientLines", async () => {
    const lines = [{ inventoryItemId: "item-1", availableQuantity: 1, requestedQuantity: 2 }];
    const err = new BatchInsufficientInventoryError("not enough", JSON.stringify(lines));
    recordInventoryWithdrawalBatchMock.mockRejectedValue(err);
    const result = await recordWithdrawalBatch("token", INPUT);
    expect(result).toEqual({ ok: false, reason: "insufficient_inventory", message: "Inventory changed while you were selecting items.", insufficientLines: lines });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("5b. existing recognized error mapping (InvalidStorageLocationError) is unchanged", async () => {
    recordInventoryWithdrawalBatchMock.mockRejectedValue(new InvalidStorageLocationError("bad location"));
    const result = await recordWithdrawalBatch("token", INPUT);
    expect(result).toEqual({ ok: false, reason: "invalid_location", message: "One of the selected locations is no longer available. Reload and choose again." });
  });

  it("5d. KioskUsageUnitNotAuthorizedError (server-side kiosk-unit authorization, 20260811100115) maps to unit_not_authorized without logging", async () => {
    recordInventoryWithdrawalBatchMock.mockRejectedValue(new KioskUsageUnitNotAuthorizedError("entered_unit_id is not an authorized active kiosk usage unit"));
    const result = await recordWithdrawalBatch("token", INPUT);
    expect(result).toEqual({ ok: false, reason: "unit_not_authorized", message: "One item's withdrawal unit changed. Reload and choose again." });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("5c. invalid/expired kiosk token mapping is unchanged", async () => {
    verifyKioskTokenMock.mockReturnValue({ ok: false, reason: "session_expired" });
    const result = await recordWithdrawalBatch("token", INPUT);
    expect(result).toEqual({ ok: false, reason: "invalid_token", message: "Your session has expired. Please sign in again." });
    expect(recordInventoryWithdrawalBatchMock).not.toHaveBeenCalled();
  });

  it("6. successful batch behavior is unchanged", async () => {
    const rpcResult = { movementIds: ["mv-1", "mv-2"] };
    recordInventoryWithdrawalBatchMock.mockResolvedValue(rpcResult);
    const result = await recordWithdrawalBatch("token", INPUT);
    expect(result).toEqual({ ok: true, result: rpcResult });
  });

  it("7. kiosk-token verification, station context, idempotency key, and full cart-line shape are unchanged (all-or-nothing at the action boundary)", async () => {
    recordInventoryWithdrawalBatchMock.mockResolvedValue({ movementIds: ["mv-1", "mv-2"] });
    await recordWithdrawalBatch("a-real-token", INPUT);
    expect(verifyKioskTokenMock).toHaveBeenCalledWith("a-real-token", "test-secret");
    expect(recordInventoryWithdrawalBatchMock).toHaveBeenCalledTimes(1);
    expect(recordInventoryWithdrawalBatchMock).toHaveBeenCalledWith(expect.anything(), {
      performedByAppUserId: "app-user-1",
      stationId: "station-1",
      clientRequestId: "batch-req-1",
      cartLines: CART_LINES,
    });
  });
});
