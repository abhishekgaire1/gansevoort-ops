import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const {
  initializeMock,
  saveMock,
  submitMock,
  verifyMock,
  returnMock,
} = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  saveMock: vi.fn(),
  submitMock: vi.fn(),
  verifyMock: vi.fn(),
  returnMock: vi.fn(),
}));
vi.mock("@/app/lib/purchaseDocuments/initializePurchaseDocumentDraftRpc", () => ({ initializePurchaseDocumentDraftRpc: initializeMock }));
vi.mock("@/app/lib/purchaseDocuments/savePurchaseDocumentDraftRpc", () => ({ savePurchaseDocumentDraftRpc: saveMock }));
vi.mock("@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc", () => ({
  submitPurchaseDocumentForVerificationRpc: submitMock,
}));
vi.mock("@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc", () => ({ verifyPurchaseDocumentRpc: verifyMock }));
vi.mock("@/app/lib/purchaseDocuments/returnPurchaseDocumentToDraftRpc", () => ({ returnPurchaseDocumentToDraftRpc: returnMock }));

import {
  createOrOpenPurchaseDocumentDraft,
  savePurchaseDocumentDraft,
  submitPurchaseDocumentForVerification,
  verifyPurchaseDocument,
  returnPurchaseDocumentToDraft,
} from "@/app/actions/purchaseDocuments";
import { NotPreparerError, CannotSelfVerifyError, StaleVersionError } from "@/app/lib/purchaseDocuments/errors";

const MANAGER = {
  ok: true as const,
  manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] },
};

const HEADER = {
  vendorId: "vendor-1",
  documentType: "INVOICE" as const,
  documentNumber: "839291",
  documentDate: "2026-08-12",
  poNumber: null,
  deliveryDate: null,
  subtotal: 100,
  tax: 0,
  fees: 0,
  total: 100,
  currency: "USD",
};

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  getServiceRoleClientMock.mockReset().mockReturnValue({});
  initializeMock.mockReset();
  saveMock.mockReset();
  submitMock.mockReset();
  verifyMock.mockReset();
  returnMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createOrOpenPurchaseDocumentDraft", () => {
  it("rejects unauthenticated callers before calling the RPC", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await createOrOpenPurchaseDocumentDraft("doc-1");
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(initializeMock).not.toHaveBeenCalled();
  });

  it("passes the resolved manager identity to the RPC and returns its result", async () => {
    initializeMock.mockResolvedValue({ purchaseDocumentId: "pd-1", status: "DRAFT", created: true });
    const result = await createOrOpenPurchaseDocumentDraft("doc-1");
    expect(initializeMock).toHaveBeenCalledWith(expect.anything(), {
      documentId: "doc-1",
      organizationId: "org-1",
      appUserId: "user-1",
    });
    expect(result).toEqual({ ok: true, purchaseDocumentId: "pd-1", status: "DRAFT", created: true });
  });

  it("maps NotPreparerError to a friendly not_preparer result", async () => {
    initializeMock.mockRejectedValue(new NotPreparerError("not the uploader"));
    const result = await createOrOpenPurchaseDocumentDraft("doc-1");
    expect(result).toMatchObject({ ok: false, reason: "not_preparer" });
    expect((result as { message: string }).message).not.toContain("not the uploader"); // never the raw RPC message
  });
});

describe("savePurchaseDocumentDraft", () => {
  it("forwards header/lines and expectedVersion, returns the new version", async () => {
    saveMock.mockResolvedValue({ purchaseDocumentId: "pd-1", version: 2 });
    const result = await savePurchaseDocumentDraft({ purchaseDocumentId: "pd-1", expectedVersion: 1, header: HEADER, lines: [] });
    expect(saveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purchaseDocumentId: "pd-1", appUserId: "user-1", expectedVersion: 1, header: HEADER, lines: [] })
    );
    expect(result).toEqual({ ok: true, version: 2 });
  });

  it("maps StaleVersionError to a friendly stale result", async () => {
    saveMock.mockRejectedValue(new StaleVersionError("stale"));
    const result = await savePurchaseDocumentDraft({ purchaseDocumentId: "pd-1", expectedVersion: 1, header: HEADER, lines: [] });
    expect(result).toMatchObject({ ok: false, reason: "stale" });
  });
});

describe("submitPurchaseDocumentForVerification", () => {
  it("returns the new status/version on success", async () => {
    submitMock.mockResolvedValue({ purchaseDocumentId: "pd-1", status: "READY_FOR_VERIFICATION", version: 2 });
    const result = await submitPurchaseDocumentForVerification("pd-1", 1);
    expect(result).toEqual({ ok: true, status: "READY_FOR_VERIFICATION", version: 2 });
  });
});

describe("verifyPurchaseDocument", () => {
  it("maps CannotSelfVerifyError to a friendly cannot_self_verify result, distinct from a stale-version failure", async () => {
    verifyMock.mockRejectedValue(new CannotSelfVerifyError("cannot self-verify"));
    const result = await verifyPurchaseDocument("pd-1", 2);
    expect(result).toEqual({ ok: false, reason: "cannot_self_verify", message: "Another manager must verify this document." });
  });

  it("returns verifiedAt on success", async () => {
    verifyMock.mockResolvedValue({ purchaseDocumentId: "pd-1", verifiedAt: "2026-08-12T00:00:00.000Z" });
    const result = await verifyPurchaseDocument("pd-1", 2);
    expect(result).toEqual({ ok: true, verifiedAt: "2026-08-12T00:00:00.000Z" });
  });
});

describe("returnPurchaseDocumentToDraft", () => {
  it("forwards an optional reason", async () => {
    returnMock.mockResolvedValue({ purchaseDocumentId: "pd-1", status: "DRAFT", version: 3 });
    await returnPurchaseDocumentToDraft("pd-1", 2, "Wrong vendor");
    expect(returnMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "Wrong vendor" }));
  });
});
