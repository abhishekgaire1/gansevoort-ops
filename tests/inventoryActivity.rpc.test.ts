import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { recordInventoryWaste } from "@/app/lib/inventory/waste";
import { listInventoryActivity, getInventoryActivityDetail } from "@/app/lib/inventory/globalActivity";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment (same convention every other .rpc.test.ts file in this repo
 * follows).
 *
 * Global Inventory Activity milestone (20260811100090/20260811100091) --
 * exercises list_inventory_activity / get_inventory_activity_detail
 * against REAL PURCHASE_RECEIPT/ISSUE_TO_STATION/WASTE movements. Cycle
 * Count coverage is intentionally left to inventoryItemActivity.rpc.test.ts
 * (already exercises the identical join path via
 * list_inventory_item_activity, which shares its row-mapping code with
 * this global RPC through activityTypes.ts) -- not duplicated here.
 */

let fx: RpcTestFixtures;
let locationId: string;
let pieceUnitId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: primaryLocation } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = primaryLocation!.id as string;
  const { data: pieceUnit } = await fx.supabase.from("units").select("id").eq("code", "PIECE").single();
  pieceUnitId = pieceUnit!.id as string;
});

async function postedPieceItem(quantity: number, description = `Global Activity ${randomUUID().slice(0, 6)}`): Promise<{ itemId: string; purchaseDocumentId: string }> {
  const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
    { description, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: quantity, receivedUnit: "PIECE" } },
  ]);
  await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
  return { itemId: doc.itemIds[0]!, purchaseDocumentId: doc.purchaseDocumentId };
}

async function withdraw(itemId: string, quantity: number): Promise<void> {
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

describe("listInventoryActivity -- global feed", () => {
  it("newest first, correct item name, correct location, correct withdrawal employee/destination, correct receiving source", async () => {
    const uniqueName = `Global Activity ${randomUUID().slice(0, 8)}`;
    const { itemId, purchaseDocumentId } = await postedPieceItem(20, uniqueName);
    await withdraw(itemId, 5);

    const page = await listInventoryActivity(fx.supabase, { organizationId: fx.organizationId, search: uniqueName });
    expect(page.entries).toHaveLength(2);

    const [withdrawal, receipt] = page.entries;
    expect(withdrawal.movementType).toBe("ISSUE_TO_STATION");
    expect(withdrawal.itemName).toContain(uniqueName);
    expect(withdrawal.locationId).toBe(locationId);
    expect(withdrawal.actor?.appUserId).toBe(fx.changeableEmployeeAppUserId);
    expect(withdrawal.station?.id).toBe(fx.otherStationId);
    expect(new Date(withdrawal.occurredAt).getTime()).toBeGreaterThanOrEqual(new Date(receipt.occurredAt).getTime());

    expect(receipt.movementType).toBe("PURCHASE_RECEIPT");
    expect(receipt.purchaseDocument?.id).toBe(purchaseDocumentId);
    expect(receipt.vendor?.id).toBe(fx.vendorId);
  });

  it("waste source is correct", async () => {
    const uniqueName = `Global Activity Waste ${randomUUID().slice(0, 8)}`;
    const { itemId } = await postedPieceItem(10, uniqueName);
    const wasteResult = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: fx.changeableEmployeeAppUserId,
      locationId,
      inventoryItemId: itemId,
      quantity: "2",
      reasonCode: "DAMAGED",
      note: null,
      clientRequestId: randomUUID(),
    });

    const page = await listInventoryActivity(fx.supabase, { organizationId: fx.organizationId, search: uniqueName, filter: "WASTE" });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].waste?.id).toBe(wasteResult.wasteEventId);
    expect(page.entries[0].waste?.reasonCode).toBe("DAMAGED");
  });

  it("search finds items by name and never leaks unrelated items", async () => {
    const uniqueName = `Findable Item ${randomUUID().slice(0, 8)}`;
    await postedPieceItem(3, uniqueName);
    await postedPieceItem(3, `Unrelated Item ${randomUUID().slice(0, 8)}`);

    const page = await listInventoryActivity(fx.supabase, { organizationId: fx.organizationId, search: uniqueName });
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.every((e) => e.itemName.includes(uniqueName))).toBe(true);
  });

  it("the RECEIVED filter and Location filter both narrow correctly", async () => {
    const uniqueName = `Global Activity Filter ${randomUUID().slice(0, 8)}`;
    const { itemId } = await postedPieceItem(8, uniqueName);
    await withdraw(itemId, 1);

    const receivedOnly = await listInventoryActivity(fx.supabase, { organizationId: fx.organizationId, search: uniqueName, filter: "RECEIVED" });
    expect(receivedOnly.entries).toHaveLength(1);
    expect(receivedOnly.entries[0].movementType).toBe("PURCHASE_RECEIPT");

    const atLocation = await listInventoryActivity(fx.supabase, { organizationId: fx.organizationId, search: uniqueName, locationId });
    expect(atLocation.entries.length).toBeGreaterThanOrEqual(2);
    expect(atLocation.entries.every((e) => e.locationId === locationId)).toBe(true);

    const atRandomOtherLocation = await listInventoryActivity(fx.supabase, { organizationId: fx.organizationId, search: uniqueName, locationId: randomUUID() });
    expect(atRandomOtherLocation.entries).toHaveLength(0);
  });
});

describe("listInventoryActivity -- cross-organization isolation", () => {
  it("never returns another organization's movement", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    const uniqueName = `Global Activity CrossOrg ${randomUUID().slice(0, 8)}`;
    await postedPieceItem(4, uniqueName);

    const page = await listInventoryActivity(fx.supabase, { organizationId: other.organizationId, search: uniqueName });
    expect(page.entries).toHaveLength(0);
  });
});

describe("listInventoryActivity -- pagination", () => {
  it("keyset pagination is stable: no duplicates, no gaps", async () => {
    const uniqueName = `Global Activity Page ${randomUUID().slice(0, 8)}`;
    const { itemId } = await postedPieceItem(50, uniqueName);
    for (let i = 0; i < 3; i += 1) await withdraw(itemId, 1);

    const firstPage = await listInventoryActivity(fx.supabase, { organizationId: fx.organizationId, search: uniqueName, limit: 2 });
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listInventoryActivity(fx.supabase, {
      organizationId: fx.organizationId,
      search: uniqueName,
      limit: 2,
      beforeOccurredAt: firstPage.nextCursor!.occurredAt,
      beforeId: firstPage.nextCursor!.id,
    });
    expect(secondPage.entries).toHaveLength(2);

    const ids = new Set([...firstPage.entries.map((e) => e.id), ...secondPage.entries.map((e) => e.id)]);
    expect(ids.size).toBe(4); // 1 receipt + 3 withdrawals, no dup/gap across pages
  });
});

describe("getInventoryActivityDetail", () => {
  it("returns the exact movement line's full detail by id", async () => {
    const uniqueName = `Global Activity Detail ${randomUUID().slice(0, 8)}`;
    const { itemId, purchaseDocumentId } = await postedPieceItem(6, uniqueName);
    const page = await listInventoryActivity(fx.supabase, { organizationId: fx.organizationId, search: uniqueName });
    const receiptEntry = page.entries.find((e) => e.movementType === "PURCHASE_RECEIPT")!;

    const detail = await getInventoryActivityDetail(fx.supabase, fx.organizationId, receiptEntry.id);
    expect(detail).not.toBeNull();
    expect(detail!.inventoryItemId).toBe(itemId);
    expect(detail!.purchaseDocument?.id).toBe(purchaseDocumentId);
  });

  it("returns null for an id that does not exist", async () => {
    const detail = await getInventoryActivityDetail(fx.supabase, fx.organizationId, randomUUID());
    expect(detail).toBeNull();
  });

  it("never returns another organization's movement line even by exact id", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    const uniqueName = `Global Activity Detail CrossOrg ${randomUUID().slice(0, 8)}`;
    await postedPieceItem(5, uniqueName);
    const page = await listInventoryActivity(fx.supabase, { organizationId: fx.organizationId, search: uniqueName });
    const entry = page.entries[0];

    const detail = await getInventoryActivityDetail(fx.supabase, other.organizationId, entry.id);
    expect(detail).toBeNull();
  });
});
