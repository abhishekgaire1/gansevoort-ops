import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory, findOrCreateNamedEmployee } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { postPurchaseDocumentSoleApproverRpc } from "@/app/lib/purchaseDocuments/soleApproverPostingRpc";
import { userHasPermission, SOLE_APPROVER_PERMISSION_KEY } from "@/app/lib/auth/permissions";
import {
  SoleApproverPermissionDeniedError,
  SoleApproverReasonRequiredError,
  PreparationIncompleteError,
  StaleVersionError,
} from "@/app/lib/purchaseDocuments/errors";
import { AmendmentLineageAlreadyPostedError, InventoryPostingBlockedError } from "@/app/lib/inventory/errors";
import { initiateAmendmentRpc } from "@/app/lib/purchaseDocuments/initiateAmendmentRpc";

/**
 * Permission-gated single-manager invoice posting (20260811100133).
 * Covers the DB-authoritative half of the feature: has_permission /
 * post_purchase_document_sole_approver's own non-overridable gates. The
 * duplicate-invoice and invoice-total-discrepancy blockers are enforced
 * one layer up, in the Next.js server action (app/actions/
 * purchaseDocuments.ts's postPurchaseDocumentSoleApprover) by re-running
 * the SAME findPossibleDuplicatePurchaseDocuments/validatePurchaseDocumentDraft
 * functions already covered by purchaseDocumentDuplicates.unit.test.ts and
 * validatePurchaseDocumentDraft.unit.test.ts -- not re-tested here to
 * avoid a second, competing verification of logic already proven correct
 * elsewhere.
 */

let fx: RpcTestFixtures;
let locationId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).order("created_at", { ascending: true }).limit(1).single();
  locationId = location!.id as string;
});

async function grantSoleApprover(supabase: SupabaseClient, organizationId: string, appUserId: string): Promise<void> {
  const { data: role } = await supabase.from("roles").select("id").eq("name", "purchase_sole_approver").single();
  await supabase.from("user_roles").upsert({ app_user_id: appUserId, role_id: role!.id, organization_id: organizationId }, { onConflict: "app_user_id,role_id" });
}

async function revokeSoleApprover(supabase: SupabaseClient, appUserId: string): Promise<void> {
  const { data: role } = await supabase.from("roles").select("id").eq("name", "purchase_sole_approver").single();
  await supabase.from("user_roles").delete().eq("app_user_id", appUserId).eq("role_id", role!.id);
}

/** Same shape as createSubmittedPostingDocument (inventoryPostingTestHelpers.ts)
 * but stopped at DRAFT -- post_purchase_document_sole_approver's own entry
 * gate. One INVENTORY line, fully classified/received/located/delivery-
 * verified, so the ONLY thing left to prove per test is the sole-approver
 * gate itself, never an unrelated preparation gap. */
/** Classifies (as INVENTORY), receives, and sets the delivery verifier for
 * an EXISTING draft's single line -- shared by a fresh draft and an
 * amendment revision alike (an amendment's own line_key regenerates fresh
 * per revision, so it needs this exact same re-preparation a real manager
 * would do before that revision could ever be sent/posted again). */
async function prepareExistingDraft(
  supabase: SupabaseClient,
  purchaseDocumentId: string,
  opts: { setDeliveryVerifier?: boolean } = {}
): Promise<{ itemId: string; lineKey: string }> {
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(supabase, fx.organizationId);
  const { data: categoryRow } = await supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  const categoryId = categoryRow!.category_id as string;
  const deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(supabase, fx.organizationId, "TEST Sole Approver Delivery Verifier");
  const runTag = randomUUID().slice(0, 8);
  const [lineKey] = await getLineKeys(supabase, purchaseDocumentId);

  const approved = await approveLineClassificationNewItemRpc(supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Sole Approver Item ${runTag}`,
    disposition: "INVENTORY",
    categoryId,
    spendCategoryId,
    baseUnitCode: "PIECE",
    purchaseUnitCode: null,
    receivingBehavior: null,
    fixedConversionFactor: null,
    rememberVendorMapping: false,
  });

  await recordReceiptRpc(supabase, {
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    receiptKind: "DELIVERY",
    purchaseDocumentId,
    lines: [
      {
        lineNumberSnapshot: 1,
        matchedLineKey: lineKey,
        vendorSkuSnapshot: `SOLE-${runTag}`,
        descriptionSnapshot: "Sole Approver Test Line",
        invoicePackageQuantity: 5,
        invoicePackageUnit: "PIECE",
        invoiceMeasuredQuantity: null,
        invoiceMeasuredUnit: null,
        actualReceivedPackageQuantity: 5,
        actualReceivedPackageUnit: "PIECE",
        actualVerifiedBaseQuantity: null,
        actualVerifiedBaseUnitId: null,
        locationId,
      },
    ],
  });

  // The delivery verifier is recorded against the shared documents row
  // (source_document_id), not per-revision -- once set on the original,
  // it already satisfies purchase_document_missing_delivery_verifier for
  // every later amendment revision too, and correct_document_delivery_
  // verifier itself refuses once the CURRENT lineage has reached VERIFIED
  // (a real, intentional lock -- the physical delivery record itself,
  // never retroactively changeable once finalized).
  if (opts.setDeliveryVerifier ?? true) {
    const { data: doc } = await supabase.from("purchase_documents").select("source_document_id").eq("id", purchaseDocumentId).single();
    await correctDocumentDeliveryVerifierRpc(supabase, {
      documentId: doc!.source_document_id as string,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      newEmployeeId: deliveryVerifierEmployeeId,
    });
  }

  return { itemId: approved.inventoryItemId!, lineKey };
}

async function buildFullyPreparedDraft(supabase: SupabaseClient): Promise<{ purchaseDocumentId: string; version: number; itemId: string; lineKey: string }> {
  const runTag = randomUUID().slice(0, 8);
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `SOLE-${runTag}`, description: "Sole Approver Test Line", packageUnit: "PIECE", packageQuantity: 5 }],
  });
  const { itemId, lineKey } = await prepareExistingDraft(supabase, purchaseDocumentId);
  return { purchaseDocumentId, version: 1, itemId, lineKey };
}

describe("has_permission / sole-approver role grant", () => {
  it("test 2 + 16: an unauthorized manager has no permission until explicitly granted, and losing the grant takes effect immediately", async () => {
    await revokeSoleApprover(fx.supabase, fx.mustPickEmployeeAppUserId);
    expect(await userHasPermission(fx.supabase, { appUserId: fx.mustPickEmployeeAppUserId, organizationId: fx.organizationId, permissionKey: SOLE_APPROVER_PERMISSION_KEY })).toBe(false);

    await grantSoleApprover(fx.supabase, fx.organizationId, fx.mustPickEmployeeAppUserId);
    expect(await userHasPermission(fx.supabase, { appUserId: fx.mustPickEmployeeAppUserId, organizationId: fx.organizationId, permissionKey: SOLE_APPROVER_PERMISSION_KEY })).toBe(true);

    await revokeSoleApprover(fx.supabase, fx.mustPickEmployeeAppUserId);
    expect(await userHasPermission(fx.supabase, { appUserId: fx.mustPickEmployeeAppUserId, organizationId: fx.organizationId, permissionKey: SOLE_APPROVER_PERMISSION_KEY })).toBe(false);
  });
});

describe("post_purchase_document_sole_approver", () => {
  it("test 3: an unauthorized manager's forged call is rejected server-side, never bypassable by simply calling the RPC directly", async () => {
    const draft = await buildFullyPreparedDraft(fx.supabase);
    await revokeSoleApprover(fx.supabase, fx.changeableEmployeeAppUserId);

    await expect(
      postPurchaseDocumentSoleApproverRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: draft.version,
        reason: "MANAGER_COMPLETED_FULL_REVIEW",
        notes: null,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow(SoleApproverPermissionDeniedError);
  });

  it("test 4: a blank reason is refused server-side, never trusted from the client alone", async () => {
    const draft = await buildFullyPreparedDraft(fx.supabase);
    await grantSoleApprover(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId);

    await expect(
      postPurchaseDocumentSoleApproverRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: draft.version,
        // @ts-expect-error -- deliberately blank, mirroring a forged/buggy caller
        reason: "",
        notes: null,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow(SoleApproverReasonRequiredError);
  });

  it("test 6 + 13: a fully valid invoice posts successfully -- VERIFIED as sole approver, posted to inventory, with a structured audit event", async () => {
    const draft = await buildFullyPreparedDraft(fx.supabase);
    await grantSoleApprover(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId);
    const idempotencyKey = randomUUID();

    const result = await postPurchaseDocumentSoleApproverRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: draft.version,
      reason: "SECOND_REVIEWER_UNAVAILABLE",
      notes: "Only one manager on site tonight.",
      idempotencyKey,
    });

    expect(result.status).toBe("VERIFIED");
    expect(result.verificationMethod).toBe("SOLE_APPROVER");
    expect(result.postingStatus).toBe("POSTED");
    expect(result.postedLineCount).toBe(1);
    expect(result.inventoryLineCount).toBe(1);
    expect(result.expenseLineCount).toBe(0);

    const { data: doc } = await fx.supabase
      .from("purchase_documents")
      .select("status, verification_method, sole_approver_reason, sole_approver_notes, verified_by_app_user_id")
      .eq("id", draft.purchaseDocumentId)
      .single();
    expect(doc!.status).toBe("VERIFIED");
    expect(doc!.verification_method).toBe("SOLE_APPROVER");
    expect(doc!.sole_approver_reason).toBe("SECOND_REVIEWER_UNAVAILABLE");
    expect(doc!.sole_approver_notes).toBe("Only one manager on site tonight.");
    expect(doc!.verified_by_app_user_id).toBe(fx.changeableEmployeeAppUserId);

    // test 13: the audit event carries every required structured field,
    // never a generic message alone.
    const { data: auditEvent } = await fx.supabase
      .from("audit_events")
      .select("after_state")
      .eq("organization_id", fx.organizationId)
      .eq("entity_type", "purchase_document")
      .eq("entity_id", draft.purchaseDocumentId)
      .eq("action", "PURCHASE_DOCUMENT_POSTED_SOLE_APPROVER")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .single();
    const after = auditEvent!.after_state as Record<string, unknown>;
    expect(after.actorAppUserId).toBe(fx.changeableEmployeeAppUserId);
    expect(after.actorName).toBeTruthy();
    expect(after.permissionUsed).toBe(SOLE_APPROVER_PERMISSION_KEY);
    expect(after.reason).toBe("SECOND_REVIEWER_UNAVAILABLE");
    expect(after.notes).toBe("Only one manager on site tonight.");
    expect(after.occurredAt).toBeTruthy();
    expect(after.invoiceTotal).toBeTypeOf("number");
    expect(after.inventoryValue).toBeTypeOf("number");
    expect(after.inventoryLineCount).toBe(1);
    expect(after.expenseLineCount).toBe(0);
    expect(after.postingStatus).toBe("POSTED");
    expect(after.postedLineCount).toBe(1);
    expect(after.idempotencyKey).toBe(idempotencyKey);
    expect(after.revisionGroupId).toBeTruthy();
  });

  it("test 7: unresolved item mapping cannot be bypassed", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "SOLE-UNCLASSIFIED", description: "Unclassified line", packageUnit: "PIECE", packageQuantity: 1 }],
    });
    await grantSoleApprover(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId);

    await expect(
      postPurchaseDocumentSoleApproverRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
        reason: "MANAGER_COMPLETED_FULL_REVIEW",
        notes: null,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow(PreparationIncompleteError);
  });

  it("test 8: a purchase-package/received-unit mismatch cannot be bypassed -- post_purchase_document_inventory's own blocker scan still applies unmodified", async () => {
    const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
    const { data: categoryRow } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
    const categoryId = categoryRow!.category_id as string;
    const deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(fx.supabase, fx.organizationId, "TEST Sole Approver Mismatch Verifier");
    const runTag = randomUUID().slice(0, 8);

    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `SOLE-MISMATCH-${runTag}`, description: "Mismatched unit line", packageUnit: "CASE", packageQuantity: 2 }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    // Confirmed purchase package is PIECE (SAME_UNIT) -- but the receipt
    // below records "2 CASE" received, a unit the confirmed package never
    // authorized. post_purchase_document_inventory's blocker scan must
    // still catch this even though it's reached via the sole-approver path.
    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Sole Approver Mismatch Item ${runTag}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "PIECE",
      purchaseUnitCode: null,
      receivingBehavior: null,
      fixedConversionFactor: null,
      rememberVendorMapping: false,
    });

    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: `SOLE-MISMATCH-${runTag}`,
          descriptionSnapshot: "Mismatched unit line",
          invoicePackageQuantity: 2,
          invoicePackageUnit: "CASE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 2,
          actualReceivedPackageUnit: "CASE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });

    const { data: doc } = await fx.supabase.from("purchase_documents").select("source_document_id").eq("id", purchaseDocumentId).single();
    await correctDocumentDeliveryVerifierRpc(fx.supabase, {
      documentId: doc!.source_document_id as string,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      newEmployeeId: deliveryVerifierEmployeeId,
    });

    await grantSoleApprover(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId);

    await expect(
      postPurchaseDocumentSoleApproverRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
        reason: "MANAGER_COMPLETED_FULL_REVIEW",
        notes: null,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow(InventoryPostingBlockedError);
  });

  it("test 11: an amendment lineage that already posted inventory cannot post again via sole approver", async () => {
    const draft = await buildFullyPreparedDraft(fx.supabase);
    await grantSoleApprover(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId);

    await postPurchaseDocumentSoleApproverRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: draft.version,
      reason: "MANAGER_COMPLETED_FULL_REVIEW",
      notes: null,
      idempotencyKey: randomUUID(),
    });

    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: draft.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      reason: "Correcting a typo -- inventory already posted from the original.",
    });
    // The amendment's own line_key regenerates fresh per revision -- a
    // real manager re-confirms item mapping/receiving on it exactly like
    // any other draft before it could ever be sent/posted; this proves
    // the already-posted guard fires even once that re-preparation is
    // genuinely complete, not merely because prep was still missing.
    await prepareExistingDraft(fx.supabase, amendment.purchaseDocumentId, { setDeliveryVerifier: false });
    await grantSoleApprover(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId);

    await expect(
      postPurchaseDocumentSoleApproverRpc(fx.supabase, {
        purchaseDocumentId: amendment.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
        reason: "MANAGER_COMPLETED_FULL_REVIEW",
        notes: null,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow(AmendmentLineageAlreadyPostedError);
  });

  it("test 12: concurrent clicks produce exactly one posting -- the second call sees a stale version, never a double-post", async () => {
    const draft = await buildFullyPreparedDraft(fx.supabase);
    await grantSoleApprover(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId);

    const call = () =>
      postPurchaseDocumentSoleApproverRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: draft.version,
        reason: "TIME_SENSITIVE_RECEIVING",
        notes: null,
        idempotencyKey: randomUUID(),
      });

    const results = await Promise.allSettled([call(), call()]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleVersionError);

    const { data: posting } = await fx.supabase
      .from("purchase_document_inventory_postings")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .eq("purchase_document_id", draft.purchaseDocumentId);
    expect(posting).toHaveLength(1);
  });

  it("test 17: cross-organization access is rejected -- a caller's own org can never reach another org's document", async () => {
    const draft = await buildFullyPreparedDraft(fx.supabase);
    const otherOrg = await setupOtherOrgFixtures(fx.supabase);
    await grantSoleApprover(fx.supabase, otherOrg.organizationId, otherOrg.appUserId);

    await expect(
      postPurchaseDocumentSoleApproverRpc(fx.supabase, {
        purchaseDocumentId: draft.purchaseDocumentId,
        organizationId: otherOrg.organizationId,
        appUserId: otherOrg.appUserId,
        expectedVersion: draft.version,
        reason: "MANAGER_COMPLETED_FULL_REVIEW",
        notes: null,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow(/not found/i);
  });
});
