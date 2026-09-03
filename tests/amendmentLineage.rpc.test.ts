import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { getLineKeys, createDraftPurchaseDocumentWithLines } from "./itemMasterTestHelpers";
import { initiateAmendmentRpc } from "@/app/lib/purchaseDocuments/initiateAmendmentRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { findPossibleDuplicatePurchaseDocuments } from "@/app/lib/purchaseDocuments/duplicateDetection";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Fix for two confirmed UAT defects on a reopened (amended) verified
 * invoice: (1) the reopened document's own prior VERIFIED revision
 * reappeared as a "possible duplicate" of itself, and (2) an amendment
 * must never let the same physical delivery double-post into inventory.
 */

let fx: RpcTestFixtures;
let locationId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
});

/** Sums posted_base_quantity directly from purchase_document_inventory_
 * posting_lines for one item -- filtered to an exact, brand-new-per-test
 * inventory_item_id, so unlike inventory_location_balances (an org-wide
 * RPC capped at PostgREST's default 1000-row page on this long-lived
 * shared fixture org) this is never affected by how much unrelated data
 * has accumulated in the org. */
async function totalPostedQuantity(inventoryItemId: string): Promise<number> {
  const { data } = await fx.supabase
    .from("purchase_document_inventory_posting_lines")
    .select("posted_base_quantity")
    .eq("organization_id", fx.organizationId)
    .eq("inventory_item_id", inventoryItemId);
  return (data ?? []).reduce((sum, row) => sum + Number(row.posted_base_quantity), 0);
}

describe("duplicate detection excludes a document's own amendment lineage", () => {
  it("the current document is never flagged as a duplicate of its own prior revision, parent revisions in the same lineage are excluded, but a genuinely separate upload is still flagged", async () => {
    const runTag = randomUUID().slice(0, 8);
    const documentNumber = `AMEND-${runTag}`;

    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: `Amendment Lineage Test ${runTag}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 10, receivedUnit: "PIECE" } },
    ]);
    await fx.supabase.from("purchase_documents").update({ document_number: documentNumber }).eq("id", verified.purchaseDocumentId);

    const { data: original } = await fx.supabase.from("purchase_documents").select("revision_group_id, vendor_id, document_type").eq("id", verified.purchaseDocumentId).single();

    // Test 2 + 3: querying duplicates from the ORIGINAL's own perspective
    // excludes itself; from the reopened AMENDMENT's perspective, the
    // parent/prior-revision (this original) is also excluded -- same
    // revision_group_id, never flagged as a duplicate of itself.
    const duplicatesForOriginal = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: original!.vendor_id as string,
      documentType: original!.document_type as "INVOICE",
      documentNumber,
      excludeRevisionGroupId: original!.revision_group_id as string,
    });
    expect(duplicatesForOriginal).toHaveLength(0);

    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      reason: "UAT: correcting a header detail",
    });

    const duplicatesForAmendment = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: original!.vendor_id as string,
      documentType: original!.document_type as "INVOICE",
      documentNumber,
      excludeRevisionGroupId: original!.revision_group_id as string,
    });
    expect(duplicatesForAmendment).toHaveLength(0);

    // Test 4: a genuinely SEPARATE upload with the same vendor + document
    // number (a different revision_group_id entirely) must still be
    // flagged -- duplicate protection is never globally disabled.
    const { purchaseDocumentId: separateUploadId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: original!.vendor_id as string,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "SEP", description: "Genuinely separate upload", packageUnit: "PIECE" }],
    });
    const { error: setNumberError } = await fx.supabase.from("purchase_documents").update({ document_number: documentNumber }).eq("id", separateUploadId);
    expect(setNumberError).toBeNull();

    const duplicatesAfterSeparateUpload = await findPossibleDuplicatePurchaseDocuments(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: original!.vendor_id as string,
      documentType: original!.document_type as "INVOICE",
      documentNumber,
      excludeRevisionGroupId: original!.revision_group_id as string,
    });
    expect(duplicatesAfterSeparateUpload.some((d) => d.purchaseDocumentId === separateUploadId)).toBe(true);
    // The original and amendment (same lineage) never appear.
    expect(duplicatesAfterSeparateUpload.some((d) => d.purchaseDocumentId === verified.purchaseDocumentId)).toBe(false);
    expect(duplicatesAfterSeparateUpload.some((d) => d.purchaseDocumentId === amendment.purchaseDocumentId)).toBe(false);
  });
});

describe("amendment state and audit trail", () => {
  it("test 5: the reopened revision's amendment state (revision number, previous revision, reason) is a persisted DB fact, not client-only state -- it survives a fresh re-read exactly like a page refresh would see", async () => {
    const runTag = randomUUID().slice(0, 8);
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: `Amendment Persistence Test ${runTag}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 5, receivedUnit: "PIECE" } },
    ]);
    const reason = `UAT reopen reason ${runTag}`;
    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      reason,
    });

    // Simulates a fresh page load / navigation -- a brand-new read, no
    // reliance on any client-side state carried over from initiation.
    const { data: reread } = await fx.supabase
      .from("purchase_documents")
      .select("revision_number, previous_revision_id, amendment_reason, revision_group_id, status")
      .eq("id", amendment.purchaseDocumentId)
      .single();
    expect(reread!.revision_number).toBe(2);
    expect(reread!.previous_revision_id).toBe(verified.purchaseDocumentId);
    expect(reread!.amendment_reason).toBe(reason);
    expect(reread!.status).toBe("DRAFT");
  });

  it("test 7: initiating an amendment writes an audit trail of who reopened it, when, and why", async () => {
    const runTag = randomUUID().slice(0, 8);
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: `Amendment Audit Test ${runTag}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 5, receivedUnit: "PIECE" } },
    ]);
    const reason = `UAT audit reason ${runTag}`;
    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      reason,
    });

    const { data: event } = await fx.supabase
      .from("audit_events")
      .select("actor_app_user_id, occurred_at, action, after_state")
      .eq("organization_id", fx.organizationId)
      .eq("entity_type", "purchase_document")
      .eq("entity_id", amendment.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_AMENDMENT_INITIATED")
      .single();
    expect(event).not.toBeNull();
    expect(event!.actor_app_user_id).toBe(fx.changeableEmployeeAppUserId);
    expect(event!.occurred_at).toBeTruthy();
    expect((event!.after_state as { reason: string }).reason).toBe(reason);
    expect((event!.after_state as { previousRevisionId: string }).previousRevisionId).toBe(verified.purchaseDocumentId);
  });
});

describe("amendment posting safety", () => {
  it("test 6: re-receiving and posting the SAME physical delivery on an amendment does not double-count inventory already posted by the original revision", async () => {
    const runTag = randomUUID().slice(0, 8);
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: `Amendment Double-Post Test ${runTag}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 10, receivedUnit: "PIECE" } },
    ]);
    await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: verified.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    const itemId = verified.itemIds[0]!;
    expect(await totalPostedQuantity(itemId)).toBe(10);

    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      reason: "UAT: re-confirming the same delivery",
    });
    const [amendedLineKey] = await getLineKeys(fx.supabase, amendment.purchaseDocumentId);

    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      lineKey: amendedLineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: itemId,
      rememberVendorMapping: false,
    });

    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: amendment.purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: amendedLineKey,
          vendorSkuSnapshot: `AMEND-${runTag}`,
          descriptionSnapshot: "same physical delivery",
          invoicePackageQuantity: 10,
          invoicePackageUnit: "PIECE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 10,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });
    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });
    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId: amendment.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: submitted.version,
    });

    let caught: unknown;
    try {
      await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: amendment.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    } catch (err) {
      caught = err;
    }

    // The critical safety assertion: regardless of whether the amendment's
    // post attempt succeeded or was rejected, the SAME physical delivery
    // must never be counted twice.
    expect(await totalPostedQuantity(itemId)).toBe(10);
    // And it must actually have been rejected (never silently a no-op
    // succeeding with zero lines) -- confirms the new guard fired, not
    // just that nothing happened to post.
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toMatch(/already posted inventory/i);
  });
});
