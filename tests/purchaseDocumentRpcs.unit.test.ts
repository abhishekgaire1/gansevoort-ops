import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mapPurchaseDocumentRpcError,
  StaleVersionError,
  VerifiedLockedError,
  CannotSelfVerifyError,
  VendorNotActiveError,
  NotPreparerError,
} from "@/app/lib/purchaseDocuments/errors";
import { initializePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/initializePurchaseDocumentDraftRpc";
import { savePurchaseDocumentDraftRpc } from "@/app/lib/purchaseDocuments/savePurchaseDocumentDraftRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { returnPurchaseDocumentToDraftRpc } from "@/app/lib/purchaseDocuments/returnPurchaseDocumentToDraftRpc";

// CI-safe: no network, no database -- fakes supabase.rpc() directly, same
// spirit as tests/finalizeDocumentUploadRpc.unit.test.ts.

function fakeSupabase(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("mapPurchaseDocumentRpcError", () => {
  it("maps every app-defined SQLSTATE to its specific error class", () => {
    expect(mapPurchaseDocumentRpcError({ code: "GA002", message: "m" })).toBeInstanceOf(StaleVersionError);
    expect(mapPurchaseDocumentRpcError({ code: "GA003", message: "m" })).toBeInstanceOf(VerifiedLockedError);
    expect(mapPurchaseDocumentRpcError({ code: "GA004", message: "m" })).toBeInstanceOf(CannotSelfVerifyError);
    expect(mapPurchaseDocumentRpcError({ code: "GA005", message: "m" })).toBeInstanceOf(VendorNotActiveError);
    expect(mapPurchaseDocumentRpcError({ code: "GA006", message: "m" })).toBeInstanceOf(NotPreparerError);
  });

  it("falls back to a generic Error for an unmapped code", () => {
    const err = mapPurchaseDocumentRpcError({ code: "23505", message: "boom" });
    expect(err).not.toBeInstanceOf(StaleVersionError);
    expect(err.message).toBe("boom");
  });
});

describe("initializePurchaseDocumentDraftRpc", () => {
  it("calls initialize_purchase_document_draft with snake_case params and maps the out_-prefixed row", async () => {
    const { client, rpc } = fakeSupabase({
      data: [{ out_purchase_document_id: "pd-1", out_status: "DRAFT", out_created: true }],
      error: null,
    });

    const result = await initializePurchaseDocumentDraftRpc(client, { documentId: "doc-1", organizationId: "org-1", appUserId: "user-1" });

    expect(rpc).toHaveBeenCalledWith("initialize_purchase_document_draft", {
      p_document_id: "doc-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
    });
    expect(result).toEqual({ purchaseDocumentId: "pd-1", status: "DRAFT", created: true });
  });

  it("throws NotPreparerError for GA006", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA006", message: "not the uploader" } });
    await expect(
      initializePurchaseDocumentDraftRpc(client, { documentId: "doc-1", organizationId: "org-1", appUserId: "user-2" })
    ).rejects.toBeInstanceOf(NotPreparerError);
  });
});

describe("savePurchaseDocumentDraftRpc", () => {
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
      lineKey: null,
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

  it("passes the header/lines objects straight through as jsonb params (no manual re-mapping) and maps the result", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_purchase_document_id: "pd-1", out_version: 2 }], error: null });

    const result = await savePurchaseDocumentDraftRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-1",
      expectedVersion: 1,
      header,
      lines,
    });

    expect(rpc).toHaveBeenCalledWith("save_purchase_document_draft", {
      p_purchase_document_id: "pd-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_expected_version: 1,
      p_header: header,
      p_lines: lines,
    });
    expect(result).toEqual({ purchaseDocumentId: "pd-1", version: 2 });
  });

  it("throws StaleVersionError for GA002", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA002", message: "stale" } });
    await expect(
      savePurchaseDocumentDraftRpc(client, {
        purchaseDocumentId: "pd-1",
        organizationId: "org-1",
        appUserId: "user-1",
        expectedVersion: 1,
        header,
        lines,
      })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });
});

describe("submitPurchaseDocumentForVerificationRpc", () => {
  it("calls submit_purchase_document_for_verification and maps the result", async () => {
    const { client, rpc } = fakeSupabase({
      data: [{ out_purchase_document_id: "pd-1", out_status: "READY_FOR_VERIFICATION", out_version: 2 }],
      error: null,
    });

    const result = await submitPurchaseDocumentForVerificationRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-1",
      expectedVersion: 1,
    });

    expect(rpc).toHaveBeenCalledWith("submit_purchase_document_for_verification", {
      p_purchase_document_id: "pd-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_expected_version: 1,
      p_header: null,
      p_lines: null,
    });
    expect(result).toEqual({ purchaseDocumentId: "pd-1", status: "READY_FOR_VERIFICATION", version: 2 });
  });

  it("forwards header/lines when the caller supplies the current on-screen form state (atomic save-and-submit)", async () => {
    const { client, rpc } = fakeSupabase({
      data: [{ out_purchase_document_id: "pd-1", out_status: "READY_FOR_VERIFICATION", out_version: 2 }],
      error: null,
    });
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

    await submitPurchaseDocumentForVerificationRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-1",
      expectedVersion: 1,
      header,
      lines,
    });

    expect(rpc).toHaveBeenCalledWith(
      "submit_purchase_document_for_verification",
      expect.objectContaining({ p_header: header, p_lines: lines })
    );
  });
});

describe("verifyPurchaseDocumentRpc", () => {
  it("calls verify_purchase_document and maps the result", async () => {
    const { client, rpc } = fakeSupabase({
      data: [{ out_purchase_document_id: "pd-1", out_verified_at: "2026-08-12T00:00:00.000Z" }],
      error: null,
    });

    const result = await verifyPurchaseDocumentRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-2",
      expectedVersion: 2,
    });

    expect(rpc).toHaveBeenCalledWith("verify_purchase_document", {
      p_purchase_document_id: "pd-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-2",
      p_expected_version: 2,
      p_header: null,
      p_lines: null,
    });
    expect(result).toEqual({ purchaseDocumentId: "pd-1", verifiedAt: "2026-08-12T00:00:00.000Z" });
  });

  it("throws CannotSelfVerifyError for GA004", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA004", message: "cannot self-verify" } });
    await expect(
      verifyPurchaseDocumentRpc(client, { purchaseDocumentId: "pd-1", organizationId: "org-1", appUserId: "user-1", expectedVersion: 2 })
    ).rejects.toBeInstanceOf(CannotSelfVerifyError);
  });

  it("forwards header/lines when the caller supplies the reviewer's current on-screen form state (atomic save-and-verify)", async () => {
    const { client, rpc } = fakeSupabase({
      data: [{ out_purchase_document_id: "pd-1", out_verified_at: "2026-08-12T00:00:00.000Z" }],
      error: null,
    });
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
        description: "Corrected Item",
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

    await verifyPurchaseDocumentRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-2",
      expectedVersion: 2,
      header,
      lines,
    });

    expect(rpc).toHaveBeenCalledWith("verify_purchase_document", expect.objectContaining({ p_header: header, p_lines: lines }));
  });
});

describe("returnPurchaseDocumentToDraftRpc", () => {
  it("calls return_purchase_document_to_draft with a null reason when omitted", async () => {
    const { client, rpc } = fakeSupabase({
      data: [{ out_purchase_document_id: "pd-1", out_status: "DRAFT", out_version: 3 }],
      error: null,
    });

    const result = await returnPurchaseDocumentToDraftRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-2",
      expectedVersion: 2,
    });

    expect(rpc).toHaveBeenCalledWith("return_purchase_document_to_draft", {
      p_purchase_document_id: "pd-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-2",
      p_expected_version: 2,
      p_reason: null,
    });
    expect(result).toEqual({ purchaseDocumentId: "pd-1", status: "DRAFT", version: 3 });
  });

  it("passes an explicit reason through", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_purchase_document_id: "pd-1", out_status: "DRAFT", out_version: 3 }], error: null });

    await returnPurchaseDocumentToDraftRpc(client, {
      purchaseDocumentId: "pd-1",
      organizationId: "org-1",
      appUserId: "user-2",
      expectedVersion: 2,
      reason: "Wrong vendor selected",
    });

    expect(rpc).toHaveBeenCalledWith(
      "return_purchase_document_to_draft",
      expect.objectContaining({ p_reason: "Wrong vendor selected" })
    );
  });
});
