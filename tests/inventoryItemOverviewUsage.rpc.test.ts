import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { createVerifiedPostingDocument } from "./inventoryPostingTestHelpers";
import { getInventoryItemLastReceived, getInventoryItemUsageTotals } from "@/app/lib/inventory/itemOverview";
import { getInventoryItemUsageByStation, getInventoryItemUsageTrend } from "@/app/lib/inventory/itemUsage";
import { todayDateStringInTimezone } from "@/app/manager/(app)/inventory/_lib/usagePresentation";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment (same convention every other .rpc.test.ts file in this repo
 * follows).
 *
 * Inventory Item Detail Overview + Usage milestone (20260811100092) --
 * exercises get_inventory_item_last_received, get_inventory_item_usage_
 * totals, get_inventory_item_usage_by_station, and get_inventory_item_
 * usage_trend against REAL PURCHASE_RECEIPT/ISSUE_TO_STATION movements.
 */

let fx: RpcTestFixtures;
let locationId: string;
let locationTimezone: string;
let pieceUnitId: string;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  const { data: primaryLocation } = await fx.supabase.from("locations").select("id, timezone").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = primaryLocation!.id as string;
  locationTimezone = primaryLocation!.timezone as string;
  const { data: pieceUnit } = await fx.supabase.from("units").select("id").eq("code", "PIECE").single();
  pieceUnitId = pieceUnit!.id as string;
});

async function postedPieceItem(quantity: number): Promise<{ itemId: string; purchaseDocumentId: string }> {
  const doc = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
    { description: `Overview/Usage ${randomUUID().slice(0, 6)}`, receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: quantity, receivedUnit: "PIECE" } },
  ]);
  await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: doc.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
  return { itemId: doc.itemIds[0]!, purchaseDocumentId: doc.purchaseDocumentId };
}

async function withdraw(itemId: string, quantity: number, stationId: string): Promise<void> {
  const { error } = await fx.supabase.rpc("record_inventory_withdrawal", {
    p_performed_by_app_user_id: fx.changeableEmployeeAppUserId,
    p_station_id: stationId,
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

describe("getInventoryItemLastReceived", () => {
  it("returns the most recent receiving movement with a unit cost derived from line_total / posted_base_quantity", async () => {
    const { itemId, purchaseDocumentId } = await postedPieceItem(20);

    const lastReceived = await getInventoryItemLastReceived(fx.supabase, fx.organizationId, itemId, locationId);
    expect(lastReceived).not.toBeNull();
    expect(lastReceived!.quantity).toBe(20);
    expect(lastReceived!.purchaseDocument?.id).toBe(purchaseDocumentId);
    expect(lastReceived!.vendor?.id).toBe(fx.vendorId);
    // The shared test fixture helper hardcodes lineTotal=100 for every
    // synthesized invoice line -- 100 / 20 = 5.
    expect(lastReceived!.unitCost).toBeCloseTo(5, 5);
  });

  it("returns the NEWEST receipt when an item has been received more than once", async () => {
    const { itemId } = await postedPieceItem(10);
    await postedPieceItem(10); // different item -- irrelevant noise
    const second = await createVerifiedPostingDocument(fx.supabase, fx, locationId, [
      { description: "Overview/Usage second receipt", receiving: { behavior: "SAME_UNIT", baseUnitCode: "PIECE", receivedQuantity: 5, receivedUnit: "PIECE" } },
    ]);
    void second;

    const lastReceived = await getInventoryItemLastReceived(fx.supabase, fx.organizationId, itemId, locationId);
    expect(lastReceived!.quantity).toBe(10);
  });

  it("returns null when this item has never been received at this location", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    void other;
    const lastReceived = await getInventoryItemLastReceived(fx.supabase, fx.organizationId, randomUUID(), locationId);
    expect(lastReceived).toBeNull();
  });
});

describe("getInventoryItemUsageTotals", () => {
  it("counts only ISSUE_TO_STATION for this item+location within Today/7/30 day windows", async () => {
    const { itemId } = await postedPieceItem(50);
    await withdraw(itemId, 3, fx.stationId);
    await withdraw(itemId, 2, fx.otherStationId);

    const totals = await getInventoryItemUsageTotals(fx.supabase, fx.organizationId, itemId, locationId);
    expect(totals.today).toBe(5);
    expect(totals.sevenDay).toBe(5);
    expect(totals.thirtyDay).toBe(5);
    expect(totals.baseUnitCode).toBe("PIECE");
  });

  it("is zero, not null/error, for an item with no withdrawals", async () => {
    const { itemId } = await postedPieceItem(4);
    const totals = await getInventoryItemUsageTotals(fx.supabase, fx.organizationId, itemId, locationId);
    expect(totals.today).toBe(0);
    expect(totals.sevenDay).toBe(0);
    expect(totals.thirtyDay).toBe(0);
  });
});

describe("getInventoryItemUsageByStation", () => {
  it("aggregates by destination station with correct quantities and percentages summing to ~100", async () => {
    const { itemId } = await postedPieceItem(100);
    await withdraw(itemId, 6, fx.stationId);
    await withdraw(itemId, 4, fx.otherStationId);

    const usage = await getInventoryItemUsageByStation(fx.supabase, fx.organizationId, itemId, locationId, "THIRTY_DAYS");
    expect(usage.total).toBe(10);
    expect(usage.byStation).toHaveLength(2);

    const byId = new Map(usage.byStation.map((s) => [s.stationId, s]));
    expect(byId.get(fx.stationId)?.quantity).toBe(6);
    expect(byId.get(fx.otherStationId)?.quantity).toBe(4);

    const percentSum = usage.byStation.reduce((sum, s) => sum + s.percentage, 0);
    expect(percentSum).toBeGreaterThan(99.9);
    expect(percentSum).toBeLessThan(100.1);
  });

  it("excludes receiving, and only reflects withdrawals for the exact item+location", async () => {
    const { itemId } = await postedPieceItem(30);
    await withdraw(itemId, 5, fx.stationId);

    const usage = await getInventoryItemUsageByStation(fx.supabase, fx.organizationId, itemId, locationId, "THIRTY_DAYS");
    expect(usage.total).toBe(5); // the 30-unit receipt itself is never counted as usage
  });

  it("multi-line withdrawal batches count each item's own line exactly once", async () => {
    const a = await postedPieceItem(20);
    const clientRequestId = randomUUID();
    const { error } = await fx.supabase.rpc("record_inventory_withdrawal_batch", {
      p_performed_by_app_user_id: fx.changeableEmployeeAppUserId,
      p_station_id: fx.stationId,
      p_client_request_id: clientRequestId,
      p_cart_lines: [{ inventoryItemId: a.itemId, sourceLocationId: locationId, enteredQuantity: "7", enteredUnitId: pieceUnitId, measuredBaseQuantity: null }],
    });
    if (error) throw new Error(error.message);

    const usage = await getInventoryItemUsageByStation(fx.supabase, fx.organizationId, a.itemId, locationId, "THIRTY_DAYS");
    expect(usage.total).toBe(7);
  });

  it("returns an empty list, not an error, for zero usage", async () => {
    const { itemId } = await postedPieceItem(3);
    const usage = await getInventoryItemUsageByStation(fx.supabase, fx.organizationId, itemId, locationId, "TODAY");
    expect(usage.total).toBe(0);
    expect(usage.byStation).toHaveLength(0);
  });

  it("same-org isolation: another organization's withdrawal never appears", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    const { itemId } = await postedPieceItem(15);
    await withdraw(itemId, 5, fx.stationId);

    const usage = await getInventoryItemUsageByStation(fx.supabase, other.organizationId, itemId, locationId, "THIRTY_DAYS");
    expect(usage.total).toBe(0);
  });
});

describe("getInventoryItemUsageByStation -- CUSTOM range", () => {
  function isoDateNDaysAgo(n: number): string {
    // Matches the RPC's own (now() at time zone location.timezone)::date
    // bucketing -- computed with the SAME location timezone, never raw
    // machine-local/UTC, so this never flakes near a day boundary.
    const today = todayDateStringInTimezone(new Date(), locationTimezone);
    const [y, m, d] = today.split("-").map(Number);
    const utcDate = new Date(Date.UTC(y, m - 1, d));
    utcDate.setUTCDate(utcDate.getUTCDate() - n);
    return utcDate.toISOString().slice(0, 10);
  }

  it("a custom range spanning today includes today's withdrawals", async () => {
    const { itemId } = await postedPieceItem(50);
    await withdraw(itemId, 6, fx.stationId);

    const today = isoDateNDaysAgo(0);
    const usage = await getInventoryItemUsageByStation(fx.supabase, fx.organizationId, itemId, locationId, "CUSTOM", { start: today, end: today });
    expect(usage.total).toBe(6);
  });

  it("a custom range that excludes today returns zero despite real withdrawals existing today", async () => {
    const { itemId } = await postedPieceItem(50);
    await withdraw(itemId, 6, fx.stationId);

    const usage = await getInventoryItemUsageByStation(fx.supabase, fx.organizationId, itemId, locationId, "CUSTOM", {
      start: isoDateNDaysAgo(10),
      end: isoDateNDaysAgo(5),
    });
    expect(usage.total).toBe(0);
  });

  it("returns nothing when start/end are missing (never silently falls back to a default window)", async () => {
    const { itemId } = await postedPieceItem(20);
    await withdraw(itemId, 4, fx.stationId);

    const usage = await getInventoryItemUsageByStation(fx.supabase, fx.organizationId, itemId, locationId, "CUSTOM", null);
    expect(usage.total).toBe(0);
  });

  it("the trend also respects the custom range", async () => {
    const { itemId } = await postedPieceItem(50);
    await withdraw(itemId, 3, fx.stationId);

    const today = isoDateNDaysAgo(0);
    const trendIncluding = await getInventoryItemUsageTrend(fx.supabase, fx.organizationId, itemId, locationId, "CUSTOM", { start: today, end: today });
    expect(trendIncluding.reduce((sum, p) => sum + p.quantity, 0)).toBe(3);

    const trendExcluding = await getInventoryItemUsageTrend(fx.supabase, fx.organizationId, itemId, locationId, "CUSTOM", {
      start: isoDateNDaysAgo(10),
      end: isoDateNDaysAgo(5),
    });
    expect(trendExcluding).toHaveLength(0);
  });
});

describe("getInventoryItemUsageTrend", () => {
  it("buckets today's withdrawals under today's date", async () => {
    const { itemId } = await postedPieceItem(40);
    await withdraw(itemId, 9, fx.stationId);

    const trend = await getInventoryItemUsageTrend(fx.supabase, fx.organizationId, itemId, locationId, "SEVEN_DAYS");
    const totalInTrend = trend.reduce((sum, p) => sum + p.quantity, 0);
    expect(totalInTrend).toBe(9);
    expect(trend.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))).toBe(true);
  });

  it("is empty, not an error, for zero usage", async () => {
    const { itemId } = await postedPieceItem(2);
    const trend = await getInventoryItemUsageTrend(fx.supabase, fx.organizationId, itemId, locationId, "THIRTY_DAYS");
    expect(trend).toHaveLength(0);
  });
});
