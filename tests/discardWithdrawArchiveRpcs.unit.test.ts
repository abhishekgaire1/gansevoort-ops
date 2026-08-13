import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NotPreparerError, StaleVersionError } from "@/app/lib/purchaseDocuments/errors";
import { discardPurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/discardPurchaseDocumentDraftRpc";
import { withdrawPurchaseDocumentSubmissionRpc } from "@/app/lib/purchaseDocuments/withdrawPurchaseDocumentSubmissionRpc";
import { archiveDocumentRpc } from "@/app/lib/documents/archiveDocumentRpc";

// CI-safe: no network, no database -- fakes supabase.rpc() directly, same
// spirit as tests/purchaseDocument21Rpcs.unit.test.ts.

function fakeSupabase(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("discardPurchaseDocumentDraftRpc", () => {
  it("calls discard_purchase_document_draft with snake_case params, defaulting reason to null", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_purchase_document_id: "pd-1", out_status: "DISCARDED", out_version: 2 }], error: null });

    const result = await discardPurchaseDocumentDraftRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-1",
      expectedVersion: 1,
    });

    expect(rpc).toHaveBeenCalledWith("discard_purchase_document_draft", {
      p_purchase_document_id: "pd-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_expected_version: 1,
      p_reason: null,
    });
    expect(result).toEqual({ purchaseDocumentId: "pd-1", status: "DISCARDED", version: 2 });
  });

  it("forwards a reason when given", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_purchase_document_id: "pd-1", out_status: "DISCARDED", out_version: 2 }], error: null });
    await discardPurchaseDocumentDraftRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-1",
      expectedVersion: 1,
      reason: "Uploaded the wrong file",
    });
    expect(rpc).toHaveBeenCalledWith("discard_purchase_document_draft", expect.objectContaining({ p_reason: "Uploaded the wrong file" }));
  });

  it("throws NotPreparerError for GA006, StaleVersionError for GA002", async () => {
    const { client: notPreparerClient } = fakeSupabase({ data: null, error: { code: "GA006", message: "not the preparer" } });
    await expect(
      discardPurchaseDocumentDraftRpc(notPreparerClient, { purchaseDocumentId: "pd-1", organizationId: "org-1", appUserId: "user-2", expectedVersion: 1 })
    ).rejects.toBeInstanceOf(NotPreparerError);

    const { client: staleClient } = fakeSupabase({ data: null, error: { code: "GA002", message: "not a draft" } });
    await expect(
      discardPurchaseDocumentDraftRpc(staleClient, { purchaseDocumentId: "pd-1", organizationId: "org-1", appUserId: "user-1", expectedVersion: 1 })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });
});

describe("withdrawPurchaseDocumentSubmissionRpc", () => {
  it("calls withdraw_purchase_document_submission with snake_case params", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_purchase_document_id: "pd-1", out_status: "DRAFT", out_version: 4 }], error: null });

    const result = await withdrawPurchaseDocumentSubmissionRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-1",
      expectedVersion: 3,
      reason: "need to fix a typo",
    });

    expect(rpc).toHaveBeenCalledWith("withdraw_purchase_document_submission", {
      p_purchase_document_id: "pd-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_expected_version: 3,
      p_reason: "need to fix a typo",
    });
    expect(result).toEqual({ purchaseDocumentId: "pd-1", status: "DRAFT", version: 4 });
  });

  it("throws NotPreparerError for GA006 (only the preparer may withdraw their own submission)", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA006", message: "not the preparer" } });
    await expect(
      withdrawPurchaseDocumentSubmissionRpc(client, { purchaseDocumentId: "pd-1", organizationId: "org-1", appUserId: "user-2", expectedVersion: 3 })
    ).rejects.toBeInstanceOf(NotPreparerError);
  });
});

describe("archiveDocumentRpc", () => {
  it("calls archive_document with snake_case params, defaulting reason to null", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_document_id: "doc-1", out_archived_at: "2026-08-13T00:00:00.000Z" }], error: null });

    const result = await archiveDocumentRpc(client, { documentId: "doc-1", organizationId: "org-1", appUserId: "user-1" });

    expect(rpc).toHaveBeenCalledWith("archive_document", {
      p_document_id: "doc-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_reason: null,
    });
    expect(result).toEqual({ documentId: "doc-1", archivedAt: "2026-08-13T00:00:00.000Z" });
  });

  it("throws NotPreparerError for GA006 (only the uploader may archive), StaleVersionError for GA002 (backs an active workflow)", async () => {
    const { client: notUploaderClient } = fakeSupabase({ data: null, error: { code: "GA006", message: "did not upload" } });
    await expect(archiveDocumentRpc(notUploaderClient, { documentId: "doc-1", organizationId: "org-1", appUserId: "user-2" })).rejects.toBeInstanceOf(
      NotPreparerError
    );

    const { client: activeClient } = fakeSupabase({ data: null, error: { code: "GA002", message: "backs an active workflow" } });
    await expect(archiveDocumentRpc(activeClient, { documentId: "doc-1", organizationId: "org-1", appUserId: "user-1" })).rejects.toBeInstanceOf(
      StaleVersionError
    );
  });
});
