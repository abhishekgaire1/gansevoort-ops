import { beforeAll, describe, expect, it } from "vitest";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { InventoryPostingBlockedError, type InventoryPostingBlocker } from "@/app/lib/inventory/errors";
import { VerifiedLockedError } from "@/app/lib/purchaseDocuments/errors";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, confirmAllCurrentLinesNonInventory } from "./itemMasterTestHelpers";
import { createVerifiedPostingDocument, getPostingStatus, getLocationBalance, getCurrentReference } from "./inventoryPostingTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Milestone 2A.4: the first REAL inbound inventory posting path
 * (post_purchase_document_inventory, 20260811100064). Proves the whole
 * contract: only a VERIFIED document posts, only via the explicit posting
 * RPC (receiving alone never increases inventory), always in the item's
 * BASE unit via the same measurement trigger withdrawals trust, with
 * durable receipt-line-level idempotency and posting status derived from
 * actual posting records.
 */

let fx: RpcTestFixtures;
let locationId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
});

describe("posting eligibility -- document status", () => {
  it("a DRAFT document cannot post", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    });
    await expect(
      postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId })
    ).rejects.toThrow(VerifiedLockedError);
  });

  it("a READY_FOR_VERIFICATION document cannot post -- Final Verify alone never posts either", async () => {
    const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: fx.organizationId,
      vendorId: fx.vendorId,
      uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    });
    await confirmAllCurrentLinesNonInventory(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, purchaseDocumentId);
    await submitPurchaseDocumentForVerificationRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      expectedVersion: 1,
    });
    await expect(
      postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId })
    ).rejects.toThrow(VerifiedLockedError);
  });
});

describe("posting quantities -- always the item's BASE inventory unit", () => {
  it("SAME_UNIT: 72 PIECE received posts +72 PIECE; receipt existence alone was NOT posted status", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Heavy Cream", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 72, receivedUnit: "PIECE" } },
    ]);

    // VERIFIED + fully received, but NOT posted -- receiving alone has no
    // inventory authority.
    const before = await getPostingStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(before.status).toBe("NOT_POSTED");
    expect(await getLocationBalance(fx.supabase, fx.organizationId, doc.itemIds[0]!, locationId)).toBeNull();

    const result = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(result.status).toBe("POSTED");
    expect(result.postedLineCount).toBe(1);
    expect(result.movementCount).toBe(1);

    const { data: postingLines } = await fx.supabase
      .from("purchase_document_inventory_posting_lines")
      .select("posted_base_quantity, location_id, inventory_item_id, movement_id")
      .eq("posting_id", result.postingId!);
    expect(postingLines).toHaveLength(1);
    expect(Number(postingLines![0].posted_base_quantity)).toBe(72);
    expect(postingLines![0].location_id).toBe(locationId);

    const { data: movement } = await fx.supabase
      .from("inventory_movements")
      .select("movement_type, location_id, performed_by_app_user_id, station_id")
      .eq("id", postingLines![0].movement_id as string)
      .single();
    expect(movement!.movement_type).toBe("PURCHASE_RECEIPT");
    expect(movement!.location_id).toBe(locationId);
    expect(movement!.performed_by_app_user_id).toBe(fx.changeableEmployeeAppUserId);
    expect(movement!.station_id).toBeNull();

    expect(await getLocationBalance(fx.supabase, fx.organizationId, doc.itemIds[0]!, locationId)).toBe(72);

    const after = await getPostingStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(after.status).toBe("POSTED");
    expect(after.postedLineCount).toBe(1);

    // Restock sets the POST-restock balance as the new 100% reference.
    const reference = await getCurrentReference(fx.supabase, fx.organizationId, doc.itemIds[0]!, locationId);
    expect(reference).toEqual({ fullQuantity: 72, source: "RESTOCK" });
  });

  it("FIXED_CONVERSION: 2 CASE at 1 CASE = 10 LB posts +20 LB (derived from the confirmed conversion, never the client)", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: "Sour Cream",
        receiving: {
          behavior: "FIXED_CONVERSION",
          baseUnitCode: "LB",
          purchaseUnitCode: "CASE",
          fixedConversionFactor: 10,
          receivedQuantity: 2,
          receivedUnit: "CASE",
          verifiedBaseQuantity: 20,
        },
      },
    ]);

    const result = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(result.status).toBe("POSTED");

    const { data: lines } = await fx.supabase
      .from("purchase_document_inventory_posting_lines")
      .select("posted_base_quantity, movement_line_id, units(code)")
      .eq("posting_id", result.postingId!);
    expect(Number(lines![0].posted_base_quantity)).toBe(20);
    const unit = Array.isArray(lines![0].units) ? lines![0].units[0] : lines![0].units;
    expect(unit!.code).toBe("LB");

    // The movement line's normalized quantity is the ledger truth -- the
    // measurement trigger recomputed it from the item's CURRENT factor.
    const { data: movementLine } = await fx.supabase
      .from("inventory_movement_lines")
      .select("entered_quantity, normalized_base_quantity, measured_base_quantity")
      .eq("id", lines![0].movement_line_id as string)
      .single();
    expect(Number(movementLine!.entered_quantity)).toBe(2);
    expect(Number(movementLine!.normalized_base_quantity)).toBe(20);
    expect(movementLine!.measured_base_quantity).toBeNull();

    expect(await getLocationBalance(fx.supabase, fx.organizationId, doc.itemIds[0]!, locationId)).toBe(20);
  });

  it("MEASURE_EACH_DELIVERY: 1 BOX with verified weight 38.6 posts +38.6 LB (the manager-confirmed actual), never +1 BOX", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: "Korean Radish",
        receiving: {
          behavior: "MEASURE_EACH_DELIVERY",
          baseUnitCode: "LB",
          purchaseUnitCode: "BOX",
          receivedQuantity: 1,
          receivedUnit: "BOX",
          verifiedBaseQuantity: 38.6,
        },
      },
    ]);

    const result = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(result.status).toBe("POSTED");

    const { data: lines } = await fx.supabase
      .from("purchase_document_inventory_posting_lines")
      .select("posted_base_quantity, movement_line_id")
      .eq("posting_id", result.postingId!);
    expect(Number(lines![0].posted_base_quantity)).toBe(38.6);

    const { data: movementLine } = await fx.supabase
      .from("inventory_movement_lines")
      .select("entered_quantity, measured_base_quantity, normalized_base_quantity")
      .eq("id", lines![0].movement_line_id as string)
      .single();
    expect(Number(movementLine!.entered_quantity)).toBe(1); // the BOX count is preserved as entered
    expect(Number(movementLine!.measured_base_quantity)).toBe(38.6);
    expect(Number(movementLine!.normalized_base_quantity)).toBe(38.6); // ledger truth is the measured base qty

    expect(await getLocationBalance(fx.supabase, fx.organizationId, doc.itemIds[0]!, locationId)).toBe(38.6);
  });

  it("a NON_INVENTORY line never creates a movement and never counts toward posting status", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Inv Item", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 5, receivedUnit: "PIECE" } },
      { description: "Fuel Surcharge", receiving: null },
    ]);

    const status = await getPostingStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(status.requiredLineCount).toBe(1); // only the inventory line

    const result = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(result.postedLineCount).toBe(1);

    const after = await getPostingStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(after.status).toBe("POSTED");
  });
});

describe("posting idempotency", () => {
  it("a second post is ALREADY_POSTED -- no duplicate movements, balance unchanged", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Idem Item", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 10, receivedUnit: "PIECE" } },
    ]);

    const first = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(first.status).toBe("POSTED");

    const second = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(second.status).toBe("ALREADY_POSTED");
    expect(second.postingId).toBe(first.postingId);
    expect(second.postedLineCount).toBe(0);

    expect(await getLocationBalance(fx.supabase, fx.organizationId, doc.itemIds[0]!, locationId)).toBe(10); // never 20

    const { count } = await fx.supabase
      .from("purchase_document_inventory_postings")
      .select("id", { count: "exact", head: true })
      .eq("purchase_document_id", doc.purchaseDocumentId);
    expect(count).toBe(1);
  });

  it("two CONCURRENT posts converge on exactly one posting -- inventory is never doubled", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Race Item", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 7, receivedUnit: "PIECE" } },
    ]);

    const [a, b] = await Promise.all([
      postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId }),
      postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["ALREADY_POSTED", "POSTED"]);

    expect(await getLocationBalance(fx.supabase, fx.organizationId, doc.itemIds[0]!, locationId)).toBe(7);

    const { count: postingLineCount } = await fx.supabase
      .from("purchase_document_inventory_posting_lines")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .in("posting_id", [a.postingId, b.postingId].filter((id): id is string => id !== null));
    expect(postingLineCount).toBe(1);
  });
});

describe("posting blockers -- atomic all-or-nothing with exact reasons", () => {
  it("an additional delivery line missing its storage location blocks the next posting with the exact reason, and nothing partial is written", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "First Wave", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 12, receivedUnit: "PIECE" } },
    ]);
    await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    // Record Additional Delivery (legitimate on VERIFIED), but without a
    // storage location -- the unposted line makes status PARTIALLY_POSTED
    // and blocks the next post until resolved.
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: doc.purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: doc.lineKeys[0],
          vendorSkuSnapshot: "POST-EXTRA",
          descriptionSnapshot: "First Wave -- additional",
          invoicePackageQuantity: null,
          invoicePackageUnit: null,
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 6,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId: null,
        },
      ],
    });

    const midStatus = await getPostingStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(midStatus.status).toBe("PARTIALLY_POSTED");

    let caught: unknown;
    try {
      await postPurchaseDocumentInventoryRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InventoryPostingBlockedError);
    const blockers = (caught as InventoryPostingBlockedError).blockers;
    expect(blockers.some((b: InventoryPostingBlocker) => /storage location is missing/.test(b.reason))).toBe(true);

    // Nothing partial: balance still only the first wave.
    expect(await getLocationBalance(fx.supabase, fx.organizationId, doc.itemIds[0]!, locationId)).toBe(12);
  });

  it("a MEASURE_EACH_DELIVERY additional delivery without its verified measurement blocks with the exact reason", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      {
        description: "Variable Weight",
        receiving: { behavior: "MEASURE_EACH_DELIVERY", baseUnitCode: "LB", purchaseUnitCode: "BOX", receivedQuantity: 1, receivedUnit: "BOX", verifiedBaseQuantity: 20.5 },
      },
    ]);
    await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: doc.purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: doc.lineKeys[0],
          vendorSkuSnapshot: "POST-EXTRA-MEASURE",
          descriptionSnapshot: "Variable Weight -- additional",
          invoicePackageQuantity: null,
          invoicePackageUnit: null,
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 1,
          actualReceivedPackageUnit: "BOX",
          actualVerifiedBaseQuantity: null, // never weighed
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });

    let caught: unknown;
    try {
      await postPurchaseDocumentInventoryRpc(fx.supabase, {
        purchaseDocumentId: doc.purchaseDocumentId,
        organizationId: fx.organizationId,
        appUserId: fx.changeableEmployeeAppUserId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InventoryPostingBlockedError);
    expect((caught as InventoryPostingBlockedError).blockers.some((b) => /verified measurement is required/.test(b.reason))).toBe(true);
  });

  it("an additional-delivery receipt line matched to no CONFIRMED INVENTORY classification is posting-irrelevant: excluded from required, never blocking, never a movement", async () => {
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Anchor Item", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 3, receivedUnit: "PIECE" } },
    ]);
    await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: doc.purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 99,
          matchedLineKey: crypto.randomUUID(), // matches no classification
          vendorSkuSnapshot: "UNMATCHED",
          descriptionSnapshot: "Unclassified stray line",
          invoicePackageQuantity: null,
          invoicePackageUnit: null,
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 4,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });

    const status = await getPostingStatus(fx.supabase, doc.purchaseDocumentId, fx.organizationId);
    expect(status.status).toBe("POSTED"); // stray unresolved line is not a required inventory line
    expect(status.requiredLineCount).toBe(1);

    const second = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(second.status).toBe("ALREADY_POSTED"); // nothing new was postable
    expect(await getLocationBalance(fx.supabase, fx.organizationId, doc.itemIds[0]!, locationId)).toBe(3);
  });
});
