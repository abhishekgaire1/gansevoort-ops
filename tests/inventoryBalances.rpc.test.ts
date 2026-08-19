import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { postPurchaseDocumentInventoryRpc, setInventoryStockReferenceRpc } from "@/app/lib/inventory/postingRpcs";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument, getLocationBalance, getCurrentReference } from "./inventoryPostingTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Milestone 2A.4: item+location balances derived from the append-only
 * ledger (inventory_location_balances -- no mutable current-quantity
 * column exists anywhere), and the full-stock-reference behavior: every
 * genuine restock sets the POST-restock balance as the new 100%;
 * withdrawals change current quantity only; a manager override changes
 * only the visualization denominator and is superseded by the next
 * restock; references are item+location isolated.
 */

let fx: RpcTestFixtures;
let locationId: string;
let pieceUnitId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;
  const { data: pieceUnit } = await fx.supabase.from("units").select("id").eq("code", "PIECE").single();
  pieceUnitId = pieceUnit!.id as string;
});

async function withdraw(itemId: string, quantity: number): Promise<void> {
  // Deliberately the OTHER station -- NEVER (stationId,
  // changeableEmployee), which withdrawal.rpc.test.ts uses as its
  // movement-COUNTING key for its own idempotency assertions; these files
  // run concurrently and must not perturb each other's counts. (The
  // locked employee can't be used instead: it is station-restricted by
  // design.)
  const { error } = await fx.supabase.rpc("record_inventory_withdrawal", {
    p_performed_by_app_user_id: fx.changeableEmployeeAppUserId,
    p_station_id: fx.otherStationId,
    p_source_location_id: locationId,
    p_inventory_item_id: itemId,
    p_entered_quantity: String(quantity),
    p_entered_unit_id: pieceUnitId,
    p_measured_base_quantity: null,
    p_notes: null,
    p_client_request_id: randomUUID(),
  });
  if (error) throw new Error(error.message);
}

async function postedPieceItem(quantity: number): Promise<{ itemId: string; purchaseDocumentId: string }> {
  const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
    { description: `Balance Item ${randomUUID().slice(0, 6)}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: quantity, receivedUnit: "PIECE" } },
  ]);
  await postPurchaseDocumentInventoryRpc(fx.supabase, {
    purchaseDocumentId: doc.purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
  });
  return { itemId: doc.itemIds[0]!, purchaseDocumentId: doc.purchaseDocumentId };
}

describe("balances derive from the ledger", () => {
  it("inbound increases the balance; a kiosk withdrawal decreases it; the reference does NOT change on withdrawal", async () => {
    const { itemId } = await postedPieceItem(72);
    expect(await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId)).toBe(72);

    await withdraw(itemId, 18);
    expect(await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId)).toBe(54);

    // Full reference is untouched by outbound movements -- 54/72 = 75%.
    const reference = await getCurrentReference(fx.supabase, fx.organizationId, itemId, locationId);
    expect(reference).toEqual({ fullQuantity: 72, source: "RESTOCK" });
  });

  it("multiple movements sum correctly, and item isolation holds", async () => {
    const a = await postedPieceItem(30);
    const b = await postedPieceItem(50);

    await withdraw(a.itemId, 5);
    await withdraw(a.itemId, 7);

    expect(await getLocationBalance(fx.supabase, fx.organizationId, a.itemId, locationId)).toBe(18); // 30 - 5 - 7
    expect(await getLocationBalance(fx.supabase, fx.organizationId, b.itemId, locationId)).toBe(50); // untouched
  });

  it("a restock while stock remains sets the POST-restock balance (existing + delivered) as the new 100% -- never just the delivery quantity", async () => {
    // First delivery 60 -> reference 60. Withdraw to 12. Second delivery
    // +60 -> post-restock balance 72 -> reference 72 (not 60).
    const first = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: `Restock Item ${randomUUID().slice(0, 6)}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 60, receivedUnit: "PIECE" } },
    ]);
    await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: first.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    const itemId = first.itemIds[0]!;
    expect(await getCurrentReference(fx.supabase, fx.organizationId, itemId, locationId)).toEqual({ fullQuantity: 60, source: "RESTOCK" });

    await withdraw(itemId, 48); // down to 12

    // Second delivery of the SAME canonical item -- an additional
    // append-only DELIVERY receipt on the same document, then a second
    // posting: identical inbound semantics to a fresh invoice mapped to
    // the existing item.
    const { recordReceiptRpc } = await import("@/app/lib/receiving/recordReceiptRpc");
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: first.purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: first.lineKeys[0],
          vendorSkuSnapshot: "RESTOCK-2",
          descriptionSnapshot: "Second wave",
          invoicePackageQuantity: null,
          invoicePackageUnit: null,
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 60,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });
    const secondPost = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: first.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(secondPost.status).toBe("POSTED");

    expect(await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId)).toBe(72); // 12 + 60
    expect(await getCurrentReference(fx.supabase, fx.organizationId, itemId, locationId)).toEqual({ fullQuantity: 72, source: "RESTOCK" });
  });
});

describe("manager full-reference override", () => {
  it("changes ONLY the reference -- no movement created, balance unchanged -- and the next restock supersedes it", async () => {
    const { itemId, purchaseDocumentId } = await postedPieceItem(42);
    // Item-scoped movement count (never org-wide -- other concurrently
    // running test files legitimately create their own movements).
    const { count: movementsBefore } = await fx.supabase
      .from("inventory_movement_lines")
      .select("id", { count: "exact", head: true })
      .eq("inventory_item_id", itemId);

    await setInventoryStockReferenceRpc(fx.supabase, {
      organizationId: fx.organizationId,
      inventoryItemId: itemId,
      locationId,
      fullQuantity: 80,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    expect(await getCurrentReference(fx.supabase, fx.organizationId, itemId, locationId)).toEqual({ fullQuantity: 80, source: "MANAGER_OVERRIDE" });
    expect(await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId)).toBe(42); // untouched

    const { count: movementsAfter } = await fx.supabase
      .from("inventory_movement_lines")
      .select("id", { count: "exact", head: true })
      .eq("inventory_item_id", itemId);
    expect(movementsAfter).toBe(movementsBefore); // an override NEVER creates a movement

    // Next genuine restock supersedes the manual override with the
    // post-restock balance.
    const { recordReceiptRpc } = await import("@/app/lib/receiving/recordReceiptRpc");
    const { data: postedLine } = await fx.supabase
      .from("purchase_document_inventory_posting_lines")
      .select("receipt_line_id, receipt_lines(matched_line_key)")
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", itemId)
      .limit(1)
      .single();
    const receiptLineJoin = Array.isArray(postedLine!.receipt_lines) ? postedLine!.receipt_lines[0] : postedLine!.receipt_lines;
    const matchedLineKey = receiptLineJoin!.matched_line_key as string;

    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey,
          vendorSkuSnapshot: "OVERRIDE-RESTOCK",
          descriptionSnapshot: "Post-override restock",
          invoicePackageQuantity: null,
          invoicePackageUnit: null,
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 40,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId,
        },
      ],
    });
    await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });

    expect(await getLocationBalance(fx.supabase, fx.organizationId, itemId, locationId)).toBe(82); // 42 + 40
    expect(await getCurrentReference(fx.supabase, fx.organizationId, itemId, locationId)).toEqual({ fullQuantity: 82, source: "RESTOCK" });
  });

  it("references are item+location isolated: a restock into location A never touches location B's reference", async () => {
    // A second, stably-named location in the TEST org.
    const { data: existingLocB } = await fx.supabase
      .from("locations")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .eq("name", "TEST RPC Fixture Location B")
      .maybeSingle();
    let locationBId: string;
    if (existingLocB) {
      locationBId = existingLocB.id as string;
    } else {
      const { data: created, error } = await fx.supabase
        .from("locations")
        // is_storage_eligible explicit, never relying on the (now false) DB
        // default -- 20260811100073.
        .insert({ organization_id: fx.organizationId, name: "TEST RPC Fixture Location B", timezone: "America/New_York", is_storage_eligible: true })
        .select("id")
        .single();
      if (error) throw error;
      locationBId = created!.id as string;
    }

    // One document, one item, two receipt lines split across locations.
    const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: `Two-Loc Item ${randomUUID().slice(0, 6)}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 20, receivedUnit: "PIECE" } },
    ]);
    const itemId = doc.itemIds[0]!;
    // Additional delivery of the same item into location B before posting.
    const { recordReceiptRpc } = await import("@/app/lib/receiving/recordReceiptRpc");
    await recordReceiptRpc(fx.supabase, {
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
      receiptKind: "DELIVERY",
      purchaseDocumentId: doc.purchaseDocumentId,
      lines: [
        {
          lineNumberSnapshot: 1,
          matchedLineKey: doc.lineKeys[0],
          vendorSkuSnapshot: "TWO-LOC",
          descriptionSnapshot: "Location B share",
          invoicePackageQuantity: null,
          invoicePackageUnit: null,
          invoiceMeasuredQuantity: null,
          invoiceMeasuredUnit: null,
          actualReceivedPackageQuantity: 10,
          actualReceivedPackageUnit: "PIECE",
          actualVerifiedBaseQuantity: null,
          actualVerifiedBaseUnitId: null,
          locationId: locationBId,
        },
      ],
    });
    const posted = await postPurchaseDocumentInventoryRpc(fx.supabase, {
      purchaseDocumentId: doc.purchaseDocumentId,
      organizationId: fx.organizationId,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(posted.movementCount).toBe(2); // one movement per storage location

    expect(await getCurrentReference(fx.supabase, fx.organizationId, itemId, locationId)).toEqual({ fullQuantity: 20, source: "RESTOCK" });
    expect(await getCurrentReference(fx.supabase, fx.organizationId, itemId, locationBId)).toEqual({ fullQuantity: 10, source: "RESTOCK" });

    // Manager overrides ONLY location B; location A's reference is untouched.
    await setInventoryStockReferenceRpc(fx.supabase, {
      organizationId: fx.organizationId,
      inventoryItemId: itemId,
      locationId: locationBId,
      fullQuantity: 25,
      appUserId: fx.changeableEmployeeAppUserId,
    });
    expect(await getCurrentReference(fx.supabase, fx.organizationId, itemId, locationBId)).toEqual({ fullQuantity: 25, source: "MANAGER_OVERRIDE" });
    expect(await getCurrentReference(fx.supabase, fx.organizationId, itemId, locationId)).toEqual({ fullQuantity: 20, source: "RESTOCK" });
  });
});
