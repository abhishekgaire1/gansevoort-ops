import { beforeAll, describe, expect, it } from "vitest";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { initiateAmendmentRpc } from "@/app/lib/purchaseDocuments/initiateAmendmentRpc";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, confirmAllCurrentLinesNonInventory } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Proves the receipt-correction integrity guarantees from the 2A.3 plan
 * §3/§7 are enforced STRUCTURALLY (a real Postgres constraint violation),
 * not merely by an RPC-level check that a future caller could bypass:
 * - cross-document correction is rejected by the composite FK
 *   receipts_corrects_receipt_fk, not merely disallowed by convention
 * - self-correction is rejected by receipts_not_self_correction
 * - branching (a second correction targeting an already-corrected receipt)
 *   is rejected by the partial unique index receipts_org_corrects_key
 *
 * None of these first four are about item classification or document
 * lifecycle status -- they're the receipts table's OWN constraint
 * integrity -- so a plain DRAFT document is enough (and correct: a
 * correction can no longer be recorded against a VERIFIED document at
 * all, see 20260811100056, so building these specific fixtures against a
 * VERIFIED one would no longer even be possible).
 */

let fx: RpcTestFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

async function draftPurchaseDocumentForReceipts(): Promise<string> {
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
  });
  return purchaseDocumentId;
}

describe("receipt correction integrity", () => {
  it("rejects a cross-document correction at the composite-FK level, not merely an RPC check", async () => {
    const pd1 = await draftPurchaseDocumentForReceipts();
    const pd2 = await draftPurchaseDocumentForReceipts();

    const { data: receipt1, error: e1 } = await fx.supabase
      .from("receipts")
      .insert({ organization_id: fx.organizationId, purchase_document_id: pd1, receipt_kind: "DELIVERY", recorded_by_app_user_id: fx.changeableEmployeeAppUserId })
      .select("id")
      .single();
    expect(e1).toBeNull();

    // A raw insert attempting to attach a "correction" of receipt1 to a
    // DIFFERENT purchase_document (pd2) -- record_receipt itself can never
    // be tricked into this (it always derives purchase_document_id from
    // the corrected receipt), so this proves the DB-level backstop that
    // protects against any other write path.
    const { error: crossDocError } = await fx.supabase.from("receipts").insert({
      organization_id: fx.organizationId,
      purchase_document_id: pd2,
      receipt_kind: "CORRECTION",
      corrects_receipt_id: receipt1!.id,
      recorded_by_app_user_id: fx.changeableEmployeeAppUserId,
    });
    expect(crossDocError).not.toBeNull();
    expect(crossDocError!.code).toBe("23503");
  });

  it("rejects self-correction", async () => {
    const pd1 = await draftPurchaseDocumentForReceipts();
    const selfId = crypto.randomUUID();
    const { error } = await fx.supabase.from("receipts").insert({
      id: selfId,
      organization_id: fx.organizationId,
      purchase_document_id: pd1,
      receipt_kind: "CORRECTION",
      corrects_receipt_id: selfId,
      recorded_by_app_user_id: fx.changeableEmployeeAppUserId,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514"); // check constraint violation
  });

  it("a three-deep chain A <- B <- C succeeds via record_receipt", async () => {
    const pd1 = await draftPurchaseDocumentForReceipts();
    const a = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: pd1,
      lines: [],
    });
    const b = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "CORRECTION",
      correctsReceiptId: a.receiptId,
      lines: [],
    });
    const c = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "CORRECTION",
      correctsReceiptId: b.receiptId,
      lines: [],
    });
    expect(a.receiptId).toBeTruthy();
    expect(b.receiptId).toBeTruthy();
    expect(c.receiptId).toBeTruthy();

    const { data: effective } = await fx.supabase.rpc("effective_receipts_for_purchase_document", {
      p_purchase_document_id: pd1,
      p_organization_id: fx.organizationId,
    });
    const effectiveIds = (effective ?? []).map((r: { id: string }) => r.id);
    // Only C (the end of the chain) is effective -- A and B are superseded.
    expect(effectiveIds).toContain(c.receiptId);
    expect(effectiveIds).not.toContain(a.receiptId);
    expect(effectiveIds).not.toContain(b.receiptId);
  });

  it("a second branch off an already-corrected receipt is rejected by the partial unique index", async () => {
    const pd1 = await draftPurchaseDocumentForReceipts();
    const a = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: pd1,
      lines: [],
    });
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "CORRECTION",
      correctsReceiptId: a.receiptId,
      lines: [],
    });

    await expect(
      recordReceiptRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        receiptKind: "CORRECTION",
        correctsReceiptId: a.receiptId,
        lines: [],
      })
    ).rejects.toThrow();
  });

  it("an amendment never re-anchors an existing receipt's correction chain -- the old VERIFIED revision's receipt can no longer be corrected at all (20260811100056), and a genuinely new delivery correctly attaches to the new revision instead", async () => {
    const pd1 = await draftPurchaseDocumentForReceipts();
    const originalReceipt = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: pd1,
      lines: [],
    });

    // initiateAmendmentRpc requires the CURRENT revision to be VERIFIED --
    // this is the one test in this file that genuinely needs that status.
    await confirmAllCurrentLinesNonInventory(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, pd1);
    await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: pd1,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });
    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: pd1,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: 2,
    });

    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: pd1,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      reason: "test amendment for receipt-correction isolation",
    });
    const pd2 = amendment.purchaseDocumentId;
    expect(pd2).not.toBe(pd1);

    // pd1 is VERIFIED and stays that way regardless of the amendment --
    // its receipt can never be silently re-anchored OR corrected in
    // place; a correction attempt against it is rejected outright.
    await expect(
      recordReceiptRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        receiptKind: "CORRECTION",
        correctsReceiptId: originalReceipt.receiptId,
        lines: [],
      })
    ).rejects.toThrow(/VERIFIED/);

    // A genuinely new, unrelated delivery recorded against the new
    // (DRAFT) revision correctly attaches there instead.
    const newDelivery = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: pd2,
      lines: [],
    });
    const { data: newDeliveryRow } = await fx.supabase.from("receipts").select("purchase_document_id").eq("id", newDelivery.receiptId).single();
    expect(newDeliveryRow!.purchase_document_id).toBe(pd2);

    // The original receipt itself is, of course, still exactly where it
    // always was -- pd1, untouched.
    const { data: originalRow } = await fx.supabase.from("receipts").select("purchase_document_id").eq("id", originalReceipt.receiptId).single();
    expect(originalRow!.purchase_document_id).toBe(pd1);
  });
});
