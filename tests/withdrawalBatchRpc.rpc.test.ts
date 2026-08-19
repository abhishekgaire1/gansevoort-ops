import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { recordInventoryWithdrawalBatch } from "@/app/lib/inventory/withdrawalBatch";
import { listEmployeeRecentWithdrawnItemIds } from "@/app/lib/kiosk/recentItems";
import { BatchInsufficientInventoryError } from "@/app/lib/inventory/errors";
import { getKioskItemAvailability } from "@/app/lib/kiosk/stockAvailability";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Milestone 2A.5 multi-item withdrawal cart -- the atomic batch RPC
 * (20260811100079_withdrawal_batches.sql). Covers exactly what's new:
 * one-item and multi-item/multi-location batches, all-or-nothing rollback
 * on any short line, concurrency safety, batch-level idempotency
 * (replay/mismatch/reordering), actor/station mismatch rejection,
 * HIGH_WITHDRAWAL staying non-blocking, org isolation, and that
 * successfully committed batch lines are visible through the existing
 * Recent-items mechanism. The single-item record_inventory_withdrawal RPC
 * is unchanged and already covered by sourceAwareWithdrawal.rpc.test.ts.
 */

let fx: RpcTestFixtures;
let locationA: string;
let locationB: string;

async function createConfirmedPieceItem(): Promise<{ inventoryItemId: string; baseUnitId: string }> {
  const tag = randomUUID().slice(0, 8);
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: categoryRow } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `BATCH-${tag}`, description: `Batch Test Item ${tag}`, packageUnit: "PIECE", packageQuantity: 1 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  const result = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Batch Item ${tag}`,
    disposition: "INVENTORY",
    categoryId: categoryRow!.category_id as string,
    spendCategoryId,
    baseUnitCode: "PIECE",
    rememberVendorMapping: false,
  });
  const { data: item } = await fx.supabase.from("inventory_items").select("base_unit_id").eq("id", result.inventoryItemId).single();
  return { inventoryItemId: result.inventoryItemId, baseUnitId: item!.base_unit_id as string };
}

async function receiveExact(inventoryItemId: string, baseUnitId: string, locationId: string, quantity: number): Promise<void> {
  const { data: movement, error: movementError } = await fx.supabase
    .from("inventory_movements")
    .insert({
      organization_id: fx.organizationId,
      location_id: locationId,
      station_id: null,
      movement_type: "PURCHASE_RECEIPT",
      performed_by_app_user_id: fx.changeableEmployeeAppUserId,
      business_date: new Date().toISOString().slice(0, 10),
      client_request_id: randomUUID(),
    })
    .select("id")
    .single();
  if (movementError) throw movementError;
  const { error: lineError } = await fx.supabase
    .from("inventory_movement_lines")
    .insert({ movement_id: movement!.id, inventory_item_id: inventoryItemId, entered_quantity: quantity, entered_unit_id: baseUnitId });
  if (lineError) throw lineError;
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: locations } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1);
  locationA = locations![0].id as string;

  const tag = randomUUID().slice(0, 8);
  const { data: createdB } = await fx.supabase
    .from("locations")
    .insert({ organization_id: fx.organizationId, name: `TEST Batch Location B ${tag}`, timezone: "America/New_York", is_storage_eligible: true })
    .select("id")
    .single();
  locationB = createdB!.id as string;
});

describe("record_inventory_withdrawal_batch", () => {
  it("10. a one-item batch succeeds -- single item still works", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);

    const result = await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: randomUUID(),
      cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "12", enteredUnitId: item.baseUnitId }],
    });

    expect(result.replayed).toBe(false);
    expect(result.lines).toHaveLength(1);
    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(38);
  });

  it("11. several items from ONE source location produce ONE movement with multiple lines", async () => {
    const itemA = await createConfirmedPieceItem();
    const itemB = await createConfirmedPieceItem();
    await receiveExact(itemA.inventoryItemId, itemA.baseUnitId, locationA, 50);
    await receiveExact(itemB.inventoryItemId, itemB.baseUnitId, locationA, 50);

    const result = await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: randomUUID(),
      cartLines: [
        { inventoryItemId: itemA.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: itemA.baseUnitId },
        { inventoryItemId: itemB.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "7", enteredUnitId: itemB.baseUnitId },
      ],
    });

    expect(result.lines).toHaveLength(2);
    const movementIds = new Set(result.lines.map((l) => l.movementId));
    expect(movementIds.size).toBe(1); // one movement, two lines
  });

  it("12. items from MULTIPLE source locations create properly grouped, separate movements, all committed atomically", async () => {
    const itemA = await createConfirmedPieceItem();
    const itemB = await createConfirmedPieceItem();
    await receiveExact(itemA.inventoryItemId, itemA.baseUnitId, locationA, 50);
    await receiveExact(itemB.inventoryItemId, itemB.baseUnitId, locationB, 50);

    const result = await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: randomUUID(),
      cartLines: [
        { inventoryItemId: itemA.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: itemA.baseUnitId },
        { inventoryItemId: itemB.inventoryItemId, sourceLocationId: locationB, enteredQuantity: "7", enteredUnitId: itemB.baseUnitId },
      ],
    });

    expect(result.lines).toHaveLength(2);
    const movementIds = new Set(result.lines.map((l) => l.movementId));
    expect(movementIds.size).toBe(2); // one movement PER location

    const { data: movementRows } = await fx.supabase.from("inventory_movements").select("id, location_id, withdrawal_batch_id").in("id", Array.from(movementIds));
    expect(movementRows!.every((m) => m.withdrawal_batch_id === result.withdrawalBatchId)).toBe(true);
    expect(new Set(movementRows!.map((m) => m.location_id))).toEqual(new Set([locationA, locationB]));

    const afterA = await getKioskItemAvailability(fx.supabase, fx.organizationId, itemA.inventoryItemId);
    const afterB = await getKioskItemAvailability(fx.supabase, fx.organizationId, itemB.inventoryItemId);
    expect(afterA.find((l) => l.locationId === locationA)?.balance).toBe(45);
    expect(afterB.find((l) => l.locationId === locationB)?.balance).toBe(43);
  });

  it("14. ONE insufficient line rolls back the ENTIRE batch -- zero movements committed for any item", async () => {
    const itemA = await createConfirmedPieceItem();
    const itemB = await createConfirmedPieceItem();
    await receiveExact(itemA.inventoryItemId, itemA.baseUnitId, locationA, 50); // plenty
    await receiveExact(itemB.inventoryItemId, itemB.baseUnitId, locationB, 3); // not enough for the request below

    await expect(
      recordInventoryWithdrawalBatch(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        clientRequestId: randomUUID(),
        cartLines: [
          { inventoryItemId: itemA.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: itemA.baseUnitId },
          { inventoryItemId: itemB.inventoryItemId, sourceLocationId: locationB, enteredQuantity: "10", enteredUnitId: itemB.baseUnitId },
        ],
      })
    ).rejects.toBeInstanceOf(BatchInsufficientInventoryError);

    // Item A -- which had PLENTY of stock -- must be completely untouched.
    const afterA = await getKioskItemAvailability(fx.supabase, fx.organizationId, itemA.inventoryItemId);
    expect(afterA.find((l) => l.locationId === locationA)?.balance).toBe(50);
    const afterB = await getKioskItemAvailability(fx.supabase, fx.organizationId, itemB.inventoryItemId);
    expect(afterB.find((l) => l.locationId === locationB)?.balance).toBe(3);
  });

  it("the insufficient-line error identifies the exact short line (item, location, available, requested)", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 9);

    try {
      await recordInventoryWithdrawalBatch(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        clientRequestId: randomUUID(),
        cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "12", enteredUnitId: item.baseUnitId }],
      });
      expect.unreachable("expected BatchInsufficientInventoryError");
    } catch (err) {
      expect(err).toBeInstanceOf(BatchInsufficientInventoryError);
      const typed = err as BatchInsufficientInventoryError;
      expect(typed.lines).toEqual([{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, availableQuantity: 9, requestedQuantity: 12 }]);
    }
  });

  it("15. two concurrent overlapping batches for the same item/location can NEVER both succeed -- no oversubscription", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 15);

    const attempt = () =>
      recordInventoryWithdrawalBatch(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        clientRequestId: randomUUID(),
        cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "10", enteredUnitId: item.baseUnitId }],
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(5); // never negative
  });

  it("16. a batch spanning two locations never deadlocks against another concurrent batch touching the same two locations in reverse order", async () => {
    const itemA = await createConfirmedPieceItem();
    const itemB = await createConfirmedPieceItem();
    await receiveExact(itemA.inventoryItemId, itemA.baseUnitId, locationA, 100);
    await receiveExact(itemB.inventoryItemId, itemB.baseUnitId, locationB, 100);

    // Both batches touch the SAME two (item, location) pairs; only the
    // order they're listed in the cart differs -- the RPC's own
    // deterministic sorted lock acquisition (never payload order) is what
    // makes this safe. Both should complete (each takes a small slice).
    const first = recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: randomUUID(),
      cartLines: [
        { inventoryItemId: itemA.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "1", enteredUnitId: itemA.baseUnitId },
        { inventoryItemId: itemB.inventoryItemId, sourceLocationId: locationB, enteredQuantity: "1", enteredUnitId: itemB.baseUnitId },
      ],
    });
    const second = recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: randomUUID(),
      cartLines: [
        { inventoryItemId: itemB.inventoryItemId, sourceLocationId: locationB, enteredQuantity: "1", enteredUnitId: itemB.baseUnitId },
        { inventoryItemId: itemA.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "1", enteredUnitId: itemA.baseUnitId },
      ],
    });

    const results = await Promise.all([first, second]); // would hang/deadlock-error if lock ordering were payload-dependent
    expect(results).toHaveLength(2);
  });

  it("17. an exact idempotency replay (same request id, identical normalized cart) returns the SAME committed rows -- no duplicate batch or movements", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);
    const requestId = randomUUID();
    const input = {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: requestId,
      cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: item.baseUnitId }],
    };
    const first = await recordInventoryWithdrawalBatch(fx.supabase, input);
    const second = await recordInventoryWithdrawalBatch(fx.supabase, input);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.withdrawalBatchId).toBe(first.withdrawalBatchId);
    expect(second.lines[0].movementId).toBe(first.lines[0].movementId);

    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(45); // one withdrawal's worth, not two
  });

  it("18. the same request id reused with a CHANGED cart conflicts rather than silently replaying or extending the original", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);
    const requestId = randomUUID();

    await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: requestId,
      cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: item.baseUnitId }],
    });

    await expect(
      recordInventoryWithdrawalBatch(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        clientRequestId: requestId,
        cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "9", enteredUnitId: item.baseUnitId }], // different quantity
      })
    ).rejects.toThrow(/already used with a different withdrawal batch payload/);

    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(45); // only the ORIGINAL 5 ever committed
  });

  it("19. a reordered but otherwise identical cart under the same request id is still recognized as the identical idempotent request", async () => {
    const itemA = await createConfirmedPieceItem();
    const itemB = await createConfirmedPieceItem();
    await receiveExact(itemA.inventoryItemId, itemA.baseUnitId, locationA, 50);
    await receiveExact(itemB.inventoryItemId, itemB.baseUnitId, locationB, 50);
    const requestId = randomUUID();

    const first = await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: requestId,
      cartLines: [
        { inventoryItemId: itemA.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: itemA.baseUnitId },
        { inventoryItemId: itemB.inventoryItemId, sourceLocationId: locationB, enteredQuantity: "7", enteredUnitId: itemB.baseUnitId },
      ],
    });

    const second = await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: requestId,
      cartLines: [
        { inventoryItemId: itemB.inventoryItemId, sourceLocationId: locationB, enteredQuantity: "7", enteredUnitId: itemB.baseUnitId }, // reversed order
        { inventoryItemId: itemA.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: itemA.baseUnitId },
      ],
    });

    expect(second.replayed).toBe(true);
    expect(second.withdrawalBatchId).toBe(first.withdrawalBatchId);
  });

  it("20. the same request id reused by a DIFFERENT actor conflicts", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);
    const requestId = randomUUID();

    await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: requestId,
      cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: item.baseUnitId }],
    });

    await expect(
      recordInventoryWithdrawalBatch(fx.supabase, {
        performedByAppUserId: fx.mustPickEmployeeAppUserId, // different actor, same id
        stationId: fx.stationId,
        clientRequestId: requestId,
        cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: item.baseUnitId }],
      })
    ).rejects.toThrow(/already used by a different actor or station/);
  });

  it("21. the same request id reused by a DIFFERENT station conflicts", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);
    const requestId = randomUUID();

    await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: requestId,
      cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: item.baseUnitId }],
    });

    await expect(
      recordInventoryWithdrawalBatch(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.otherStationId, // different station, same id
        clientRequestId: requestId,
        cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: item.baseUnitId }],
      })
    ).rejects.toThrow(/already used by a different actor or station/);
  });

  it("22. HIGH_WITHDRAWAL remains non-blocking -- a large-but-available line both succeeds AND raises the exception", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 100);
    await fx.supabase.from("control_rules").insert({
      organization_id: fx.organizationId,
      inventory_item_id: item.inventoryItemId,
      rule_type: "HIGH_WITHDRAWAL",
      station_id: null,
      threshold_quantity: 10,
      is_active: true,
    });

    const result = await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: randomUUID(),
      cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "25", enteredUnitId: item.baseUnitId }],
    });

    expect(result.lines[0].exceptionRaised).toBe(true);
    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(75); // and it still committed
  });

  it("23. source-location semantics remain exact -- a batch withdrawal from location A never touches a sibling location's balance for the same item", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationB, 30);

    await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: randomUUID(),
      cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "12", enteredUnitId: item.baseUnitId }],
    });

    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(38);
    expect(after.find((l) => l.locationId === locationB)?.balance).toBe(30); // untouched
  });

  it("24. org isolation -- a source location from a DIFFERENT organization is rejected", async () => {
    const otherOrg = await setupOtherOrgFixtures(fx.supabase);
    const { data: otherOrgLocation } = await fx.supabase
      .from("locations")
      .insert({ organization_id: otherOrg.organizationId, name: `TEST Cross-Org Batch Location ${randomUUID().slice(0, 8)}`, timezone: "America/New_York", is_storage_eligible: true })
      .select("id")
      .single();

    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);

    await expect(
      recordInventoryWithdrawalBatch(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        clientRequestId: randomUUID(),
        cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: otherOrgLocation!.id as string, enteredQuantity: "5", enteredUnitId: item.baseUnitId }],
      })
    ).rejects.toThrow();
  });

  it("25. items from a successfully committed batch appear through the existing Recent-items mechanism", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);

    await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: randomUUID(),
      cartLines: [{ inventoryItemId: item.inventoryItemId, sourceLocationId: locationA, enteredQuantity: "5", enteredUnitId: item.baseUnitId }],
    });

    const recentIds = await listEmployeeRecentWithdrawnItemIds(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, 50);
    expect(recentIds).toContain(item.inventoryItemId);
  });
});
