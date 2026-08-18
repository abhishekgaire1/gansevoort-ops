import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { applyReceivingEdits, getEffectiveReceivingLines } from "@/app/lib/receiving/effectiveReceivingEdit";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { getPreparationStatus } from "@/app/lib/purchaseDocuments/getPreparationStatus";
import { getPurchaseDocumentReviewSummary } from "@/app/lib/purchaseDocuments/getReviewSummary";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * DRAFT-editability workflow correction: Edit Receiving applies manager
 * edits as APPEND-ONLY receipt corrections (original receipts preserved,
 * corrections become the effective state), and getPreparationStatus flags
 * a recorded line whose facts no longer agree with the item's CURRENT
 * configuration (e.g. Manager 1 remapped the item or its conversion
 * changed on Step 2 after receiving) as needing re-confirmation -- per
 * line, never invalidating unrelated lines.
 */

let fx: RpcTestFixtures;
let categoryId: string;
let spendCategoryId: string;
let locationId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: item } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  categoryId = item!.category_id as string;
  spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
});

/** DRAFT doc with two CONFIRMED INVENTORY lines -- one FIXED_CONVERSION
 * (CASE -> LB, factor 10), one SAME_UNIT (PIECE) -- fully received in one
 * DELIVERY receipt. */
async function draftWithReceivedLines(): Promise<{
  purchaseDocumentId: string;
  fixedLineKey: string;
  pieceLineKey: string;
  fixedItemId: string;
  receiptId: string;
}> {
  const tag = randomUUID().slice(0, 8);
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [
      { vendorSku: `EDIT-F-${tag}`, description: "Edit Fixed Item", packageUnit: "CASE", packageQuantity: 2 },
      { vendorSku: `EDIT-P-${tag}`, description: "Edit Piece Item", packageUnit: "PIECE", packageQuantity: 5 },
    ],
  });
  const [fixedLineKey, pieceLineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);

  const fixedApproval = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey: fixedLineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Edit Fixed ${tag}`,
    disposition: "INVENTORY",
    categoryId,
    spendCategoryId,
    baseUnitCode: "LB",
    purchaseUnitCode: "CASE",
    receivingBehavior: "FIXED_CONVERSION",
    fixedConversionFactor: 10,
    rememberVendorMapping: false,
  });
  await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey: pieceLineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Edit Piece ${tag}`,
    disposition: "INVENTORY",
    categoryId,
    spendCategoryId,
    baseUnitCode: "PIECE",
    rememberVendorMapping: false,
  });

  const receipt = await recordReceiptRpc(fx.supabase, {
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    receiptKind: "DELIVERY",
    purchaseDocumentId,
    lines: [
      {
        lineNumberSnapshot: 1,
        matchedLineKey: fixedLineKey,
        vendorSkuSnapshot: `EDIT-F-${tag}`,
        descriptionSnapshot: "Edit Fixed Item",
        invoicePackageQuantity: 2,
        invoicePackageUnit: "CASE",
        invoiceMeasuredQuantity: null,
        invoiceMeasuredUnit: null,
        actualReceivedPackageQuantity: 2,
        actualReceivedPackageUnit: "CASE",
        actualVerifiedBaseQuantity: 20,
        actualVerifiedBaseUnitId: null,
        locationId,
      },
      {
        lineNumberSnapshot: 2,
        matchedLineKey: pieceLineKey,
        vendorSkuSnapshot: `EDIT-P-${tag}`,
        descriptionSnapshot: "Edit Piece Item",
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

  return { purchaseDocumentId, fixedLineKey, pieceLineKey, fixedItemId: fixedApproval.inventoryItemId, receiptId: receipt.receiptId };
}

describe("Edit Receiving -- append-only corrections", () => {
  it("an edit preserves the original receipt, supersedes it with a correction, copies untouched lines verbatim, and the corrected value becomes effective everywhere", async () => {
    const doc = await draftWithReceivedLines();

    const before = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const fixedBefore = before.find((l) => l.matchedLineKey === doc.fixedLineKey)!;
    expect(fixedBefore.receivedQuantity).toBe(2);

    // Manager corrects 2 CASE -> 1 CASE (verified re-derived to 10 LB).
    const result = await applyReceivingEdits(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId: doc.purchaseDocumentId,
      editSessionKey: randomUUID(),
      edits: [
        {
          receiptLineId: fixedBefore.receiptLineId,
          receivedQuantity: 1,
          receivedUnit: "CASE",
          verifiedBaseQuantity: 10,
          locationId,
          conditionStatus: "SHORT",
        },
      ],
    });
    expect(result.correctedReceiptIds).toEqual([doc.receiptId]);

    // Original receipt row still exists, untouched, but superseded.
    const { data: original } = await fx.supabase.from("receipts").select("id, receipt_kind").eq("id", doc.receiptId).single();
    expect(original!.receipt_kind).toBe("DELIVERY");
    const { data: originalLines } = await fx.supabase
      .from("receipt_lines")
      .select("actual_received_package_quantity")
      .eq("receipt_id", doc.receiptId)
      .eq("matched_line_key", doc.fixedLineKey);
    expect(Number(originalLines![0].actual_received_package_quantity)).toBe(2); // history preserved verbatim

    // The correction is now the effective state: corrected line updated,
    // untouched line copied through.
    const after = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const fixedAfter = after.find((l) => l.matchedLineKey === doc.fixedLineKey)!;
    const pieceAfter = after.find((l) => l.matchedLineKey === doc.pieceLineKey)!;
    expect(fixedAfter.receiptId).not.toBe(doc.receiptId);
    expect(fixedAfter.receivedQuantity).toBe(1);
    expect(fixedAfter.verifiedBaseQuantity).toBe(10);
    expect(fixedAfter.conditionStatus).toBe("SHORT");
    expect(pieceAfter.receivedQuantity).toBe(5); // never dropped, never altered
    expect(pieceAfter.receiptId).toBe(fixedAfter.receiptId); // carried on the same correction

    // Step 4's summary reflects the corrected effective receipt.
    const summary = await getPurchaseDocumentReviewSummary(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const summaryLine = summary.receiving.find((r) => r.lineKey === doc.fixedLineKey)!;
    expect(summaryLine.receivedQuantity).toBe(1);
    expect(summaryLine.inventoryQuantity).toBe(10);

    // Receiving completeness survives the correction.
    const status = await getPreparationStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(status.receivingComplete).toBe(true);
  });

  it("a retried save with the SAME edit session converges on the same correction -- no duplicate corrections, no branching", async () => {
    const doc = await draftWithReceivedLines();
    const lines = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const target = lines.find((l) => l.matchedLineKey === doc.pieceLineKey)!;
    const editSessionKey = randomUUID();
    const edit = {
      receiptLineId: target.receiptLineId,
      receivedQuantity: 4,
      receivedUnit: "PIECE",
      verifiedBaseQuantity: null,
      locationId,
      conditionStatus: "SHORT" as const,
    };

    const first = await applyReceivingEdits(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId: doc.purchaseDocumentId,
      editSessionKey,
      edits: [edit],
    });
    const second = await applyReceivingEdits(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId: doc.purchaseDocumentId,
      editSessionKey,
      edits: [edit],
    });
    expect(first.correctedReceiptIds).toEqual([doc.receiptId]);
    // The retry targets the ORIGINAL effective lines snapshot no longer
    // present (the correction superseded them), so it must not create a
    // second correction: the idempotency key replay inside record_receipt
    // (and the one-correction-per-receipt uniqueness) guarantee it.
    void second;
    const { count } = await fx.supabase
      .from("receipts")
      .select("id", { count: "exact", head: true })
      .eq("purchase_document_id", doc.purchaseDocumentId)
      .eq("receipt_kind", "CORRECTION");
    expect(count).toBe(1);
  });
});

describe("downstream invalidation after item changes", () => {
  it("changing the item's conversion factor after receiving flags THAT line as needing review -- the unrelated line stays complete -- and re-confirming via an edit clears it", async () => {
    const doc = await draftWithReceivedLines();

    let status = await getPreparationStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(status.receivingComplete).toBe(true);

    // Simulate Step 2's item-configuration change: the confirmed CASE
    // conversion moves from 10 -> 12 LB after the delivery was recorded.
    const { data: caseUnit } = await fx.supabase.from("units").select("id").eq("code", "CASE").single();
    const { error: updateError } = await fx.supabase
      .from("inventory_item_units")
      .update({ conversion_factor: 12 })
      .eq("inventory_item_id", doc.fixedItemId)
      .eq("unit_id", caseUnit!.id as string);
    expect(updateError).toBeNull();

    status = await getPreparationStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(status.receivingComplete).toBe(false);
    const lineBlockers = status.blockers.filter((b) => b.lineKey !== null);
    expect(lineBlockers).toHaveLength(1); // ONLY the affected line
    expect(lineBlockers[0].lineKey).toBe(doc.fixedLineKey);
    expect(lineBlockers[0].reason).toMatch(/needs review.*configuration changed/i);

    // Re-confirming through Edit Receiving under the NEW configuration
    // (2 CASE -> 24 LB) restores completeness -- record_receipt
    // re-validates the math server-side.
    const lines = await getEffectiveReceivingLines(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    const target = lines.find((l) => l.matchedLineKey === doc.fixedLineKey)!;
    await applyReceivingEdits(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      purchaseDocumentId: doc.purchaseDocumentId,
      editSessionKey: randomUUID(),
      edits: [
        {
          receiptLineId: target.receiptLineId,
          receivedQuantity: 2,
          receivedUnit: "CASE",
          verifiedBaseQuantity: 24,
          locationId,
          conditionStatus: "RECEIVED_AS_INVOICED",
        },
      ],
    });

    status = await getPreparationStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(status.receivingComplete).toBe(true);
  });

  it("remapping a received line to a different canonical item whose configuration doesn't include the received unit flags that line for review", async () => {
    const doc = await draftWithReceivedLines();

    // Manager 1 uses Edit Mapping on Step 2: the CASE-received line is
    // remapped to a PIECE-based item with no CASE unit at all.
    await approveLineClassificationExistingItemRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      lineKey: doc.fixedLineKey,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      inventoryItemId: fx.noRuleItemId, // PIECE-only fixture item
      rememberVendorMapping: false,
    });

    const status = await getPreparationStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(status.receivingComplete).toBe(false);
    const lineBlockers = status.blockers.filter((b) => b.lineKey !== null);
    expect(lineBlockers).toHaveLength(1);
    expect(lineBlockers[0].lineKey).toBe(doc.fixedLineKey);
    expect(lineBlockers[0].reason).toMatch(/configuration changed/i);
  });
});
