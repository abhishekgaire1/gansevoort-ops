import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { recordReceiptRpcMock, correctVerifierMock } = vi.hoisted(() => ({
  recordReceiptRpcMock: vi.fn(),
  correctVerifierMock: vi.fn(),
}));
vi.mock("@/app/lib/receiving/recordReceiptRpc", () => ({ recordReceiptRpc: recordReceiptRpcMock }));
vi.mock("@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc", () => ({ correctDocumentDeliveryVerifierRpc: correctVerifierMock }));

import { recordReceipt, correctDocumentDeliveryVerifier } from "@/app/actions/receiving";
import { ReceiptNotFoundOrInvalidError, EmployeeNotFoundOrInactiveError } from "@/app/lib/itemMaster/errors";

const MANAGER = {
  ok: true as const,
  manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] },
};

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  getServiceRoleClientMock.mockReset().mockReturnValue({});
  recordReceiptRpcMock.mockReset();
  correctVerifierMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("recordReceipt", () => {
  it("rejects unauthenticated callers before calling the RPC", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await recordReceipt({ receiptKind: "DELIVERY", purchaseDocumentId: "pd-1", lines: [] });
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(recordReceiptRpcMock).not.toHaveBeenCalled();
  });

  it("passes the resolved manager identity through to the RPC", async () => {
    recordReceiptRpcMock.mockResolvedValue({ receiptId: "receipt-1" });
    const result = await recordReceipt({ receiptKind: "DELIVERY", purchaseDocumentId: "pd-1", lines: [] });
    expect(recordReceiptRpcMock).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-1",
      appUserId: "user-1",
      receiptKind: "DELIVERY",
      purchaseDocumentId: "pd-1",
      correctsReceiptId: undefined,
      defaultLocationId: undefined,
      notes: undefined,
      lines: [],
    });
    expect(result).toEqual({ ok: true, receiptId: "receipt-1" });
  });

  it("maps ReceiptNotFoundOrInvalidError to a friendly invalid_receipt result", async () => {
    recordReceiptRpcMock.mockRejectedValue(new ReceiptNotFoundOrInvalidError("not found"));
    const result = await recordReceipt({ receiptKind: "CORRECTION", correctsReceiptId: "receipt-1", lines: [] });
    expect(result).toMatchObject({ ok: false, reason: "invalid_receipt" });
  });
});

describe("correctDocumentDeliveryVerifier", () => {
  it("passes the resolved manager identity through to the RPC", async () => {
    correctVerifierMock.mockResolvedValue(undefined);
    const result = await correctDocumentDeliveryVerifier("doc-1", "emp-1", "wrong person selected");
    expect(correctVerifierMock).toHaveBeenCalledWith(expect.anything(), {
      documentId: "doc-1",
      organizationId: "org-1",
      appUserId: "user-1",
      newEmployeeId: "emp-1",
      reason: "wrong person selected",
    });
    expect(result).toEqual({ ok: true });
  });

  it("maps EmployeeNotFoundOrInactiveError to a friendly invalid_employee result", async () => {
    correctVerifierMock.mockRejectedValue(new EmployeeNotFoundOrInactiveError("inactive"));
    const result = await correctDocumentDeliveryVerifier("doc-1", "emp-1");
    expect(result).toMatchObject({ ok: false, reason: "invalid_employee" });
  });
});
