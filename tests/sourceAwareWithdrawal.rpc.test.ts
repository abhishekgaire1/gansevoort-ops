import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { recordInventoryWithdrawal } from "@/app/lib/inventory/withdrawal";
import { InsufficientInventoryError, InvalidStorageLocationError } from "@/app/lib/inventory/errors";
import { getKioskItemAvailability } from "@/app/lib/kiosk/stockAvailability";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment.
 *
 * Milestone 2A.5 Phase 2 -- exact source-aware ISSUE_TO_STATION
 * withdrawals (20260811100073/74/75/76). Covers exactly what changed:
 * every NEW withdrawal records its real physical source storage
 * location, balances at that location are exact (never pro-rata) and
 * isolated from other locations, insufficient stock is rejected with no
 * partial movement, availability is race-safe under real concurrency,
 * idempotency now includes the source location, storage-eligibility is
 * enforced, and the frozen legacy allocation for pre-cutover data is
 * never recomputed. HIGH_WITHDRAWAL / historical inbound/posting
 * behavior is unchanged and covered by 2A.4's own suites.
 */

let fx: RpcTestFixtures;
let locationA: string;
let locationB: string;
let ineligibleLocationId: string;

/** A fresh, real, SAME_UNIT/PIECE confirmed inventory item -- created new
 * so its every movement is necessarily post-cutover (EXACT), never
 * touching the frozen legacy-allocation snapshot. */
async function createConfirmedPieceItem(): Promise<{ inventoryItemId: string; baseUnitId: string }> {
  const tag = randomUUID().slice(0, 8);
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: categoryRow } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `SRC-${tag}`, description: `Source Test Item ${tag}`, packageUnit: "PIECE", packageQuantity: 1 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  const result = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Source Item ${tag}`,
    disposition: "INVENTORY",
    categoryId: categoryRow!.category_id as string,
    spendCategoryId,
    baseUnitCode: "PIECE",
    rememberVendorMapping: false,
  });
  const { data: item } = await fx.supabase.from("inventory_items").select("base_unit_id").eq("id", result.inventoryItemId).single();
  return { inventoryItemId: result.inventoryItemId, baseUnitId: item!.base_unit_id as string };
}

/** Raw PURCHASE_RECEIPT insert -- the same lower-level ledger write
 * post_purchase_document_inventory itself performs; used here for tight
 * control over exact per-location quantities in a single test. */
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
    .insert({ organization_id: fx.organizationId, name: `TEST Source Location B ${tag}`, timezone: "America/New_York", is_storage_eligible: true })
    .select("id")
    .single();
  locationB = createdB!.id as string;

  const { data: createdIneligible } = await fx.supabase
    .from("locations")
    .insert({ organization_id: fx.organizationId, name: `TEST Site-Only Location ${tag}`, timezone: "America/New_York", is_storage_eligible: false })
    .select("id")
    .single();
  ineligibleLocationId = createdIneligible!.id as string;
});

describe("exact source-aware withdrawals", () => {
  it("test 1+2+3: a withdrawal records the EXACT chosen source location; that location's balance drops by exactly the withdrawn amount; a sibling location with stock for the same item is completely untouched", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationB, 30);

    const before = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(before.find((l) => l.locationId === locationA)?.balance).toBe(50);
    expect(before.find((l) => l.locationId === locationB)?.balance).toBe(30);

    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationA,
      inventoryItemId: item.inventoryItemId,
      enteredQuantity: "12",
      enteredUnitId: item.baseUnitId,
      clientRequestId: randomUUID(),
    });
    expect(result.replayed).toBe(false);

    const { data: movementRow } = await fx.supabase.from("inventory_movements").select("location_id, location_attribution, station_id").eq("id", result.movementId).single();
    expect(movementRow!.location_id).toBe(locationA);
    expect(movementRow!.location_attribution).toBe("EXACT");
    expect(movementRow!.station_id).toBe(fx.stationId); // cost-center attribution preserved, independent of location

    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(38); // 50 - 12
    expect(after.find((l) => l.locationId === locationB)?.balance).toBe(30); // sibling untouched
  });

  it("test 4: two locations with stock for the same item -- a new withdrawal is NEVER pro-rata split across them", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 100);
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationB, 100);

    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationB,
      inventoryItemId: item.inventoryItemId,
      enteredQuantity: "40",
      enteredUnitId: item.baseUnitId,
      clientRequestId: randomUUID(),
    });

    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    // A pro-rata formula (50/50 inbound split) would have taken 20 from
    // EACH location -- the exact model takes the full 40 from B alone.
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(100);
    expect(after.find((l) => l.locationId === locationB)?.balance).toBe(60);
  });

  it("test 5: the frozen legacy allocation for pre-cutover data is exposed and NEVER recomputed by new activity on an unrelated location", async () => {
    // fx.noRuleItemId predates 2A.5 -- its historical ISSUE_TO_STATION
    // withdrawals across this whole test suite are LEGACY_ESTIMATED, and
    // 20260811100073 froze their pro-rata allocation once, at migration
    // time.
    const { data: frozenBefore } = await fx.supabase
      .from("inventory_legacy_location_allocations")
      .select("allocated_outbound_quantity")
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", fx.noRuleItemId)
      .maybeSingle();

    if (frozenBefore) {
      const beforeQty = Number(frozenBefore.allocated_outbound_quantity);
      // A brand-new EXACT receipt for the SAME item, at a location that
      // has never received it before, changes that location's own
      // balance -- and must change NOTHING about the frozen snapshot.
      await receiveExact(fx.noRuleItemId, (await fx.supabase.from("inventory_items").select("base_unit_id").eq("id", fx.noRuleItemId).single()).data!.base_unit_id as string, locationB, 999);

      const { data: frozenAfter } = await fx.supabase
        .from("inventory_legacy_location_allocations")
        .select("allocated_outbound_quantity")
        .eq("organization_id", fx.organizationId)
        .eq("inventory_item_id", fx.noRuleItemId)
        .single();
      expect(Number(frozenAfter!.allocated_outbound_quantity)).toBe(beforeQty); // untouched
    }

    // Structural guarantee regardless of whether this item happened to
    // have a nonzero frozen row: a brand-new item created strictly after
    // cutover has NO frozen allocation at all -- nothing to estimate.
    const freshItem = await createConfirmedPieceItem();
    const { data: freshFrozen } = await fx.supabase
      .from("inventory_legacy_location_allocations")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", freshItem.inventoryItemId);
    expect(freshFrozen).toHaveLength(0);
  });

  it("test 6: a quantity exceeding the source location's balance is rejected, and writes NO movement at all", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 13);

    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: locationA,
        inventoryItemId: item.inventoryItemId,
        enteredQuantity: "20",
        enteredUnitId: item.baseUnitId,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InsufficientInventoryError);

    const { data: linesForItem } = await fx.supabase
      .from("inventory_movement_lines")
      .select("movement_id, inventory_movements!inner(location_id, movement_type)")
      .eq("inventory_item_id", item.inventoryItemId)
      .eq("inventory_movements.location_id", locationA)
      .eq("inventory_movements.movement_type", "ISSUE_TO_STATION");
    expect(linesForItem ?? []).toHaveLength(0); // no partial movement for THIS item

    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(13); // unchanged
  });

  it("test 6b: the rejection carries structured available/requested detail, and a within-limit retry then succeeds", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 13);

    try {
      await recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: locationA,
        inventoryItemId: item.inventoryItemId,
        enteredQuantity: "20",
        enteredUnitId: item.baseUnitId,
        clientRequestId: randomUUID(),
      });
      expect.unreachable("expected InsufficientInventoryError");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientInventoryError);
      const typed = err as InsufficientInventoryError;
      expect(typed.availableQuantity).toBe(13);
      expect(typed.requestedQuantity).toBe(20);
    }

    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationA,
      inventoryItemId: item.inventoryItemId,
      enteredQuantity: "13",
      enteredUnitId: item.baseUnitId,
      clientRequestId: randomUUID(),
    });
    expect(result.replayed).toBe(false);
  });

  it("test 7: two genuinely concurrent withdrawals for more than the available stock can NEVER both succeed (no oversubscription)", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 15);

    const attempt = () =>
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: locationA,
        inventoryItemId: item.inventoryItemId,
        enteredQuantity: "10",
        enteredUnitId: item.baseUnitId,
        clientRequestId: randomUUID(),
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    // 15 available, two requests of 10 each (20 total) -- strictly
    // exactly one can succeed; the loser is rejected, never both, never
    // a negative balance.
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    if (failed[0].status === "rejected") {
      expect(failed[0].reason).toBeInstanceOf(InsufficientInventoryError);
    }

    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(5); // 15 - 10, never negative
  });

  it("test 8: an idempotent retry with the identical payload (including source location) returns the SAME movement, never a duplicate", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);
    const requestId = randomUUID();
    const input = {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationA,
      inventoryItemId: item.inventoryItemId,
      enteredQuantity: "5",
      enteredUnitId: item.baseUnitId,
      clientRequestId: requestId,
    };
    const first = await recordInventoryWithdrawal(fx.supabase, input);
    const second = await recordInventoryWithdrawal(fx.supabase, input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.movementId).toBe(first.movementId);

    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(45); // one withdrawal's worth, not two
  });

  it("test 9: the same idempotency key reused with a DIFFERENT source location conflicts, rather than silently replaying the original", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationB, 50);
    const requestId = randomUUID();

    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationA,
      inventoryItemId: item.inventoryItemId,
      enteredQuantity: "5",
      enteredUnitId: item.baseUnitId,
      clientRequestId: requestId,
    });

    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: locationB, // different location, same key
        inventoryItemId: item.inventoryItemId,
        enteredQuantity: "5",
        enteredUnitId: item.baseUnitId,
        clientRequestId: requestId,
      })
    ).rejects.toThrow(/already used with a different withdrawal payload/);

    // Location B is untouched -- the conflicting call never wrote anything.
    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationB)?.balance).toBe(50);
  });

  it("test 10: HIGH_WITHDRAWAL still fires independently of availability -- a large-but-available withdrawal both succeeds AND raises the exception", async () => {
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

    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationA,
      inventoryItemId: item.inventoryItemId,
      enteredQuantity: "25", // over the 10 threshold, well under the 100 available
      enteredUnitId: item.baseUnitId,
      clientRequestId: randomUUID(),
    });

    expect(result.exceptionRaised).toBe(true); // the anomaly signal still fires
    const after = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(after.find((l) => l.locationId === locationA)?.balance).toBe(75); // and the withdrawal still succeeded
  });

  it("test 11: a source location from a DIFFERENT organization is rejected", async () => {
    const otherOrg = await setupOtherOrgFixtures(fx.supabase);
    const { data: otherOrgLocation } = await fx.supabase
      .from("locations")
      .insert({ organization_id: otherOrg.organizationId, name: `TEST Cross-Org Location ${randomUUID().slice(0, 8)}`, timezone: "America/New_York", is_storage_eligible: true })
      .select("id")
      .single();

    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);

    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: otherOrgLocation!.id as string,
        inventoryItemId: item.inventoryItemId,
        enteredQuantity: "5",
        enteredUnitId: item.baseUnitId,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InvalidStorageLocationError);
  });

  it("test 12a: an inactive item is rejected", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 50);
    await fx.supabase.from("inventory_items").update({ status: "inactive" }).eq("id", item.inventoryItemId);

    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: locationA,
        inventoryItemId: item.inventoryItemId,
        enteredQuantity: "5",
        enteredUnitId: item.baseUnitId,
        clientRequestId: randomUUID(),
      })
    ).rejects.toThrow(/is not an active item/);
  });

  it("test 12b: a location that exists and is active but is NOT storage-eligible (a site/business location) is rejected", async () => {
    const item = await createConfirmedPieceItem();
    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: ineligibleLocationId,
        inventoryItemId: item.inventoryItemId,
        enteredQuantity: "5",
        enteredUnitId: item.baseUnitId,
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(InvalidStorageLocationError);
  });

  it("kiosk stock visibility never includes a location whose balance has been fully depleted", async () => {
    const item = await createConfirmedPieceItem();
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationA, 10);
    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationA,
      inventoryItemId: item.inventoryItemId,
      enteredQuantity: "10",
      enteredUnitId: item.baseUnitId,
      clientRequestId: randomUUID(),
    });

    const availability = await getKioskItemAvailability(fx.supabase, fx.organizationId, item.inventoryItemId);
    expect(availability).toHaveLength(0); // out of stock everywhere -- never a fake 0% row
  });
});
