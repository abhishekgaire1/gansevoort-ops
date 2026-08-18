import { beforeAll, describe, expect, it } from "vitest";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { bulkConfirmLineClassificationsRpc } from "@/app/lib/itemMaster/bulkConfirmLineClassificationsRpc";
import { recordAiSuggestedCandidateRpc } from "@/app/lib/itemMaster/recordAiSuggestedCandidateRpc";
import { recordAiItemProposalRpc } from "@/app/lib/itemMaster/recordAiItemProposalRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { saveReviewCorrectionsRpc } from "@/app/lib/purchaseDocuments/saveReviewCorrectionsRpc";
import { NotPreparerError } from "@/app/lib/purchaseDocuments/errors";
import { DuplicateItemNameError } from "@/app/lib/itemMaster/errors";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Adversarial-review priorities 6 + 9 (20260811100060). Priority 6: only
 * a still-DRAFT document's own preparer may approve item classifications
 * on it -- READY_FOR_VERIFICATION/VERIFIED are already covered by
 * verifiedLock.rpc.test.ts (the lock trigger blocks everyone there
 * regardless of identity, confirmed separately). Priority 9: an exact
 * normalized-name duplicate against another ACTIVE, CONFIRMED Item Master
 * entry is rejected at approval time, surfacing the existing item so the
 * UI can offer "Use Existing Item" instead.
 */

let fx: RpcTestFixtures;
let spendCategoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
});

async function draftWithOneLine(description: string): Promise<{ purchaseDocumentId: string; lineKey: string }> {
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId, // the preparer
    lines: [{ vendorSku: `GUARD-${crypto.randomUUID().slice(0, 8)}`, description }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  return { purchaseDocumentId, lineKey };
}

describe("DRAFT preparer ownership on classification approval (priority 6)", () => {
  it("a non-preparer manager cannot approve a new item on someone else's still-open draft", async () => {
    const { purchaseDocumentId, lineKey } = await draftWithOneLine("Ownership New Item Line");
    const rejectedName = `TEST Should never be created by a non-preparer ${crypto.randomUUID().slice(0, 8)}`;

    await expect(
      approveLineClassificationNewItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId, // NOT the preparer
        finalName: rejectedName,
        disposition: "NON_INVENTORY",
        categoryId: null,
        spendCategoryId,
        baseUnitCode: null,
        rememberVendorMapping: false,
      })
    ).rejects.toThrow(NotPreparerError);

    const { data: items } = await fx.supabase.from("inventory_items").select("id").eq("organization_id", fx.organizationId).eq("name", rejectedName);
    expect(items).toHaveLength(0);
  });

  it("the document's own preparer can approve a new item on their own draft", async () => {
    const { purchaseDocumentId, lineKey } = await draftWithOneLine("Ownership Own Draft Line");

    await expect(
      approveLineClassificationNewItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId, // the actual preparer
        finalName: `TEST Ownership Own Draft ${purchaseDocumentId.slice(0, 8)}`,
        disposition: "NON_INVENTORY",
        categoryId: null,
        spendCategoryId,
        baseUnitCode: null,
        rememberVendorMapping: false,
      })
    ).resolves.toMatchObject({ inventoryItemId: expect.any(String) });
  });

  it("a non-preparer manager cannot approve an existing-item classification on someone else's draft", async () => {
    const { purchaseDocumentId, lineKey } = await draftWithOneLine("Ownership Existing Item Line");
    const existingItemId = await confirmedItemForExistingApproval();

    await expect(
      approveLineClassificationExistingItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId,
        inventoryItemId: existingItemId,
        rememberVendorMapping: false,
      })
    ).rejects.toThrow(NotPreparerError);
  });

  it("bulk_confirm_line_classifications silently skips a row belonging to someone else's draft, but confirms it once called by the real preparer", async () => {
    const { purchaseDocumentId, lineKey } = await draftWithOneLine("Ownership Bulk Confirm Line");
    const candidateItemId = await confirmedItemForExistingApproval();

    await recordAiSuggestedCandidateRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId,
      lineKey,
      candidateInventoryItemId: candidateItemId,
      aiConfidence: 0.95,
    });
    const { data: pendingRow } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("id")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey)
      .single();
    const classificationId = pendingRow!.id as string;

    const skippedResult = await bulkConfirmLineClassificationsRpc(fx.supabase, {
      classificationIds: [classificationId],
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId, // not the preparer
    });
    expect(skippedResult).toEqual([]); // silently skipped, not an error

    const { data: stillPending } = await fx.supabase.from("purchase_document_line_classifications").select("status").eq("id", classificationId).single();
    expect(stillPending!.status).toBe("PENDING_REVIEW");

    const confirmedResult = await bulkConfirmLineClassificationsRpc(fx.supabase, {
      classificationIds: [classificationId],
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId, // the real preparer
    });
    expect(confirmedResult).toEqual([classificationId]);
  });

  it("a classification row whose document is READY_FOR_VERIFICATION (locked, no trusted-write flag set here) is excluded from the batch outright -- it never aborts confirmation of an unrelated, fully eligible DRAFT row in the same call (fixes a real batch-rollback bug found by the second-pass adversarial review, see 20260811100063)", async () => {
    // A realistic way a PENDING_REVIEW/AI_SUGGESTED row ends up on a
    // READY_FOR_VERIFICATION document: a reviewer correction invalidates
    // an already-classified line (STALE), and the system reclassification
    // that follows resolves it to an AI-suggested candidate, not a
    // remembered deterministic match.
    const candidateItemId = await confirmedItemForExistingApproval();
    const uniqueSku = `BULK-LOCKED-${crypto.randomUUID().slice(0, 8)}`;
    const { purchaseDocumentId: lockedPd } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: uniqueSku, description: "Bulk Locked Original" }],
    });
    const [lockedLineKey] = await getLineKeys(fx.supabase, lockedPd);
    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId: lockedPd,
      lineKey: lockedLineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Bulk Locked Freight ${lockedPd.slice(0, 8)}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });
    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId: lockedPd,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });
    await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId: lockedPd,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: submitted.version,
      header: {
        vendorId: fx.vendorId,
        documentType: "INVOICE",
        documentNumber: `BULK-LOCKED-DOC-${lockedPd.slice(0, 8)}`,
        documentDate: "2026-08-12",
        poNumber: null,
        deliveryDate: null,
        subtotal: 100,
        tax: 0,
        fees: 0,
        total: 100,
        currency: "USD",
      },
      lines: [
        {
          lineKey: lockedLineKey,
          vendorSku: uniqueSku,
          description: "Bulk Locked Corrected", // invalidates the classification -> STALE
          packageQuantity: null,
          packageUnit: null,
          measuredQuantity: null,
          measuredUnit: null,
          unitPrice: null,
          priceBasisUnit: null,
          lineTotal: 100,
          rawLineText: null,
        },
      ],
    });
    await recordAiSuggestedCandidateRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId: lockedPd,
      lineKey: lockedLineKey,
      candidateInventoryItemId: candidateItemId,
      aiConfidence: 0.88,
    });
    const { data: lockedRow } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("id, status")
      .eq("purchase_document_id", lockedPd)
      .eq("line_key", lockedLineKey)
      .single();
    expect(lockedRow!.status).toBe("PENDING_REVIEW");
    const lockedClassificationId = lockedRow!.id as string;

    // A genuinely eligible row -- a different, still-DRAFT document owned
    // by the same caller.
    const { purchaseDocumentId: eligiblePd, lineKey: eligibleLineKey } = await draftWithOneLine("Bulk Eligible Line");
    await recordAiSuggestedCandidateRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId: eligiblePd,
      lineKey: eligibleLineKey,
      candidateInventoryItemId: candidateItemId,
      aiConfidence: 0.9,
    });
    const { data: eligibleRow } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("id")
      .eq("purchase_document_id", eligiblePd)
      .eq("line_key", eligibleLineKey)
      .single();
    const eligibleClassificationId = eligibleRow!.id as string;

    // One call, both ids -- must not throw, and must confirm ONLY the
    // eligible one.
    const result = await bulkConfirmLineClassificationsRpc(fx.supabase, {
      classificationIds: [lockedClassificationId, eligibleClassificationId],
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(result).toEqual([eligibleClassificationId]);

    const { data: eligibleAfter } = await fx.supabase.from("purchase_document_line_classifications").select("status").eq("id", eligibleClassificationId).single();
    expect(eligibleAfter!.status).toBe("CONFIRMED");

    const { data: lockedAfter } = await fx.supabase.from("purchase_document_line_classifications").select("status").eq("id", lockedClassificationId).single();
    expect(lockedAfter!.status).toBe("PENDING_REVIEW"); // untouched, never attempted
  });
});

describe("exact normalized duplicate Item Master name protection (priority 9)", () => {
  it("rejects approving a genuinely new item whose normalized name matches an existing active CONFIRMED item, surfacing that item's id", async () => {
    const uniqueBase = crypto.randomUUID().slice(0, 8);
    const { purchaseDocumentId: pd1, lineKey: line1 } = await draftWithOneLine("Duplicate Name Line 1");
    const existing = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId: pd1,
      lineKey: line1,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Organic Kale ${uniqueBase}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });

    const { purchaseDocumentId: pd2, lineKey: line2 } = await draftWithOneLine("Duplicate Name Line 2");
    let caught: unknown;
    try {
      await approveLineClassificationNewItemRpc(fx.supabase, {
        purchaseDocumentId: pd2,
        lineKey: line2,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        // Same name, different casing/whitespace -- an exact normalized
        // match, never a fuzzy one.
        finalName: `  test   organic   kale   ${uniqueBase}  `,
        disposition: "NON_INVENTORY",
        categoryId: null,
        spendCategoryId,
        baseUnitCode: null,
        rememberVendorMapping: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DuplicateItemNameError);
    expect((caught as DuplicateItemNameError).existingItemId).toBe(existing.inventoryItemId);

    const { data: items } = await fx.supabase
      .from("inventory_items")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .ilike("name", `%${uniqueBase}%`);
    expect(items).toHaveLength(1); // no second row was created
  });

  it("finalizing an AI-proposed pending item under its own proposed name is never treated as a duplicate of itself", async () => {
    const uniqueBase = crypto.randomUUID().slice(0, 8);
    const { purchaseDocumentId, lineKey } = await draftWithOneLine("Duplicate Self Line");
    const proposedName = `TEST Self Not Duplicate ${uniqueBase}`;

    const proposal = await recordAiItemProposalRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId,
      lineKey,
      proposedName,
      proposedDisposition: "NON_INVENTORY",
      proposedCategoryId: null,
      proposedSpendCategoryId: null,
      proposedBaseUnitCode: null,
      aiConfidence: 0.9,
    });

    await expect(
      approveLineClassificationNewItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        finalName: proposedName, // identical to the pending item's own current name
        disposition: "NON_INVENTORY",
        categoryId: null,
        spendCategoryId,
        baseUnitCode: null,
        pendingItemId: proposal.inventoryItemId,
        rememberVendorMapping: false,
      })
    ).resolves.toMatchObject({ inventoryItemId: proposal.inventoryItemId });
  });
});

async function confirmedItemForExistingApproval(): Promise<string> {
  const { purchaseDocumentId, lineKey } = await draftWithOneLine("Existing Item Candidate Line");
  const result = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Existing Item Candidate ${crypto.randomUUID().slice(0, 8)}`,
    disposition: "NON_INVENTORY",
    categoryId: null,
    spendCategoryId,
    baseUnitCode: null,
    rememberVendorMapping: false,
  });
  return result.inventoryItemId;
}
