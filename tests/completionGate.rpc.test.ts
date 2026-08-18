import { beforeAll, describe, expect, it } from "vitest";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { getPreparationStatus } from "@/app/lib/purchaseDocuments/getPreparationStatus";
import { PreparationIncompleteError } from "@/app/lib/purchaseDocuments/errors";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import {
  createDraftPurchaseDocumentWithLines,
  getLineKeys,
  findOrCreateThrowawaySpendCategory,
  confirmAllCurrentLinesNonInventory,
  findOrCreateNamedEmployee,
} from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Proves the first-manager completion gate (20260811100047, extended by
 * 20260811100056) -- the superseding-§16 rule: Send for Final Review must
 * be blocked while any CURRENT relevant line has missing classification,
 * PENDING_REVIEW, STALE, or (for a CONFIRMED INVENTORY line) missing
 * receiving/location/required-measurement, missing delivery verifier, or
 * an implausible document date -- and that a NON_INVENTORY line/document
 * is never blocked by any of the physical-delivery requirements.
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
  // A dedicated employee, never fx.changeableEmployeeAppUserId's own
  // employee -- that one is intentionally mutated by OTHER concurrently-
  // running test files (PIN changes etc.), which caused exactly this
  // session's earlier flaky-fixture lesson.
  deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(fx.supabase, fx.organizationId, "TEST Delivery Verifier");
});

async function setDeliveryVerifier(documentId: string): Promise<void> {
  await correctDocumentDeliveryVerifierRpc(fx.supabase, {
    documentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    newEmployeeId: deliveryVerifierEmployeeId,
  });
}

describe("first-manager completion gate", () => {
  it("blocks submit when a line has never been classified", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    });

    const status = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(status.ready).toBe(false);
    expect(status.blockers[0].reason).toMatch(/classification/i);

    await expect(
      submitPurchaseDocumentForVerificationRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
      })
    ).rejects.toBeInstanceOf(PreparationIncompleteError);
  });

  it("allows submit once a NON_INVENTORY line is confirmed, with no receiving data required", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "FREIGHT-1", description: "Freight Charge" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Freight Charge ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "NON_INVENTORY",
      categoryId: null,
      spendCategoryId,
      baseUnitCode: null,
      rememberVendorMapping: false,
    });

    const status = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(status.ready).toBe(true);

    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });
    expect(submitted.status).toBe("READY_FOR_VERIFICATION");
  });

  it("blocks a CONFIRMED INVENTORY line until it has been received with a location", async () => {
    const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "GATE-ITEM-1", description: "Gate Test Item", packageUnit: "PIECE", measuredUnit: "PIECE" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Gate Test Item ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "PIECE",
      rememberVendorMapping: false,
    });

    // Classified, but not yet received -- still blocked.
    let status = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(status.ready).toBe(false);
    expect(status.blockers[0].reason).toMatch(/not yet received/i);

    await expect(
      submitPurchaseDocumentForVerificationRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
      })
    ).rejects.toBeInstanceOf(PreparationIncompleteError);

    // Receive it, but with no location -- still blocked.
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "GATE-ITEM-1",
          descriptionSnapshot: "Gate Test Item",
          invoicePackageQuantity: 1,
          invoicePackageUnit: "PIECE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 1,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId: null,
        },
      ],
    });

    status = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(status.ready).toBe(false);
    expect(status.blockers[0].reason).toMatch(/location/i);

    // Now with a location -- ready.
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "GATE-ITEM-1",
          descriptionSnapshot: "Gate Test Item",
          invoicePackageQuantity: 1,
          invoicePackageUnit: "PIECE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 1,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });

    // Received and located, but no delivery verifier yet -- still blocked.
    status = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(status.ready).toBe(false);
    expect(status.blockers.some((b) => /delivery verified/i.test(b.reason))).toBe(true);

    await expect(
      submitPurchaseDocumentForVerificationRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
      })
    ).rejects.toBeInstanceOf(PreparationIncompleteError);

    // Now with a delivery verifier too -- ready.
    await setDeliveryVerifier(documentId);
    status = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(status.ready).toBe(true);
  });

  it("requires a verified measurement for a MEASURE_EACH_DELIVERY item even after quantity/location are recorded", async () => {
    const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "GATE-RADISH", description: "Gate Korean Radish", packageUnit: "BOX", measuredUnit: "LB" }],
    });
    await setDeliveryVerifier(documentId);
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Gate Korean Radish ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "LB",
      purchaseUnitCode: "BOX",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
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
          vendorSkuSnapshot: "GATE-RADISH",
          descriptionSnapshot: "Gate Korean Radish",
          invoicePackageQuantity: 1,
          invoicePackageUnit: "BOX",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 1,
          actualReceivedPackageUnit: "BOX",
          actualVerifiedBaseQuantity: null, // NOT provided -- must still block
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });

    let status = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(status.ready).toBe(false);
    expect(status.blockers[0].reason).toMatch(/verified/i);

    await expect(
      submitPurchaseDocumentForVerificationRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
      })
    ).rejects.toBeInstanceOf(PreparationIncompleteError);

    // A correction receipt supplying the verified weight completes it.
    const { data: units } = await fx.supabase.from("units").select("id").eq("code", "LB").single();
    const { data: firstReceipt } = await fx.supabase.from("receipts").select("id").eq("purchase_document_id", purchaseDocumentId).limit(1).single();
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "CORRECTION",
      correctsReceiptId: firstReceipt!.id as string,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: lineKey,
          vendorSkuSnapshot: "GATE-RADISH",
          descriptionSnapshot: "Gate Korean Radish",
          invoicePackageQuantity: 1,
          invoicePackageUnit: "BOX",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 1,
          actualReceivedPackageUnit: "BOX",
          actualVerifiedBaseQuantity: 38.6,
          actualVerifiedBaseUnitId: units!.id as string,
          locationId,
        },
      ],
    });

    status = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(status.ready).toBe(true);
  });

  it("does not require a delivery verifier for a purely NON_INVENTORY document -- nothing physical to verify", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "GATE-FREIGHT", description: "Gate Freight Charge" }],
    });
    await confirmAllCurrentLinesNonInventory(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, purchaseDocumentId);

    const status = await getPreparationStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(status.ready).toBe(true); // no delivery-verifier blocker, even though none was ever set

    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });
    expect(submitted.status).toBe("READY_FOR_VERIFICATION");
  });

  it("blocks submit for an obviously implausible document date (year < 2000), and does not silently correct it", async () => {
    const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: "GATE-DATE-ITEM", description: "Gate Date Item", packageUnit: "PIECE", measuredUnit: "PIECE" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Gate Date Item ${purchaseDocumentId.slice(0, 8)}`,
      disposition: "INVENTORY",
      categoryId,
      spendCategoryId,
      baseUnitCode: "PIECE",
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
          vendorSkuSnapshot: "GATE-DATE-ITEM",
          descriptionSnapshot: "Gate Date Item",
          invoicePackageQuantity: 1,
          invoicePackageUnit: "PIECE",
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 1,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });
    await setDeliveryVerifier(documentId);

    // Fully complete otherwise -- only the implausible date remains.
    await expect(
      submitPurchaseDocumentForVerificationRpc(fx.supabase, {
        purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
        expectedVersion: 1,
        header: {
          vendorId: fx.vendorId,
          documentType: "INVOICE",
          documentNumber: "GATE-DATE-1",
          documentDate: "0002-05-29", // the exact real corrupted-extraction case
          poNumber: null,
          deliveryDate: "2026-05-29",
          subtotal: 10,
          tax: 0,
          fees: 0,
          total: 10,
          currency: "USD",
        },
        lines: [
          {
            lineKey,
            vendorSku: "GATE-DATE-ITEM",
            description: "Gate Date Item",
            packageQuantity: 1,
            packageUnit: "PIECE",
            measuredQuantity: null,
            measuredUnit: "PIECE",
            unitPrice: 10,
            priceBasisUnit: null,
            lineTotal: 10,
            rawLineText: null,
          },
        ],
      })
    ).rejects.toBeInstanceOf(PreparationIncompleteError);

    // The rejected submit never persisted anything -- the implausible
    // date was caught BEFORE the header UPDATE, so it was never written
    // at all (not "written then silently corrected"), and the document
    // remains DRAFT.
    const { data: row } = await fx.supabase.from("purchase_documents").select("document_date, status").eq("id", purchaseDocumentId).single();
    expect(row!.document_date).not.toBe("0002-05-29");
    expect(row!.status).toBe("DRAFT");

    // Correcting the date to something plausible lets it through.
    const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
      header: {
        vendorId: fx.vendorId,
        documentType: "INVOICE",
        documentNumber: "GATE-DATE-1",
        documentDate: "2026-05-29",
        poNumber: null,
        deliveryDate: "2026-05-29",
        subtotal: 10,
        tax: 0,
        fees: 0,
        total: 10,
        currency: "USD",
      },
      lines: [
        {
          lineKey,
          vendorSku: "GATE-DATE-ITEM",
          description: "Gate Date Item",
          packageQuantity: 1,
          packageUnit: "PIECE",
          measuredQuantity: null,
          measuredUnit: "PIECE",
          unitPrice: 10,
          priceBasisUnit: null,
          lineTotal: 10,
          rawLineText: null,
        },
      ],
    });
    expect(submitted.status).toBe("READY_FOR_VERIFICATION");
  });
});
