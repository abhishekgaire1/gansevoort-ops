import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { archiveMock } = vi.hoisted(() => ({ archiveMock: vi.fn() }));
vi.mock("@/app/lib/documents/archiveDocumentRpc", () => ({ archiveDocumentRpc: archiveMock }));

import { archiveDocument } from "@/app/actions/documentArchive";
import { NotPreparerError, StaleVersionError } from "@/app/lib/purchaseDocuments/errors";

const MANAGER = {
  ok: true as const,
  manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] },
};

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  getServiceRoleClientMock.mockReset().mockReturnValue({});
  archiveMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("archiveDocument", () => {
  it("rejects unauthenticated callers before calling the RPC", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await archiveDocument("doc-1");
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(archiveMock).not.toHaveBeenCalled();
  });

  it("passes the resolved manager identity and an optional reason to the RPC", async () => {
    archiveMock.mockResolvedValue({ documentId: "doc-1", archivedAt: "2026-08-13T00:00:00.000Z" });
    const result = await archiveDocument("doc-1", "wrong file");
    expect(archiveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ documentId: "doc-1", organizationId: "org-1", appUserId: "user-1", reason: "wrong file" })
    );
    expect(result).toEqual({ ok: true, archivedAt: "2026-08-13T00:00:00.000Z" });
  });

  it("maps NotPreparerError to a not_uploader result", async () => {
    archiveMock.mockRejectedValue(new NotPreparerError("did not upload"));
    const result = await archiveDocument("doc-1");
    expect(result).toEqual({
      ok: false,
      reason: "not_uploader",
      message: "Only the manager who uploaded this document can remove it.",
    });
  });

  it("maps StaleVersionError (GA002 -- backs an active workflow, or already archived) to a not_archivable result", async () => {
    archiveMock.mockRejectedValue(new StaleVersionError("backs an active workflow"));
    const result = await archiveDocument("doc-1");
    expect(result).toEqual({
      ok: false,
      reason: "not_archivable",
      message: "This document backs an active purchase record and cannot be removed.",
    });
  });
});
