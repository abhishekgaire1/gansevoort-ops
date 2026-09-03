import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { getReceivingLines } from "@/app/lib/receiving/getReceivingLines";
import { hasSiblingRevisionAlreadyPosted } from "@/app/lib/purchaseDocuments/amendmentPostingStatus";
import { initiateAmendmentRpc } from "@/app/lib/purchaseDocuments/initiateAmendmentRpc";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { classifyLineOutcome } from "@/app/lib/purchaseDocuments/combinedLineReadiness";
import { receivingLineIsReady } from "@/app/lib/purchaseDocuments/itemsAndReceivingCardState";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Redesign: Steps 2 and 3 (Confirm Items / Confirm Receiving) are now one
 * combined "Confirm Items & Receiving" step. This file proves:
 *   - test 14: the "inventory already posted from the original revision"
 *     notice's own underlying check (hasSiblingRevisionAlreadyPosted,
 *     mirroring migration 20260811100132's server-side guard).
 *   - test 18: a line classified and received through the EXISTING,
 *     UNCHANGED actions (getReceivingLines, approve/record RPCs) is
 *     correctly read back and classified "ready" by the new combined
 *     readiness logic -- no data is lost or reinterpreted by the redesign.
 */

let fx: RpcTestFixtures;
let locationId: string;
let spendCategoryId: string;
let categoryId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
});

describe("test 18: existing (pre-redesign-shaped) invoice progress reads correctly through the combined step's logic", () => {
  it("a line classified and received through the existing, unchanged actions is read back and classified ready -- nothing is lost by the redesign", async () => {
    const runTag = randomUUID().slice(0, 8);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `REDESIGN-${runTag}`, description: `Redesign Progress Test ${runTag}`, packageUnit: "PIECE" }],
    });
    const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

    const approved = await approveLineClassificationNewItemRpc(fx.supabase, {
      purchaseDocumentId,
      lineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      finalName: `Redesign Progress Item ${runTag}`,
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
          vendorSkuSnapshot: `REDESIGN-${runTag}`,
          descriptionSnapshot: "Redesign Progress Test",
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

    const receivingLines = await getReceivingLines(fx.supabase, purchaseDocumentId, fx.organizationId);
    const receivingLine = receivingLines.find((l) => l.lineKey === lineKey)!;
    expect(receivingLine.disposition).toBe("INVENTORY");
    expect(receivingLine.inventoryItemId).toBe(approved.inventoryItemId);

    // The combined step's own readiness draft-check would see this
    // already-received line as ready (a real receipt is at least as
    // complete as any draft could be: quantity, location, and no
    // measurement is required for SAME_UNIT PIECE).
    const draftShapedFromReceipt = {
      receivedQuantity: "5",
      verifiedQuantity: "",
      locationId,
      info: { requiresVerifiedMeasurement: receivingLine.requiresVerifiedMeasurement },
    };
    expect(receivingLineIsReady(draftShapedFromReceipt)).toBe(true);

    const outcome = classifyLineOutcome({
      status: "CONFIRMED",
      disposition: "INVENTORY",
      hasPackageMismatch: false,
      receivingReady: receivingLineIsReady(draftShapedFromReceipt),
    });
    expect(outcome).toBe("ready");
  });
});

describe("test 14: the amendment already-posted notice's own check", () => {
  it("is false for a normal (non-amended, or amended-but-not-yet-posted) document", async () => {
    const runTag = randomUUID().slice(0, 8);
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
      lines: [{ vendorSku: `NOPOST-${runTag}`, description: `No Post Yet ${runTag}` }],
    });
    expect(await hasSiblingRevisionAlreadyPosted(fx.supabase, purchaseDocumentId, fx.organizationId)).toBe(false);
  });

  it("becomes true once a sibling revision in the same amendment lineage has posted inventory", async () => {
    const runTag = randomUUID().slice(0, 8);
    const verified = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: `Redesign Already-Posted Test ${runTag}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 4, receivedUnit: "PIECE" } },
    ]);
    expect(await hasSiblingRevisionAlreadyPosted(fx.supabase, verified.purchaseDocumentId, fx.organizationId)).toBe(false);

    await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: verified.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });

    const amendment = await initiateAmendmentRpc(fx.supabase, {
      purchaseDocumentId: verified.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      reason: "UAT: redesign already-posted notice test",
    });

    expect(await hasSiblingRevisionAlreadyPosted(fx.supabase, amendment.purchaseDocumentId, fx.organizationId)).toBe(true);
    // The ORIGINAL (already-posted) revision itself has no OTHER sibling
    // that posted -- the check is specifically "some OTHER revision,"
    // never flagging a document against its own posting.
    expect(await hasSiblingRevisionAlreadyPosted(fx.supabase, verified.purchaseDocumentId, fx.organizationId)).toBe(false);
  });
});
