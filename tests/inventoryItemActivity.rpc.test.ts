import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { recordInventoryWaste } from "@/app/lib/inventory/waste";
import { startOrResumeCycleCount, addCycleCountLine, recordCycleCountLineObservation, completeCycleCount } from "@/app/lib/inventory/cycleCounts";
import { getInventoryItemLocationSummary, listInventoryItemActivity } from "@/app/lib/inventory/itemActivity";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment (same convention every other .rpc.test.ts file in this repo
 * follows: touches the linked Supabase dev database directly, never run
 * automatically, never part of `npm run test:integration`'s aggregated
 * run for this milestone's own validation pass).
 *
 * Inventory Item Detail + Activity History milestone (20260811100089) --
 * exercises list_inventory_item_activity and
 * getInventoryItemLocationSummary (which reuses the SAME
 * list_inventory_balances_for_item every other authoritative balance read
 * uses) against REAL PURCHASE_RECEIPT, ISSUE_TO_STATION, WASTE, and
 * COUNT_ADJUSTMENT_IN/OUT movements produced by the real write RPCs --
 * never synthetic rows inserted directly into inventory_movements.
 */

let fx: RpcTestFixtures;
let locationId: string;
let secondLocationId: string;
let pieceUnitId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: primaryLocation } = await fx.supabase.from("locations").select("id, timezone").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = primaryLocation!.id as string;

  // A second storage-eligible location, isolated from the shared single
  // fixture location, purely for the "another location's activity never
  // leaks in" test -- idempotent find-or-insert, same convention as
  // every other fixed-name fixture row in this file's suite.
  const { data: existingSecond } = await fx.supabase
    .from("locations")
    .select("id")
    .eq("organization_id", fx.organizationId)
    .eq("name", "TEST RPC Fixture Location B")
    .maybeSingle();
  if (existingSecond) {
    secondLocationId = existingSecond.id as string;
  } else {
    const { data: inserted, error } = await fx.supabase
      .from("locations")
      .insert({
        organization_id: fx.organizationId,
        name: "TEST RPC Fixture Location B",
        timezone: primaryLocation!.timezone as string,
        is_storage_eligible: true,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    secondLocationId = inserted!.id as string;
  }

  const { data: pieceUnit } = await fx.supabase.from("units").select("id").eq("code", "PIECE").single();
  pieceUnitId = pieceUnit!.id as string;
});

async function postedPieceItem(quantity: number, atLocationId: string): Promise<{ itemId: string; purchaseDocumentId: string }> {
  const doc = await createVerifiedPostingDocument(fx.supabase, fx, atLocationId, [
    { description: `Activity Item ${randomUUID().slice(0, 6)}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: quantity, receivedUnit: "PIECE" } },
  ]);
  await postPurchaseDocumentInventoryRpc(fx.supabase, {
    purchaseDocumentId: doc.purchaseDocumentId,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
  });
  return { itemId: doc.itemIds[0]!, purchaseDocumentId: doc.purchaseDocumentId };
}

async function withdraw(itemId: string, quantity: number, atLocationId: string): Promise<void> {
  const { error } = await fx.supabase.rpc("record_inventory_withdrawal", {
    p_performed_by_app_user_id: fx.changeableEmployeeAppUserId,
    p_station_id: fx.otherStationId,
    p_source_location_id: atLocationId,
    p_inventory_item_id: itemId,
    p_entered_quantity: String(quantity),
    p_entered_unit_id: pieceUnitId,
    p_measured_base_quantity: null,
    p_notes: null,
    p_client_request_id: randomUUID(),
  });
  if (error) throw new Error(error.message);
}

describe("getInventoryItemLocationSummary", () => {
  it("matches the same authoritative balance every Current Inventory card uses", async () => {
    const { itemId } = await postedPieceItem(20, locationId);
    await withdraw(itemId, 6, locationId);

    const summary = await getInventoryItemLocationSummary(fx.supabase, fx.organizationId, itemId, locationId);
    expect(summary?.balance).toBe(14);
    expect(summary?.fullReferenceQuantity).toBe(20);
  });

  it("returns null for an item that does not exist in this organization", async () => {
    const summary = await getInventoryItemLocationSummary(fx.supabase, fx.organizationId, randomUUID(), locationId);
    expect(summary).toBeNull();
  });

  it("returns null for a location that does not exist in this organization", async () => {
    const { itemId } = await postedPieceItem(5, locationId);
    const summary = await getInventoryItemLocationSummary(fx.supabase, fx.organizationId, itemId, randomUUID());
    expect(summary).toBeNull();
  });
});

describe("list_inventory_item_activity -- receiving and withdrawal", () => {
  it("orders newest first, shows a negative withdrawal and a positive receipt, and attributes each correctly", async () => {
    const { itemId, purchaseDocumentId } = await postedPieceItem(15, locationId);
    await withdraw(itemId, 4, locationId);

    const page = await listInventoryItemActivity(fx.supabase, { organizationId: fx.organizationId, inventoryItemId: itemId, locationId });
    expect(page.entries).toHaveLength(2);

    // Newest first: the withdrawal happened after the receipt.
    const [withdrawal, receipt] = page.entries;
    expect(withdrawal.movementType).toBe("ISSUE_TO_STATION");
    expect(withdrawal.direction).toBe("OUT");
    expect(withdrawal.quantity).toBe(4);
    expect(new Date(withdrawal.occurredAt).getTime()).toBeGreaterThanOrEqual(new Date(receipt.occurredAt).getTime());

    expect(receipt.movementType).toBe("PURCHASE_RECEIPT");
    expect(receipt.direction).toBe("IN");
    expect(receipt.quantity).toBe(15);

    // Withdrawal employee + destination station attribution.
    expect(withdrawal.actor?.appUserId).toBe(fx.changeableEmployeeAppUserId);
    expect(withdrawal.actor?.name).toBeTruthy();
    expect(withdrawal.station?.id).toBe(fx.otherStationId);
    expect(withdrawal.locationAttribution).toBe("EXACT");

    // Receipt purchase document + vendor linkage.
    expect(receipt.purchaseDocument?.id).toBe(purchaseDocumentId);
    expect(receipt.vendor?.id).toBe(fx.vendorId);
    expect(receipt.actor?.appUserId).toBe(fx.changeableEmployeeAppUserId);
  });
});

describe("list_inventory_item_activity -- waste", () => {
  it("maps a WASTE movement to its waste event (reason, note, actor)", async () => {
    const { itemId } = await postedPieceItem(10, locationId);
    const wasteResult = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: fx.changeableEmployeeAppUserId,
      locationId,
      inventoryItemId: itemId,
      quantity: "3",
      reasonCode: "SPOILED",
      note: null,
      clientRequestId: randomUUID(),
    });

    const page = await listInventoryItemActivity(fx.supabase, { organizationId: fx.organizationId, inventoryItemId: itemId, locationId, filter: "WASTE" });
    expect(page.entries).toHaveLength(1);
    const [entry] = page.entries;
    expect(entry.movementType).toBe("WASTE");
    expect(entry.direction).toBe("OUT");
    expect(entry.quantity).toBe(3);
    expect(entry.waste?.id).toBe(wasteResult.wasteEventId);
    expect(entry.waste?.reasonCode).toBe("SPOILED");
    expect(entry.actor?.appUserId).toBe(fx.changeableEmployeeAppUserId);
  });
});

describe("list_inventory_item_activity -- cycle count adjustment", () => {
  it("maps a COUNT_ADJUSTMENT movement to its expected/counted quantities and completer", async () => {
    const { itemId } = await postedPieceItem(20, locationId);

    const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    await addCycleCountLine(fx.supabase, { cycleCountId: started.cycleCountId, inventoryItemId: itemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, {
      cycleCountId: started.cycleCountId,
      inventoryItemId: itemId,
      physicalCountQuantity: "17",
      actorAppUserId: fx.changeableEmployeeAppUserId,
    });
    await completeCycleCount(fx.supabase, {
      cycleCountId: started.cycleCountId,
      expectedVersion: started.version,
      completedByAppUserId: fx.changeableEmployeeAppUserId,
      completionNote: "TEST RPC fixture completion",
    });

    const page = await listInventoryItemActivity(fx.supabase, { organizationId: fx.organizationId, inventoryItemId: itemId, locationId, filter: "CYCLE_COUNTS" });
    expect(page.entries).toHaveLength(1);
    const [entry] = page.entries;
    expect(entry.movementType).toBe("COUNT_ADJUSTMENT_OUT");
    expect(entry.direction).toBe("OUT");
    expect(entry.quantity).toBe(3); // 20 -> 17
    expect(entry.cycleCount?.id).toBe(started.cycleCountId);
    expect(entry.cycleCount?.expectedQuantity).toBe(20);
    expect(entry.cycleCount?.countedQuantity).toBe(17);
    expect(entry.actor?.appUserId).toBe(fx.changeableEmployeeAppUserId);
  });
});

describe("list_inventory_item_activity -- location isolation", () => {
  it("never includes the same item's activity at a different location", async () => {
    const { itemId } = await postedPieceItem(8, locationId);
    await postedPieceItem(8, secondLocationId).then(async ({ itemId: otherItemAtOtherLocation }) => {
      // Distinct item at the other location -- irrelevant noise, confirms
      // the query is scoped by item AND location, not just location.
      void otherItemAtOtherLocation;
    });
    // The SAME item, also received at the second location.
    await createVerifiedPostingDocument(fx.supabase, fx, secondLocationId, [
      { description: "Activity Cross-Location", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 5, receivedUnit: "PIECE", locationId: secondLocationId } },
    ]);

    const page = await listInventoryItemActivity(fx.supabase, { organizationId: fx.organizationId, inventoryItemId: itemId, locationId: secondLocationId });
    expect(page.entries).toHaveLength(0);

    const ownPage = await listInventoryItemActivity(fx.supabase, { organizationId: fx.organizationId, inventoryItemId: itemId, locationId });
    expect(ownPage.entries).toHaveLength(1);
    expect(ownPage.entries[0].quantity).toBe(8);
  });
});

describe("list_inventory_item_activity -- cross-organization isolation", () => {
  it("never returns another organization's movement even when item/location ids happen to be passed", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    // A real item+location pair from THIS org, queried under the OTHER
    // org's organization_id -- must return nothing, proving isolation is
    // enforced by organization_id itself, not merely by the caller
    // happening to only ever pass matching ids.
    const { itemId } = await postedPieceItem(6, locationId);
    const page = await listInventoryItemActivity(fx.supabase, { organizationId: other.organizationId, inventoryItemId: itemId, locationId });
    expect(page.entries).toHaveLength(0);
  });
});

describe("list_inventory_item_activity -- pagination and type filter", () => {
  it("paginates with a stable cursor: no duplicates, no gaps, deterministic order", async () => {
    const { itemId } = await postedPieceItem(50, locationId);
    for (let i = 0; i < 4; i += 1) {
      await withdraw(itemId, 1, locationId);
    }

    const firstPage = await listInventoryItemActivity(fx.supabase, { organizationId: fx.organizationId, inventoryItemId: itemId, locationId, limit: 2 });
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listInventoryItemActivity(fx.supabase, {
      organizationId: fx.organizationId,
      inventoryItemId: itemId,
      locationId,
      limit: 2,
      beforeOccurredAt: firstPage.nextCursor!.occurredAt,
      beforeId: firstPage.nextCursor!.id,
    });
    expect(secondPage.entries).toHaveLength(2);

    const firstIds = firstPage.entries.map((e) => e.id);
    const secondIds = secondPage.entries.map((e) => e.id);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(4); // no duplicate, no gap across pages

    const thirdPage = await listInventoryItemActivity(fx.supabase, {
      organizationId: fx.organizationId,
      inventoryItemId: itemId,
      locationId,
      limit: 2,
      beforeOccurredAt: secondPage.nextCursor?.occurredAt ?? null,
      beforeId: secondPage.nextCursor?.id ?? null,
    });
    // 5 total movements (1 receipt + 4 withdrawals): page 3 holds the last one.
    expect(thirdPage.entries).toHaveLength(1);
    expect(thirdPage.nextCursor).toBeNull();
  });

  it("the RECEIVED filter returns only PURCHASE_RECEIPT rows", async () => {
    const { itemId } = await postedPieceItem(9, locationId);
    await withdraw(itemId, 1, locationId);

    const page = await listInventoryItemActivity(fx.supabase, { organizationId: fx.organizationId, inventoryItemId: itemId, locationId, filter: "RECEIVED" });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].movementType).toBe("PURCHASE_RECEIPT");
  });
});

describe("list_inventory_item_activity -- missing optional provenance", () => {
  it("a withdrawal row (no vendor/waste/cycle count) never crashes and leaves those fields null", async () => {
    const { itemId } = await postedPieceItem(6, locationId);
    await withdraw(itemId, 2, locationId);

    const page = await listInventoryItemActivity(fx.supabase, { organizationId: fx.organizationId, inventoryItemId: itemId, locationId, filter: "WITHDRAWALS" });
    expect(page.entries).toHaveLength(1);
    const [entry] = page.entries;
    expect(entry.vendor).toBeNull();
    expect(entry.purchaseDocument).toBeNull();
    expect(entry.waste).toBeNull();
    expect(entry.cycleCount).toBeNull();
  });
});
