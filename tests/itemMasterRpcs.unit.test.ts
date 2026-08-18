import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mapItemMasterRpcError,
  SpendCategoryCycleError,
  EmployeeNotFoundOrInactiveError,
  ItemNotPendingReviewError,
  ItemProposalReferencedError,
  LineNotFoundInCurrentRevisionError,
  ReceiptNotFoundOrInvalidError,
} from "@/app/lib/itemMaster/errors";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { bulkConfirmLineClassificationsRpc } from "@/app/lib/itemMaster/bulkConfirmLineClassificationsRpc";
import { rejectItemProposalRpc } from "@/app/lib/itemMaster/rejectItemProposalRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { tryClaimClassificationRunRpc, finishClassificationRunRpc } from "@/app/lib/itemMaster/classificationRunClaimRpc";
import { resolveLineClassificationDeterministicRpc } from "@/app/lib/itemMaster/resolveLineClassificationDeterministicRpc";
import { recordAiSuggestedCandidateRpc } from "@/app/lib/itemMaster/recordAiSuggestedCandidateRpc";
import { recordAiItemProposalRpc } from "@/app/lib/itemMaster/recordAiItemProposalRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";

// CI-safe: no network, no database -- fakes supabase.rpc() directly, same
// spirit as tests/purchaseDocumentRpcs.unit.test.ts.

function fakeSupabase(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("mapItemMasterRpcError", () => {
  it("maps every app-defined SQLSTATE to its specific error class", () => {
    expect(mapItemMasterRpcError({ code: "GA007", message: "m" })).toBeInstanceOf(SpendCategoryCycleError);
    expect(mapItemMasterRpcError({ code: "GA008", message: "m" })).toBeInstanceOf(EmployeeNotFoundOrInactiveError);
    expect(mapItemMasterRpcError({ code: "GA009", message: "m" })).toBeInstanceOf(ItemNotPendingReviewError);
    expect(mapItemMasterRpcError({ code: "GA010", message: "m" })).toBeInstanceOf(ItemProposalReferencedError);
    expect(mapItemMasterRpcError({ code: "GA011", message: "m" })).toBeInstanceOf(LineNotFoundInCurrentRevisionError);
    expect(mapItemMasterRpcError({ code: "GA012", message: "m" })).toBeInstanceOf(ReceiptNotFoundOrInvalidError);
  });

  it("falls back to a generic Error for an unmapped code", () => {
    const err = mapItemMasterRpcError({ code: "23505", message: "boom" });
    expect(err).not.toBeInstanceOf(SpendCategoryCycleError);
    expect(err.message).toBe("boom");
  });
});

describe("approveLineClassificationNewItemRpc", () => {
  it("calls approve_line_classification_new_item with snake_case params and defaults", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_inventory_item_id: "item-1", out_classification_id: "class-1" }], error: null });

    const result = await approveLineClassificationNewItemRpc(client, {
      purchaseDocumentId: "pd-1",
      lineKey: "line-1",
      organizationId: "org-1",
      appUserId: "user-1",
      finalName: "Chicken Thigh",
      disposition: "INVENTORY",
      categoryId: "cat-1",
      spendCategoryId: "spend-1",
      baseUnitCode: "LB",
    });

    expect(rpc).toHaveBeenCalledWith("approve_line_classification_new_item", {
      p_purchase_document_id: "pd-1",
      p_line_key: "line-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_final_name: "Chicken Thigh",
      p_disposition: "INVENTORY",
      p_category_id: "cat-1",
      p_spend_category_id: "spend-1",
      p_base_unit_code: "LB",
      p_pending_item_id: null,
      p_remember_vendor_mapping: true,
      p_purchase_unit_code: null,
      p_receiving_behavior: null,
      p_fixed_conversion_factor: null,
    });
    expect(result).toEqual({ inventoryItemId: "item-1", classificationId: "class-1" });
  });

  it("throws LineNotFoundInCurrentRevisionError for GA011", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA011", message: "not found" } });
    await expect(
      approveLineClassificationNewItemRpc(client, {
        purchaseDocumentId: "pd-1",
        lineKey: "line-1",
        organizationId: "org-1",
        appUserId: "user-1",
        finalName: "x",
        disposition: "INVENTORY",
        categoryId: null,
        spendCategoryId: null,
        baseUnitCode: "LB",
      })
    ).rejects.toBeInstanceOf(LineNotFoundInCurrentRevisionError);
  });
});

describe("approveLineClassificationExistingItemRpc", () => {
  it("calls approve_line_classification_existing_item and maps the result", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_classification_id: "class-1" }], error: null });
    const result = await approveLineClassificationExistingItemRpc(client, {
      purchaseDocumentId: "pd-1",
      lineKey: "line-1",
      organizationId: "org-1",
      appUserId: "user-1",
      inventoryItemId: "item-1",
    });
    expect(rpc).toHaveBeenCalledWith("approve_line_classification_existing_item", {
      p_purchase_document_id: "pd-1",
      p_line_key: "line-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_inventory_item_id: "item-1",
      p_remember_vendor_mapping: true,
    });
    expect(result).toEqual({ classificationId: "class-1" });
  });

  it("throws ItemNotPendingReviewError for GA009", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA009", message: "not confirmed" } });
    await expect(
      approveLineClassificationExistingItemRpc(client, {
        purchaseDocumentId: "pd-1",
        lineKey: "line-1",
        organizationId: "org-1",
        appUserId: "user-1",
        inventoryItemId: "item-1",
      })
    ).rejects.toBeInstanceOf(ItemNotPendingReviewError);
  });
});

describe("bulkConfirmLineClassificationsRpc", () => {
  it("returns the confirmed ids", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_classification_id: "c1" }, { out_classification_id: "c2" }], error: null });
    const result = await bulkConfirmLineClassificationsRpc(client, { classificationIds: ["c1", "c2", "c3"], organizationId: "org-1", appUserId: "user-1" });
    expect(rpc).toHaveBeenCalledWith("bulk_confirm_line_classifications", {
      p_classification_ids: ["c1", "c2", "c3"],
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
    });
    expect(result).toEqual(["c1", "c2"]);
  });

  it("returns an empty array when nothing was eligible", async () => {
    const { client } = fakeSupabase({ data: [], error: null });
    const result = await bulkConfirmLineClassificationsRpc(client, { classificationIds: [], organizationId: "org-1", appUserId: "user-1" });
    expect(result).toEqual([]);
  });
});

describe("rejectItemProposalRpc", () => {
  it("calls reject_item_proposal with the reason", async () => {
    const { client, rpc } = fakeSupabase({ data: null, error: null });
    await rejectItemProposalRpc(client, { inventoryItemId: "item-1", organizationId: "org-1", appUserId: "user-1", reason: "duplicate" });
    expect(rpc).toHaveBeenCalledWith("reject_item_proposal", {
      p_inventory_item_id: "item-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_reason: "duplicate",
    });
  });

  it("throws ItemProposalReferencedError for GA010", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA010", message: "referenced" } });
    await expect(rejectItemProposalRpc(client, { inventoryItemId: "item-1", organizationId: "org-1", appUserId: "user-1" })).rejects.toBeInstanceOf(
      ItemProposalReferencedError
    );
  });
});

describe("correctDocumentDeliveryVerifierRpc", () => {
  it("calls correct_document_delivery_verifier with snake_case params", async () => {
    const { client, rpc } = fakeSupabase({ data: null, error: null });
    await correctDocumentDeliveryVerifierRpc(client, {
      documentId: "doc-1",
      organizationId: "org-1",
      appUserId: "user-1",
      newEmployeeId: "emp-1",
      reason: "wrong person selected",
    });
    expect(rpc).toHaveBeenCalledWith("correct_document_delivery_verifier", {
      p_document_id: "doc-1",
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_new_employee_id: "emp-1",
      p_reason: "wrong person selected",
    });
  });

  it("throws EmployeeNotFoundOrInactiveError for GA008", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA008", message: "inactive" } });
    await expect(
      correctDocumentDeliveryVerifierRpc(client, { documentId: "doc-1", organizationId: "org-1", appUserId: "user-1", newEmployeeId: "emp-1" })
    ).rejects.toBeInstanceOf(EmployeeNotFoundOrInactiveError);
  });
});

describe("classificationRunClaimRpc", () => {
  it("tryClaimClassificationRunRpc defaults staleAfterSeconds to 300 and maps the result", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_claim_id: "claim-1", out_status: "CLAIMED" }], error: null });
    const result = await tryClaimClassificationRunRpc(client, { purchaseDocumentId: "pd-1", organizationId: "org-1" });
    expect(rpc).toHaveBeenCalledWith("try_claim_purchase_document_classification_run", {
      p_purchase_document_id: "pd-1",
      p_organization_id: "org-1",
      p_stale_after_seconds: 300,
    });
    expect(result).toEqual({ claimId: "claim-1", status: "CLAIMED" });
  });

  it("finishClassificationRunRpc calls finish_purchase_document_classification_run", async () => {
    const { client, rpc } = fakeSupabase({ data: null, error: null });
    await finishClassificationRunRpc(client, { claimId: "claim-1", organizationId: "org-1", outcome: "SUCCEEDED" });
    expect(rpc).toHaveBeenCalledWith("finish_purchase_document_classification_run", {
      p_claim_id: "claim-1",
      p_organization_id: "org-1",
      p_outcome: "SUCCEEDED",
    });
  });
});

describe("resolveLineClassificationDeterministicRpc", () => {
  it("calls resolve_line_classification_deterministic with snake_case params", async () => {
    const { client, rpc } = fakeSupabase({ data: null, error: null });
    await resolveLineClassificationDeterministicRpc(client, {
      organizationId: "org-1",
      purchaseDocumentId: "pd-1",
      lineKey: "line-1",
      inventoryItemId: "item-1",
      resolutionSource: "VENDOR_SKU_MAPPING",
    });
    expect(rpc).toHaveBeenCalledWith("resolve_line_classification_deterministic", {
      p_organization_id: "org-1",
      p_purchase_document_id: "pd-1",
      p_line_key: "line-1",
      p_inventory_item_id: "item-1",
      p_resolution_source: "VENDOR_SKU_MAPPING",
    });
  });
});

describe("recordAiSuggestedCandidateRpc", () => {
  it("calls record_ai_suggested_candidate with snake_case params", async () => {
    const { client, rpc } = fakeSupabase({ data: null, error: null });
    await recordAiSuggestedCandidateRpc(client, {
      organizationId: "org-1",
      purchaseDocumentId: "pd-1",
      lineKey: "line-1",
      candidateInventoryItemId: "item-1",
      aiConfidence: 0.9,
    });
    expect(rpc).toHaveBeenCalledWith("record_ai_suggested_candidate", {
      p_organization_id: "org-1",
      p_purchase_document_id: "pd-1",
      p_line_key: "line-1",
      p_candidate_inventory_item_id: "item-1",
      p_ai_confidence: 0.9,
    });
  });
});

describe("recordAiItemProposalRpc", () => {
  it("calls record_ai_item_proposal and returns the created item id", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_inventory_item_id: "item-1", out_classification_id: "class-1" }], error: null });
    const result = await recordAiItemProposalRpc(client, {
      organizationId: "org-1",
      purchaseDocumentId: "pd-1",
      lineKey: "line-1",
      proposedName: "New Item",
      proposedDisposition: "INVENTORY",
      proposedCategoryId: "cat-1",
      proposedSpendCategoryId: "spend-1",
      proposedBaseUnitCode: "LB",
      aiConfidence: 0.6,
    });
    expect(rpc).toHaveBeenCalledWith("record_ai_item_proposal", {
      p_organization_id: "org-1",
      p_purchase_document_id: "pd-1",
      p_line_key: "line-1",
      p_proposed_name: "New Item",
      p_proposed_disposition: "INVENTORY",
      p_proposed_category_id: "cat-1",
      p_proposed_spend_category_id: "spend-1",
      p_proposed_base_unit_code: "LB",
      p_ai_confidence: 0.6,
      p_proposed_vendor_purchase_unit_code: null,
      p_proposed_receiving_behavior: null,
      p_proposed_fixed_conversion_factor: null,
    });
    expect(result).toEqual({ inventoryItemId: "item-1" });
  });
});

describe("recordReceiptRpc", () => {
  it("calls record_receipt with snake_case params and null defaults", async () => {
    const { client, rpc } = fakeSupabase({ data: [{ out_receipt_id: "receipt-1" }], error: null });
    const result = await recordReceiptRpc(client, {
      organizationId: "org-1",
      appUserId: "user-1",
      receiptKind: "DELIVERY",
      purchaseDocumentId: "pd-1",
      lines: [],
    });
    expect(rpc).toHaveBeenCalledWith("record_receipt", {
      p_organization_id: "org-1",
      p_app_user_id: "user-1",
      p_receipt_kind: "DELIVERY",
      p_purchase_document_id: "pd-1",
      p_corrects_receipt_id: null,
      p_default_location_id: null,
      p_notes: null,
      p_lines: [],
      p_idempotency_key: null,
    });
    expect(result).toEqual({ receiptId: "receipt-1" });
  });

  it("throws ReceiptNotFoundOrInvalidError for GA012", async () => {
    const { client } = fakeSupabase({ data: null, error: { code: "GA012", message: "not found" } });
    await expect(
      recordReceiptRpc(client, { organizationId: "org-1", appUserId: "user-1", receiptKind: "CORRECTION", correctsReceiptId: "receipt-1", lines: [] })
    ).rejects.toBeInstanceOf(ReceiptNotFoundOrInvalidError);
  });
});
