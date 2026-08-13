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
  saveReviewCorrectionsMock,
  initiateAmendmentMock,
  discardMock,
  withdrawMock,
} = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  saveMock: vi.fn(),
  submitMock: vi.fn(),
  verifyMock: vi.fn(),
  returnMock: vi.fn(),
  saveReviewCorrectionsMock: vi.fn(),
  initiateAmendmentMock: vi.fn(),
  discardMock: vi.fn(),
  withdrawMock: vi.fn(),
}));
vi.mock("@/app/lib/purchaseDocuments/initializePurchaseDocumentDraftRpc", () => ({ initializePurchaseDocumentDraftRpc: initializeMock }));
vi.mock("@/app/lib/purchaseDocuments/savePurchaseDocumentDraftRpc", () => ({ savePurchaseDocumentDraftRpc: saveMock }));
vi.mock("@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc", () => ({
  submitPurchaseDocumentForVerificationRpc: submitMock,
}));
vi.mock("@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc", () => ({ verifyPurchaseDocumentRpc: verifyMock }));
vi.mock("@/app/lib/purchaseDocuments/returnPurchaseDocumentToDraftRpc", () => ({ returnPurchaseDocumentToDraftRpc: returnMock }));
vi.mock("@/app/lib/purchaseDocuments/saveReviewCorrectionsRpc", () => ({ saveReviewCorrectionsRpc: saveReviewCorrectionsMock }));
vi.mock("@/app/lib/purchaseDocuments/initiateAmendmentRpc", () => ({ initiateAmendmentRpc: initiateAmendmentMock }));
vi.mock("@/app/lib/purchaseDocuments/discardPurchaseDocumentDraftRpc", () => ({ discardPurchaseDocumentDraftRpc: discardMock }));
vi.mock("@/app/lib/purchaseDocuments/withdrawPurchaseDocumentSubmissionRpc", () => ({ withdrawPurchaseDocumentSubmissionRpc: withdrawMock }));

import {
  createOrOpenPurchaseDocumentDraft,
  savePurchaseDocumentDraft,
  submitPurchaseDocumentForVerification,
  verifyPurchaseDocument,
  returnPurchaseDocumentToDraft,
  saveReviewCorrections,
  initiatePurchaseDocumentAmendment,
  discardPurchaseDocumentDraft,
  withdrawPurchaseDocumentSubmission,
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
  saveReviewCorrectionsMock.mockReset();
  initiateAmendmentMock.mockReset();
  discardMock.mockReset();
  withdrawMock.mockReset();
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

describe("saveReviewCorrections", () => {
  it("rejects unauthenticated callers before calling the RPC", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await saveReviewCorrections({ purchaseDocumentId: "pd-1", expectedVersion: 1, header: HEADER, lines: [] });
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(saveReviewCorrectionsMock).not.toHaveBeenCalled();
  });

  it("passes the resolved manager identity (never a client-supplied one) to the RPC", async () => {
    saveReviewCorrectionsMock.mockResolvedValue({ purchaseDocumentId: "pd-1", version: 5 });
    const result = await saveReviewCorrections({ purchaseDocumentId: "pd-1", expectedVersion: 4, header: HEADER, lines: [] });
    expect(saveReviewCorrectionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purchaseDocumentId: "pd-1", appUserId: "user-1", organizationId: "org-1", expectedVersion: 4 })
    );
    expect(result).toEqual({ ok: true, version: 5 });
  });

  it("maps CannotSelfVerifyError to a message specific to reviewing your own submission", async () => {
    saveReviewCorrectionsMock.mockRejectedValue(new CannotSelfVerifyError("cannot review-correct"));
    const result = await saveReviewCorrections({ purchaseDocumentId: "pd-1", expectedVersion: 1, header: HEADER, lines: [] });
    expect(result).toEqual({
      ok: false,
      reason: "cannot_self_verify",
      message: "You prepared this document and cannot review-correct your own submission.",
    });
  });
});

describe("initiatePurchaseDocumentAmendment", () => {
  it("rejects unauthenticated callers before calling the RPC", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await initiatePurchaseDocumentAmendment("pd-1", "Total transcribed incorrectly");
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(initiateAmendmentMock).not.toHaveBeenCalled();
  });

  it("passes the resolved manager identity and reason to the RPC", async () => {
    initiateAmendmentMock.mockResolvedValue({ purchaseDocumentId: "pd-2", revisionNumber: 2 });
    const result = await initiatePurchaseDocumentAmendment("pd-1", "Total transcribed incorrectly");
    expect(initiateAmendmentMock).toHaveBeenCalledWith(expect.anything(), {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-1",
      reason: "Total transcribed incorrectly",
    });
    expect(result).toEqual({ ok: true, purchaseDocumentId: "pd-2", revisionNumber: 2 });
  });

  it("surfaces a stale/not-current-revision failure", async () => {
    initiateAmendmentMock.mockRejectedValue(new StaleVersionError("not the current revision"));
    const result = await initiatePurchaseDocumentAmendment("pd-1", "reason");
    expect(result).toMatchObject({ ok: false, reason: "stale" });
  });
});

describe("discardPurchaseDocumentDraft", () => {
  it("rejects unauthenticated callers before calling the RPC", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await discardPurchaseDocumentDraft("pd-1", 1);
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(discardMock).not.toHaveBeenCalled();
  });

  it("passes the resolved manager identity, version, and an optional reason to the RPC", async () => {
    discardMock.mockResolvedValue({ purchaseDocumentId: "pd-1", status: "DISCARDED", version: 2 });
    const result = await discardPurchaseDocumentDraft("pd-1", 1, "Uploaded the wrong file");
    expect(discardMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purchaseDocumentId: "pd-1", appUserId: "user-1", expectedVersion: 1, reason: "Uploaded the wrong file" })
    );
    expect(result).toEqual({ ok: true, status: "DISCARDED", version: 2 });
  });

  it("maps NotPreparerError to a friendly not_preparer result", async () => {
    discardMock.mockRejectedValue(new NotPreparerError("not the preparer"));
    const result = await discardPurchaseDocumentDraft("pd-1", 1);
    expect(result).toMatchObject({ ok: false, reason: "not_preparer" });
  });
});

describe("withdrawPurchaseDocumentSubmission", () => {
  it("rejects unauthenticated callers before calling the RPC", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await withdrawPurchaseDocumentSubmission("pd-1", 2);
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(withdrawMock).not.toHaveBeenCalled();
  });

  it("passes the resolved manager identity, version, and an optional reason to the RPC", async () => {
    withdrawMock.mockResolvedValue({ purchaseDocumentId: "pd-1", status: "DRAFT", version: 3 });
    const result = await withdrawPurchaseDocumentSubmission("pd-1", 2, "need to fix a typo");
    expect(withdrawMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purchaseDocumentId: "pd-1", appUserId: "user-1", expectedVersion: 2, reason: "need to fix a typo" })
    );
    expect(result).toEqual({ ok: true, status: "DRAFT", version: 3 });
  });

  it("maps NotPreparerError to a friendly not_preparer result (only the preparer may withdraw their own submission)", async () => {
    withdrawMock.mockRejectedValue(new NotPreparerError("not the preparer"));
    const result = await withdrawPurchaseDocumentSubmission("pd-1", 2);
    expect(result).toMatchObject({ ok: false, reason: "not_preparer" });
  });
});
