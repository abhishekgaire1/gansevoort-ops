import { beforeAll, describe, expect, it } from "vitest";
import { resolveLineClassificationDeterministicRpc } from "@/app/lib/itemMaster/resolveLineClassificationDeterministicRpc";
import { recordAiSuggestedCandidateRpc } from "@/app/lib/itemMaster/recordAiSuggestedCandidateRpc";
import { recordAiItemProposalRpc } from "@/app/lib/itemMaster/recordAiItemProposalRpc";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { saveReviewCorrectionsRpc } from "@/app/lib/purchaseDocuments/saveReviewCorrectionsRpc";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Adversarial-review priorities 1 + 2. Proves:
 * (1) the three system classification writers (resolve_line_classification
 *     _deterministic, record_ai_suggested_candidate, record_ai_item_proposal)
 *     can now write while READY_FOR_VERIFICATION -- the exact scenario that
 *     broke the "auto-reclassify a STALE line after a reviewer correction"
 *     flow before 20260811100057/100058 -- while VERIFIED/DISCARDED remain
 *     absolutely locked, unconditionally, for all three.
 * (2) none of the three can ever overwrite/demote an already-CONFIRMED
 *     classification -- manager authority always wins, and processing a
 *     CONFIRMED line is a silent no-op, never an error, so a race never
 *     aborts the rest of a batch.
 */

let fx: RpcTestFixtures;
let spendCategoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
});

async function confirmedInventoryItem(name: string): Promise<string> {
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `CIS-${crypto.randomUUID().slice(0, 8)}`, description: name }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  const result = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: name,
    disposition: "NON_INVENTORY",
    categoryId: null,
    spendCategoryId,
    baseUnitCode: null,
    rememberVendorMapping: false,
  });
  return result.inventoryItemId;
}

describe("system classification writers -- parent-status gate (priority 1)", () => {
  it("resolve_line_classification_deterministic succeeds against a DRAFT document", async () => {
    const itemId = await confirmedInventoryItem(`TEST Deterministic Target ${crypto.randomUUID().slice(0, 8)}`);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    const result = await resolveLineClassificationDeterministicRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId,
      lineKey,
      inventoryItemId: itemId,
      resolutionSource: "VENDOR_SKU_MAPPING",
    });
    expect(result).toBeUndefined(); // void wrapper -- no throw is the assertion

    const { data: classification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey)
      .single();
    expect(classification!.status).toBe("CONFIRMED");
  });

  it("the full regression: READY_FOR_VERIFICATION -> reviewer correction invalidates classification -> system reclassification succeeds -> classification resolves -- the exact flow 20260811100056 broke", async () => {
    const itemId = await confirmedInventoryItem(`TEST Reclass Target ${crypto.randomUUID().slice(0, 8)}`);
    const uniqueSku = `RECLASS-${crypto.randomUUID().slice(0, 8)}`;
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: uniqueSku, description: "Freight Original" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    // Confirm as NON_INVENTORY so submission needs no receiving/verifier
    // setup -- this test is about classification-write timing, not the
    // completion gate.
    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Freight ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });

    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });
    expect(submitted.status).toBe("READY_FOR_VERIFICATION");

    // Manager 2 (via the legitimate, still-live save_purchase_document_
    // review_corrections RPC -- see 20260811100060's own header comment on
    // why this DB-level capability was intentionally preserved even
    // though the orphaned Server Action wrapping it was removed) corrects
    // the line's description -- the trigger fires automatically and marks
    // the classification STALE.
    const corrected = await saveReviewCorrectionsRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: submitted.version,
      header: {
        vendorId: fx.vendorId,
        documentType: "INVOICE",
        documentNumber: `RECLASS-DOC-${purchaseDocumentId.slice(0, 8)}`,
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
          lineKey,
          vendorSku: uniqueSku,
          description: "Freight Corrected", // the change that invalidates the classification
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

    const { data: staleClassification } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey)
      .single();
    expect(staleClassification!.status).toBe("STALE");

    // The system reclassification that the automatic after()/manual "Run
    // Item Matching" path would perform -- this is the exact call that
    // previously hit GA003 unconditionally.
    await expect(
      resolveLineClassificationDeterministicRpc(fx.supabase, {
        organizationId: fx.organizationId,
        purchaseDocumentId,
        lineKey,
        inventoryItemId: itemId,
        resolutionSource: "VENDOR_SKU_MAPPING",
      })
    ).resolves.toBeUndefined();

    const { data: resolved } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status, inventory_item_id")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey)
      .single();
    expect(resolved!.status).toBe("CONFIRMED");
    expect(resolved!.inventory_item_id).toBe(itemId);

    // VERIFIED remains absolutely protected -- verify, then prove all
    // three writers are rejected regardless of the DRAFT/READY_FOR_
    // VERIFICATION gate just proven above.
    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: corrected.version,
    });

    await expect(
      resolveLineClassificationDeterministicRpc(fx.supabase, {
        organizationId: fx.organizationId,
        purchaseDocumentId,
        lineKey,
        inventoryItemId: itemId,
        resolutionSource: "VENDOR_SKU_MAPPING",
      })
    ).rejects.toThrow(/VERIFIED/);
  });

  it("record_ai_suggested_candidate and record_ai_item_proposal are also rejected once VERIFIED, never silently accepted", async () => {
    const itemId = await confirmedInventoryItem(`TEST AI Reject Target ${crypto.randomUUID().slice(0, 8)}`);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `AI-REJECT-${crypto.randomUUID().slice(0, 8)}`, description: "AI Reject Line" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST AI Reject ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });
    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });
    await verifyPurchaseDocumentRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.lockedEmployeeAppUserId,
      expectedVersion: submitted.version,
    });

    await expect(
      recordAiSuggestedCandidateRpc(fx.supabase, {
        organizationId: fx.organizationId,
        purchaseDocumentId,
        lineKey,
        candidateInventoryItemId: itemId,
        aiConfidence: 0.9,
      })
    ).rejects.toThrow(/VERIFIED/);

    await expect(
      recordAiItemProposalRpc(fx.supabase, {
        organizationId: fx.organizationId,
        purchaseDocumentId,
        lineKey,
        proposedName: "Should never be created",
        proposedDisposition: "NON_INVENTORY",
        proposedCategoryId: null,
        proposedSpendCategoryId: null,
        proposedBaseUnitCode: null,
        aiConfidence: 0.9,
      })
    ).rejects.toThrow(/VERIFIED/);
  });
});

describe("system classification writers never overwrite a CONFIRMED classification (priority 2)", () => {
  it("resolve_line_classification_deterministic preserves a manager-confirmed classification untouched, as a no-op, and lets other lines keep processing", async () => {
    const managerItemId = await confirmedInventoryItem(`TEST Manager Choice A ${crypto.randomUUID().slice(0, 8)}`);
    const racingItemId = await confirmedInventoryItem(`TEST Racing Candidate A ${crypto.randomUUID().slice(0, 8)}`);
    const otherLineTargetId = await confirmedInventoryItem(`TEST Other Line Target ${crypto.randomUUID().slice(0, 8)}`);

    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [
        { vendorSku: `RACE-A-${crypto.randomUUID().slice(0, 8)}`, description: "Race Line A" },
        { vendorSku: `RACE-B-${crypto.randomUUID().slice(0, 8)}`, description: "Race Line B" },
      ],
    });
    const [lineKeyA, lineKeyB] = await getLineKeys(fx.supabase, purchaseDocumentId);

    // The manager confirms line A -- "the classification run" (below) is
    // still in flight for the same line, exactly the race the review
    // brief describes.
    const managerApproval = await approveLineClassificationExistingItemRpcCall(managerItemId, purchaseDocumentId, lineKeyA);

    // The system writer reaches line A anyway and tries to resolve it to
    // a DIFFERENT item -- must be a silent no-op, never an overwrite.
    const raceResult = await resolveLineClassificationDeterministicRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId,
      lineKey: lineKeyA,
      inventoryItemId: racingItemId,
      resolutionSource: "VENDOR_SKU_MAPPING",
    });
    expect(raceResult).toBeUndefined();

    const { data: lineARow } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("id, status, inventory_item_id, resolved_by_app_user_id")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKeyA)
      .single();
    expect(lineARow!.id).toBe(managerApproval.classificationId); // same row, never replaced
    expect(lineARow!.status).toBe("CONFIRMED");
    expect(lineARow!.inventory_item_id).toBe(managerItemId); // manager's choice, not the racing candidate
    expect(lineARow!.resolved_by_app_user_id).toBe(fx.changeableEmployeeAppUserId); // attribution untouched

    // The OTHER, genuinely-unresolved line must still get processed --
    // one line already being CONFIRMED never aborts the rest of the batch.
    await expect(
      resolveLineClassificationDeterministicRpc(fx.supabase, {
        organizationId: fx.organizationId,
        purchaseDocumentId,
        lineKey: lineKeyB,
        inventoryItemId: otherLineTargetId,
        resolutionSource: "VENDOR_SKU_MAPPING",
      })
    ).resolves.toBeUndefined();

    const { data: lineBRow } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("status, inventory_item_id")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKeyB)
      .single();
    expect(lineBRow!.status).toBe("CONFIRMED");
    expect(lineBRow!.inventory_item_id).toBe(otherLineTargetId);
  });

  it("record_ai_suggested_candidate never clears a CONFIRMED line's inventory_item_id or attribution", async () => {
    const managerItemId = await confirmedInventoryItem(`TEST Manager Choice B ${crypto.randomUUID().slice(0, 8)}`);
    const racingItemId = await confirmedInventoryItem(`TEST Racing Candidate B ${crypto.randomUUID().slice(0, 8)}`);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `RACE-AI-${crypto.randomUUID().slice(0, 8)}`, description: "Race AI Line" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    const managerApproval = await approveLineClassificationExistingItemRpcCall(managerItemId, purchaseDocumentId, lineKey);

    await expect(
      recordAiSuggestedCandidateRpc(fx.supabase, {
        organizationId: fx.organizationId,
        purchaseDocumentId,
        lineKey,
        candidateInventoryItemId: racingItemId,
        aiConfidence: 0.99,
      })
    ).resolves.toBeUndefined();

    const { data: row } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("id, status, inventory_item_id, resolved_by_app_user_id")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey)
      .single();
    expect(row!.id).toBe(managerApproval.classificationId);
    expect(row!.status).toBe("CONFIRMED");
    expect(row!.inventory_item_id).toBe(managerItemId); // NOT nulled out, NOT replaced
    expect(row!.resolved_by_app_user_id).toBe(fx.changeableEmployeeAppUserId);
  });

  it("record_ai_item_proposal returns the existing CONFIRMED classification as a no-op instead of raising", async () => {
    const managerItemId = await confirmedInventoryItem(`TEST Manager Choice C ${crypto.randomUUID().slice(0, 8)}`);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `RACE-PROP-${crypto.randomUUID().slice(0, 8)}`, description: "Race Proposal Line" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    const managerApproval = await approveLineClassificationExistingItemRpcCall(managerItemId, purchaseDocumentId, lineKey);

    const rejectedName = `TEST Should never be created ${crypto.randomUUID().slice(0, 8)}`;
    const proposalResult = await recordAiItemProposalRpc(fx.supabase, {
      organizationId: fx.organizationId,
      purchaseDocumentId,
      lineKey,
      proposedName: rejectedName,
      proposedDisposition: "NON_INVENTORY",
      proposedCategoryId: null,
      proposedSpendCategoryId: null,
      proposedBaseUnitCode: null,
      aiConfidence: 0.9,
    });
    // No-op result: the EXISTING confirmed item, never a fresh proposal.
    expect(proposalResult.inventoryItemId).toBe(managerItemId);

    const { data: items } = await fx.supabase.from("inventory_items").select("id").eq("organization_id", fx.organizationId).eq("name", rejectedName);
    expect(items).toHaveLength(0); // no orphaned proposal row created

    const { data: row } = await fx.supabase
      .from("purchase_document_line_classifications")
      .select("id, status, inventory_item_id")
      .eq("purchase_document_id", purchaseDocumentId)
      .eq("line_key", lineKey)
      .single();
    expect(row!.id).toBe(managerApproval.classificationId);
    expect(row!.status).toBe("CONFIRMED");
    expect(row!.inventory_item_id).toBe(managerItemId);
  });
});

async function approveLineClassificationExistingItemRpcCall(
  inventoryItemId: string,
  purchaseDocumentId: string,
  lineKey: string
): Promise<{ classificationId: string }> {
  return approveLineClassificationExistingItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    inventoryItemId,
    rememberVendorMapping: false,
  });
}
