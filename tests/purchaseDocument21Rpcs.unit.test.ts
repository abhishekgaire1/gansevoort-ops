import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CannotSelfVerifyError, StaleVersionError } from "@/app/lib/purchaseDocuments/errors";
import { saveReviewCorrectionsRpc } from "@/app/lib/purchaseDocuments/saveReviewCorrectionsRpc";
import { initiateAmendmentRpc } from "@/app/lib/purchaseDocuments/initiateAmendmentRpc";

// CI-safe: no network, no database -- fakes supabase.rpc() directly, same
// spirit as tests/purchaseDocumentRpcs.unit.test.ts.

function fakeSupabase(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const header = {
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
const lines = [
  {
    lineKey: "line-1",
    vendorSku: "SKU-1",
    description: "Item",
    packageQuantity: 1,
    packageUnit: "CS",
    measuredQuantity: null,
    measuredUnit: null,
    unitPrice: 100,
    priceBasisUnit: "CS",
    lineTotal: 100,
    rawLineText: null,
  },
];

describe("saveReviewCorrectionsRpc", () => {
  it("calls save_purchase_document_review_corrections with snake_case params, including lineKey per line", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_purchase_document_id: "pd-1", out_version: 3 }], error: null });

    const result = await saveReviewCorrectionsRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "reviewer-1",
      expectedVersion: 2,
      header,
      lines,
    });

    expect(rpc).toHaveBeenCalledWith("save_purchase_document_review_corrections", {
      p_purchase_document_id: "pd-1",
      p_organization_id: "org-1",
      p_app_user_id: "reviewer-1",
      p_expected_version: 2,
      p_header: header,
      p_lines: lines,
    });
    expect(result).toEqual({ purchaseDocumentId: "pd-1", version: 3 });
  });

  it("throws CannotSelfVerifyError for GA004 (reviewer is the preparer)", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA004", message: "cannot review-correct" } });
    await expect(
      saveReviewCorrectionsRpc(client, { purchaseDocumentId: "pd-1", organizationId: "org-1", appUserId: "preparer-1", expectedVersion: 2, header, lines })
    ).rejects.toBeInstanceOf(CannotSelfVerifyError);
  });

  it("throws StaleVersionError for GA002 (not READY_FOR_VERIFICATION, or stale version)", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA002", message: "stale" } });
    await expect(
      saveReviewCorrectionsRpc(client, { purchaseDocumentId: "pd-1", organizationId: "org-1", appUserId: "reviewer-1", expectedVersion: 2, header, lines })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });
});

describe("initiateAmendmentRpc", () => {
  it("calls initiate_purchase_document_amendment and maps the out_-prefixed row", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_purchase_document_id: "pd-2", out_revision_number: 2 }], error: null });

    const result = await initiateAmendmentRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "manager-1",
      reason: "Total transcribed incorrectly",
    });

    expect(rpc).toHaveBeenCalledWith("initiate_purchase_document_amendment", {
      p_purchase_document_id: "pd-1",
      p_organization_id: "org-1",
      p_app_user_id: "manager-1",
      p_reason: "Total transcribed incorrectly",
    });
    expect(result).toEqual({ purchaseDocumentId: "pd-2", revisionNumber: 2 });
  });

  it("throws StaleVersionError for GA002 (not verified, or not the current revision)", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA002", message: "not verified" } });
    await expect(
      initiateAmendmentRpc(client, { purchaseDocumentId: "pd-1", organizationId: "org-1", appUserId: "manager-1", reason: "test" })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });
});
