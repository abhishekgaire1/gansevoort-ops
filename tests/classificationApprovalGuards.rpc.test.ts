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

describe("authorized-manager correction of another preparer's DRAFT (20260811100168)", () => {
  it("a non-preparer who holds correct_any_draft may approve, and the acting manager is audited", async () => {
    // Confer ONLY the correct_any_draft capability on an otherwise-unused
    // fixture app_user via a DEDICATED role -- deliberately NOT the base
    // 'manager' role, which also carries post_without_second_review and would
    // contaminate the sole-approver suite that shares this fixture user.
    const dedicatedRoleName = "test_correct_any_draft_only";
    const existingRole = await fx.supabase.from("roles").select("id").eq("name", dedicatedRoleName).maybeSingle();
    let roleId: string;
    if (existingRole.data) {
      roleId = existingRole.data.id as string;
    } else {
      const inserted = await fx.supabase.from("roles").insert({ name: dedicatedRoleName, description: "Test-only: correct any purchase-document draft." }).select("id").single();
      expect(inserted.error).toBeNull();
      roleId = inserted.data!.id as string;
    }
    const { data: perm } = await fx.supabase.from("permissions").select("id").eq("key", "purchase_documents.correct_any_draft").maybeSingle();
    expect(perm?.id).toBeTruthy();
    await fx.supabase.from("role_permissions").upsert({ role_id: roleId, permission_id: perm!.id }, { onConflict: "role_id,permission_id" });
    const { error: grantErr } = await fx.supabase
      .from("user_roles")
      .upsert({ app_user_id: fx.mustPickEmployeeAppUserId, role_id: roleId, organization_id: fx.organizationId }, { onConflict: "app_user_id,role_id" });
    expect(grantErr).toBeNull();

    const { data: hasPerm, error: permErr } = await fx.supabase.rpc("has_permission", {
      p_app_user_id: fx.mustPickEmployeeAppUserId,
      p_organization_id: fx.organizationId,
      p_permission_key: "purchase_documents.correct_any_draft",
    });
    expect(permErr).toBeNull();
    expect(hasPerm).toBe(true);

    const { purchaseDocumentId, lineKey } = await draftWithOneLine("Authorized Corrector Line"); // preparer = changeableEmployee
    const existingItemId = await confirmedItemForExistingApproval();

    // NOT the preparer, but authorized -> the guard now allows it (no GA079/GA006).
    await expect(
      approveLineClassificationExistingItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey,
        organizationId: fx.organizationId,
        appUserId: fx.mustPickEmployeeAppUserId,
        inventoryItemId: existingItemId,
        rememberVendorMapping: false,
      })
    ).resolves.toMatchObject({ classificationId: expect.any(String) });

    // The acting manager (not the preparer) is recorded in the audit history.
    const { data: audits } = await fx.supabase
      .from("audit_events")
      .select("actor_app_user_id, entity_id")
      .eq("organization_id", fx.organizationId)
      .eq("entity_id", purchaseDocumentId)
      .eq("actor_app_user_id", fx.mustPickEmployeeAppUserId);
    expect((audits ?? []).length).toBeGreaterThan(0);
  });

  it("a non-preparer WITHOUT the capability is still rejected server-side", async () => {
    const { purchaseDocumentId, lineKey } = await draftWithOneLine("Unauthorized Corrector Line");
    const existingItemId = await confirmedItemForExistingApproval();
    await expect(
      approveLineClassificationExistingItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey,
        organizationId: fx.organizationId,
        appUserId: fx.lockedEmployeeAppUserId, // no manager role -> no permission
        inventoryItemId: existingItemId,
        rememberVendorMapping: false,
      })
    ).rejects.toThrow(NotPreparerError);
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
