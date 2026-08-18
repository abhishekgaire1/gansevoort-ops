import { beforeAll, describe, expect, it } from "vitest";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { initiateAmendmentRpc } from "@/app/lib/purchaseDocuments/initiateAmendmentRpc";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { confirmReceivingLineInvoiceUnitRpc } from "@/app/lib/receiving/confirmReceivingLineInvoiceUnitRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory, findOrCreateNamedEmployee } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Proves 20260811100056's VERIFIED-lock is enforced in the DATABASE, not
 * merely by a UI control being hidden: once a purchase_document reaches
 * VERIFIED, every normal preparation-mutation RPC that touches it is
 * rejected -- item classification, invoice-unit confirmation, delivery-
 * verifier correction, and receipt CORRECTIONS. The one legitimate
 * exception (a genuinely new DELIVERY receipt -- "Record Additional
 * Delivery") remains allowed, append-only, never mutating the existing
 * receiving history. The SAME locks also apply during READY_FOR_
 * VERIFICATION (Manager 2's review window) for anyone other than the
 * specific sanctioned review-correction/verify RPCs -- Manager 2 must
 * Return to Preparer rather than mutate Manager 1's preparation directly.
 * A controlled amendment (a fresh DRAFT revision) remains fully editable,
 * proving the lock is scoped to the specific locked purchase_document,
 * never leaking across revisions.
 */

let fx: RpcTestFixtures;
let categoryId: string;
let spendCategoryId: string;
let locationId: string;
let deliveryVerifierEmployeeId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
  // Same dedicated, stably-named employee as completionGate.rpc.test.ts --
  // never fx.changeableEmployeeAppUserId's own employee, which OTHER
  // concurrently-running test files intentionally mutate.
  deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(fx.supabase, fx.organizationId, "TEST Delivery Verifier");
});

/** Builds a real VERIFIED document with one CONFIRMED INVENTORY,
 * FIXED_CONVERSION line, fully received, located, and delivery-verified
 * -- everything the completion gate requires -- so every test below is
 * exercising the VERIFIED-lock specifically, not an unrelated gate
 * failure. */
async function verifiedInventoryDocument(): Promise<{ purchaseDocumentId: string; documentId: string; lineKey: string }> {
  const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `LOCK-${crypto.randomUUID().slice(0, 8)}`, description: "Lock Test Heavy Cream", packageUnit: "CASE", measuredUnit: null, packageQuantity: 2 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

  await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Lock Heavy Cream ${purchaseDocumentId.slice(0, 8)}`,
    disposition: "INVENTORY",
    categoryId,
    spendCategoryId,
    baseUnitCode: "PIECE",
    purchaseUnitCode: "CASE",
    receivingBehavior: "FIXED_CONVERSION",
    fixedConversionFactor: 12,
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
        vendorSkuSnapshot: "LOCK-ITEM",
        descriptionSnapshot: "Lock Test Heavy Cream",
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

  await correctDocumentDeliveryVerifierRpc(fx.supabase, {
    documentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    newEmployeeId: deliveryVerifierEmployeeId,
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

  return { purchaseDocumentId, documentId, lineKey };
}

describe("VERIFIED lock -- backend enforcement, not just a hidden button", () => {
  it("rejects a new item-classification approval once VERIFIED", async () => {
    const { purchaseDocumentId, lineKey } = await verifiedInventoryDocument();

    await expect(
      approveLineClassificationNewItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        finalName: "Should never be allowed",
        disposition: "INVENTORY",
        categoryId,
        spendCategoryId,
        baseUnitCode: "PIECE",
        rememberVendorMapping: false,
      })
    ).rejects.toThrow(/VERIFIED/);
  });

  it("rejects an invoice-unit confirmation once VERIFIED", async () => {
    const { purchaseDocumentId, lineKey } = await verifiedInventoryDocument();

    await expect(
      confirmReceivingLineInvoiceUnitRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        purchaseDocumentId,
        lineKey,
        confirmedInvoiceUnitCode: "PIECE",
        rememberForVendor: false,
      })
    ).rejects.toThrow(/VERIFIED/);
  });

  it("rejects correcting the delivery verifier once the document is VERIFIED", async () => {
    const { documentId } = await verifiedInventoryDocument();

    await expect(
      correctDocumentDeliveryVerifierRpc(fx.supabase, {
        documentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        newEmployeeId: deliveryVerifierEmployeeId,
      })
    ).rejects.toThrow(/verified/i);
  });

  it("rejects correcting the delivery verifier during READY_FOR_VERIFICATION too -- adversarial-review priority 4: the ORIGINAL PREPARER re-opening their own submitted document must not be able to silently correct it mid-review", async () => {
    const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `RFV-VERIFIER-${crypto.randomUUID().slice(0, 8)}`, description: "Ready For Verification Verifier Lock Item" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST RFV Verifier Lock ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });
    await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });

    // The same preparer who submitted it -- exactly the reachable UI path
    // (revisiting their own Step 4) the review found, not merely a
    // hypothetical outside actor.
    await expect(
      correctDocumentDeliveryVerifierRpc(fx.supabase, {
        documentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        newEmployeeId: deliveryVerifierEmployeeId,
      })
    ).rejects.toThrow(/ready for verification/i);
  });

  it("rejects a receipt CORRECTION once VERIFIED, but a genuinely new DELIVERY (Record Additional Delivery) is still allowed and append-only", async () => {
    const { purchaseDocumentId, lineKey } = await verifiedInventoryDocument();

    const { data: firstReceipt } = await fx.supabase.from("receipts").select("id").eq("purchase_document_id", purchaseDocumentId).limit(1).single();

    await expect(
      recordReceiptRpc(fx.supabase, {
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        receiptKind: "CORRECTION",
        correctsReceiptId: firstReceipt!.id as string,
        lines: [],
      })
    ).rejects.toThrow(/VERIFIED/);

    // A genuinely new delivery event remains allowed -- append-only,
    // never mutating the original receipt.
    const additional = await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "LOCK-ITEM",
          descriptionSnapshot: "Lock Test Heavy Cream -- additional delivery",
          invoicePackageQuantity: null,
          invoicePackageUnit: null,
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 1,
          actualReceivedPackageUnit: "CASE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });
    expect(additional.receiptId).not.toBe(firstReceipt!.id);

    const { data: originalStillIntact } = await fx.supabase
      .from("receipt_lines")
      .select("actual_received_package_quantity")
      .eq("receipt_id", firstReceipt!.id as string)
      .eq("matched_line_key", lineKey)
      .single();
    expect(originalStillIntact!.actual_received_package_quantity).toBe(2); // untouched by the additional delivery
  });

  it("rejects the PREPARER's own mutation during READY_FOR_VERIFICATION -- the reviewer-correction window never opens for the preparer", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `READY-${crypto.randomUUID().slice(0, 8)}`, description: "Ready Lock Item" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `TEST Ready Lock Item ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });
    await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });

    // The PREPARER attempting a classification-approval RPC on their own
    // READY submission is rejected -- 20260811100070's reviewer-correction
    // window opens ONLY for a different (non-preparer) manager, never for
    // the preparer (the non-preparer sanctioned path is covered in
    // reviewerCorrections.rpc.test.ts).
    await expect(
      approveLineClassificationNewItemRpc(fx.supabase, {
        purchaseDocumentId,
        lineKey,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        finalName: "Should never be allowed mid-review",
        disposition: "NON_INVENTORY",
        categoryId: null,
        spendCategoryId,
        baseUnitCode: null,
        rememberVendorMapping: false,
      })
    ).rejects.toThrow(/cannot review-correct its item resolution/);
  });

  it("a controlled amendment (new DRAFT revision) remains fully editable -- the lock never leaks across revisions", async () => {
    const { purchaseDocumentId } = await verifiedInventoryDocument();

    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      reason: "test amendment for VERIFIED-lock isolation",
    });
    const pd2 = amendment.purchaseDocumentId;
    expect(pd2).not.toBe(purchaseDocumentId);

    const [pd2LineKey] = await getLineKeys(fx.supabase, pd2);
    // A normal classification approval on the NEW (DRAFT) revision
    // succeeds -- proves the lock is scoped to the specific locked
    // purchase_document row, not something that follows the revision
    // group or the underlying item/vendor around.
    await expect(
      approveLineClassificationNewItemRpc(fx.supabase, {
        purchaseDocumentId: pd2,
        lineKey: pd2LineKey,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        finalName: `TEST Amendment Reclassified ${pd2.slice(0, 8)}`,
        disposition: "NON_INVENTORY",
        categoryId: null,
        spendCategoryId,
        baseUnitCode: null,
        rememberVendorMapping: false,
      })
    ).resolves.toMatchObject({ classificationId: expect.any(String) });
  });
});
