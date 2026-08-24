import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  startOrResumeCycleCount,
  addCycleCountLine,
  recordCycleCountLineObservation,
  completeCycleCount,
  cancelCycleCount,
} from "@/app/lib/inventory/cycleCounts";
import { recordInventoryWithdrawal } from "@/app/lib/inventory/withdrawal";
import { StaleCycleCountError, CycleCountLockedError, InvalidStorageLocationError } from "@/app/lib/inventory/errors";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment for the shared rationale.
 *
 * Cycle Counts / physical inventory reconciliation
 * (20260811100081_cycle_counts.sql). Every test creates its OWN fresh
 * storage location (never the canonical fixture org's shared location) --
 * the "at most one DRAFT per (organization, location)" constraint and the
 * stale-watermark mechanism are both scoped per-location, so a shared
 * location would make tests interfere with each other AND with whatever
 * else the parallel integration suite is doing at the same location (see
 * this session's own withdrawal.rpc.test.ts cross-talk fix for exactly
 * this class of bug). Every item is similarly a fresh, uniquely-named
 * CONFIRMED inventory item per test/group, for the same reason.
 *
 * KNOWN GAP: tests 28-30 (completed/zero-variance count clearing
 * includes_legacy_estimate, scoped per item+location) are NOT included
 * here. inventory_legacy_location_allocations only ever receives rows from
 * 20260811100073's one-time migration-time INSERT -- service_role has
 * SELECT only on that table (by design, matching "frozen forever, never
 * recomputed"), so no test fixture can seed a legacy-allocation row to
 * exercise the true-\>false transition. The list_inventory_balances SQL
 * change (Part 19) was reviewed carefully instead; if you want this
 * empirically covered, it needs either a seeded pre-2A.5-shaped fixture
 * org or a narrowly-scoped test-only grant, neither of which this file
 * adds unilaterally.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;

async function createTestItem(baseUnitCode: "PIECE" | "LB"): Promise<{ inventoryItemId: string; baseUnitId: string }> {
  const tag = randomUUID().slice(0, 8);
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: categoryRow } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `CC-${tag}`, description: `Cycle Count Test Item ${tag}`, packageUnit: baseUnitCode, packageQuantity: 1 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  const result = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Cycle Count Item ${tag}`,
    disposition: "INVENTORY",
    categoryId: categoryRow!.category_id as string,
    spendCategoryId,
    baseUnitCode,
    rememberVendorMapping: false,
  });
  const { data: item } = await fx.supabase.from("inventory_items").select("base_unit_id").eq("id", result.inventoryItemId).single();
  return { inventoryItemId: result.inventoryItemId, baseUnitId: item!.base_unit_id as string };
}

async function createStorageLocation(organizationId: string, opts?: { isStorageEligible?: boolean; isActive?: boolean }): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { data, error } = await fx.supabase
    .from("locations")
    .insert({
      organization_id: organizationId,
      name: `TEST Cycle Count Location ${tag}`,
      timezone: "America/New_York",
      is_storage_eligible: opts?.isStorageEligible ?? true,
      is_active: opts?.isActive ?? true,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
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

async function getBalance(inventoryItemId: string, locationId: string): Promise<number> {
  const { data, error } = await fx.supabase.rpc("inventory_location_item_balance", {
    p_organization_id: fx.organizationId,
    p_inventory_item_id: inventoryItemId,
    p_location_id: locationId,
  });
  if (error) throw error;
  return Number(data);
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
}, 60_000);

describe("start_or_resume_cycle_count", () => {
  it("1. starts a fresh DRAFT at an active, storage-eligible location", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const result = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    expect(result.status).toBe("DRAFT");
    expect(result.resumed).toBe(false);
    expect(result.version).toBe(1);
  });

  it("2. rejects a non-storage-eligible location", async () => {
    const locationId = await createStorageLocation(fx.organizationId, { isStorageEligible: false });
    await expect(startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId })).rejects.toThrow(
      InvalidStorageLocationError
    );
  });

  it("3. org isolation -- a location in a different organization is rejected outright", async () => {
    const otherOrgLocationId = await createStorageLocation(otherOrg.organizationId);
    await expect(
      startOrResumeCycleCount(fx.supabase, { locationId: otherOrgLocationId, startedByAppUserId: fx.changeableEmployeeAppUserId })
    ).rejects.toThrow(InvalidStorageLocationError);
  });

  it("4-5. only one open DRAFT per location -- a second start resumes the same one, never creates a competitor", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const first = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    expect(first.resumed).toBe(false);

    const second = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    expect(second.resumed).toBe(true);
    expect(second.cycleCountId).toBe(first.cycleCountId);

    const { count } = await fx.supabase
      .from("inventory_cycle_counts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("location_id", locationId)
      .eq("status", "DRAFT");
    expect(count).toBe(1);
  });
});

describe("add_cycle_count_line", () => {
  it("15-16. a zero-system-stock item can be added and counted upward", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("PIECE");

    const added = await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    expect(Number(added.expectedQuantityAtSnapshot)).toBe(0);
    expect(added.baseUnitId).toBe(item.baseUnitId);
    expect(added.alreadyExisted).toBe(false);

    const secondAdd = await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    expect(secondAdd.alreadyExisted).toBe(true);
    expect(secondAdd.lineId).toBe(added.lineId);

    await recordCycleCountLineObservation(fx.supabase, {
      cycleCountId: cycleCount.cycleCountId,
      inventoryItemId: item.inventoryItemId,
      physicalCountQuantity: "3",
      actorAppUserId: fx.changeableEmployeeAppUserId,
    });

    const result = await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });
    expect(result.inMovementId).not.toBeNull();
    expect(result.outMovementId).toBeNull();
    expect(await getBalance(item.inventoryItemId, locationId)).toBe(3);
  });

  it("32. an inactive item cannot be newly added to a cycle count", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("PIECE");
    await fx.supabase.from("inventory_items").update({ status: "inactive" }).eq("id", item.inventoryItemId);

    await expect(
      addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId })
    ).rejects.toThrow(/not an active item/);
  });
});

describe("record_cycle_count_line_observation -- blank vs explicit zero, validation", () => {
  it("7-8. blank (null) never means zero; an explicit 0 is a genuine physical observation", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const counted = await createTestItem("PIECE");
    const untouched = await createTestItem("PIECE");
    await receiveExact(counted.inventoryItemId, counted.baseUnitId, locationId, 5);
    await receiveExact(untouched.inventoryItemId, untouched.baseUnitId, locationId, 5);

    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: counted.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: untouched.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });

    // untouched: never given a physical count at all -- must stay 5, untouched.
    await recordCycleCountLineObservation(fx.supabase, {
      cycleCountId: cycleCount.cycleCountId,
      inventoryItemId: counted.inventoryItemId,
      physicalCountQuantity: "0",
      actorAppUserId: fx.changeableEmployeeAppUserId,
    });

    const result = await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });
    expect(result.countedLineCount).toBe(1); // only the explicitly-zeroed item, never the untouched one
    expect(await getBalance(counted.inventoryItemId, locationId)).toBe(0);
    expect(await getBalance(untouched.inventoryItemId, locationId)).toBe(5); // Part 6, 31: partial count leaves the rest alone
  });

  it("34. rejects a negative physical count; accepts a WEIGHT-type decimal", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("LB");
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });

    await expect(
      recordCycleCountLineObservation(fx.supabase, {
        cycleCountId: cycleCount.cycleCountId,
        inventoryItemId: item.inventoryItemId,
        physicalCountQuantity: "-1",
        actorAppUserId: fx.changeableEmployeeAppUserId,
      })
    ).rejects.toThrow(/must not be negative/);

    const observed = await recordCycleCountLineObservation(fx.supabase, {
      cycleCountId: cycleCount.cycleCountId,
      inventoryItemId: item.inventoryItemId,
      physicalCountQuantity: "4.75",
      actorAppUserId: fx.changeableEmployeeAppUserId,
    });
    expect(Number(observed.physicalCountQuantity)).toBe(4.75);
  });
});

describe("complete_cycle_count -- variance direction, grouping, balance", () => {
  it("9. expected 12, physical 9 -> single COUNT_ADJUSTMENT_OUT of 3", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 12);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "9", actorAppUserId: fx.changeableEmployeeAppUserId });

    const result = await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });
    expect(result.inMovementId).toBeNull();
    expect(result.outMovementId).not.toBeNull();

    const { data: movement } = await fx.supabase.from("inventory_movements").select("movement_type").eq("id", result.outMovementId!).single();
    expect(movement!.movement_type).toBe("COUNT_ADJUSTMENT_OUT");
    const { data: line } = await fx.supabase.from("inventory_movement_lines").select("normalized_base_quantity").eq("movement_id", result.outMovementId!).single();
    expect(Number(line!.normalized_base_quantity)).toBe(3);

    expect(await getBalance(item.inventoryItemId, locationId)).toBe(9); // Part 20: balance equals physical exactly
  });

  it("10. expected 8, physical 10 -> single COUNT_ADJUSTMENT_IN of 2", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("PIECE");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 8);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "10", actorAppUserId: fx.changeableEmployeeAppUserId });

    const result = await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });
    expect(result.outMovementId).toBeNull();
    expect(result.inMovementId).not.toBeNull();
    const { data: line } = await fx.supabase.from("inventory_movement_lines").select("normalized_base_quantity").eq("movement_id", result.inMovementId!).single();
    expect(Number(line!.normalized_base_quantity)).toBe(2);
    expect(await getBalance(item.inventoryItemId, locationId)).toBe(10);
  });

  it("11. equal count -> no movement, but still a completed reconciliation fact", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("PIECE");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 5);
    const line = await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "5", actorAppUserId: fx.changeableEmployeeAppUserId });

    const result = await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });
    expect(result.inMovementId).toBeNull();
    expect(result.outMovementId).toBeNull();
    expect(result.countedLineCount).toBe(1);
    expect(result.varianceLineCount).toBe(0);

    const { data: lineRow } = await fx.supabase.from("inventory_cycle_count_lines").select("physical_count_quantity").eq("id", line.lineId).single();
    expect(Number(lineRow!.physical_count_quantity)).toBe(5); // still a stored, completed physical observation
  });

  it("12-13. mixed IN + OUT across several items groups into at most two movements", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });

    const heavyCream = await createTestItem("LB");
    const oatMilk = await createTestItem("PIECE");
    const chicken = await createTestItem("LB");
    const anotherUp = await createTestItem("PIECE");

    await receiveExact(heavyCream.inventoryItemId, heavyCream.baseUnitId, locationId, 12);
    await receiveExact(oatMilk.inventoryItemId, oatMilk.baseUnitId, locationId, 8);
    await receiveExact(chicken.inventoryItemId, chicken.baseUnitId, locationId, 5);
    await receiveExact(anotherUp.inventoryItemId, anotherUp.baseUnitId, locationId, 1);

    for (const [item, qty] of [
      [heavyCream, "9"],
      [oatMilk, "10"],
      [chicken, "5"],
      [anotherUp, "4"],
    ] as const) {
      await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
      await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: qty, actorAppUserId: fx.changeableEmployeeAppUserId });
    }

    const result = await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });
    expect(result.countedLineCount).toBe(4);
    expect(result.varianceLineCount).toBe(3); // chicken is zero-variance, no line for it

    const { data: outLines } = await fx.supabase.from("inventory_movement_lines").select("inventory_item_id, normalized_base_quantity").eq("movement_id", result.outMovementId!);
    expect(outLines).toHaveLength(1); // only heavyCream
    expect(outLines![0].inventory_item_id).toBe(heavyCream.inventoryItemId);

    const { data: inLines } = await fx.supabase.from("inventory_movement_lines").select("inventory_item_id, normalized_base_quantity").eq("movement_id", result.inMovementId!);
    expect(inLines).toHaveLength(2); // oatMilk + anotherUp, grouped into ONE movement
    expect(new Set(inLines!.map((l) => l.inventory_item_id))).toEqual(new Set([oatMilk.inventoryItemId, anotherUp.inventoryItemId]));

    // Exactly one movement of each direction for the whole session (Part 16).
    const { count: inCount } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("cycle_count_id", cycleCount.cycleCountId).eq("movement_type", "COUNT_ADJUSTMENT_IN");
    const { count: outCount } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("cycle_count_id", cycleCount.cycleCountId).eq("movement_type", "COUNT_ADJUSTMENT_OUT");
    expect(inCount).toBe(1);
    expect(outCount).toBe(1);
  });

  it("27. a COUNT adjustment never resets the manager's full-stock reference", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("PIECE");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 5);

    const { count: referencesBefore } = await fx.supabase
      .from("inventory_stock_references")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", item.inventoryItemId)
      .eq("location_id", locationId);

    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "20", actorAppUserId: fx.changeableEmployeeAppUserId });
    await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });

    const { count: referencesAfter } = await fx.supabase
      .from("inventory_stock_references")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("inventory_item_id", item.inventoryItemId)
      .eq("location_id", locationId);
    expect(referencesAfter).toBe(referencesBefore); // untouched, even though the count found MORE than expected
  });

  it("31. counting one item never affects a sibling item's balance", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const counted = await createTestItem("PIECE");
    const sibling = await createTestItem("PIECE");
    await receiveExact(counted.inventoryItemId, counted.baseUnitId, locationId, 5);
    await receiveExact(sibling.inventoryItemId, sibling.baseUnitId, locationId, 5);

    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: counted.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: counted.inventoryItemId, physicalCountQuantity: "1", actorAppUserId: fx.changeableEmployeeAppUserId });
    await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });

    expect(await getBalance(counted.inventoryItemId, locationId)).toBe(1);
    expect(await getBalance(sibling.inventoryItemId, locationId)).toBe(5); // never touched
  });
});

describe("complete_cycle_count -- staleness (Part 35's required concurrency scenario)", () => {
  it("17. stale after an intervening withdrawal at the SAME item/location", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 12);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "9", actorAppUserId: fx.changeableEmployeeAppUserId });

    // A withdrawal happens WHILE the manager is (notionally) still walking
    // around counting -- exactly the scenario Part 35 requires.
    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: item.inventoryItemId,
      sourceLocationId: locationId,
      enteredQuantity: "2",
      enteredUnitId: item.baseUnitId,
      clientRequestId: randomUUID(),
    });

    let staleDetail: unknown;
    try {
      await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });
      expect.unreachable("expected StaleCycleCountError");
    } catch (err) {
      expect(err).toBeInstanceOf(StaleCycleCountError);
      staleDetail = (err as StaleCycleCountError).staleLines;
    }
    expect(staleDetail).toEqual([
      expect.objectContaining({
        inventoryItemId: item.inventoryItemId,
        snapshotExpectedQuantity: 12,
        currentExpectedQuantity: 10,
        physicalCountQuantity: 9,
        stale: true,
      }),
    ]);

    // Zero adjustments committed -- balance still reflects only the
    // withdrawal, never the stale physical count.
    expect(await getBalance(item.inventoryItemId, locationId)).toBe(10);
    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("status, version").eq("id", cycleCount.cycleCountId).single();
    expect(cc!.status).toBe("DRAFT");
    expect(cc!.version).toBe(1);
  });

  it("18. stale after an intervening receipt at the SAME item/location", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("PIECE");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 5);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "5", actorAppUserId: fx.changeableEmployeeAppUserId });

    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 3);

    await expect(
      completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." })
    ).rejects.toThrow(StaleCycleCountError);
    expect(await getBalance(item.inventoryItemId, locationId)).toBe(8); // only the receipt, no count adjustment
  });

  it("19. net-zero intervening activity is STILL stale -- the watermark, not the balance, is the signal", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 12);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "9", actorAppUserId: fx.changeableEmployeeAppUserId });

    // +5 receipt, -5 withdrawal -- balance nets back to exactly 12, the
    // same as the snapshot, but the ledger-line-count watermark strictly
    // increased twice.
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 5);
    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: item.inventoryItemId,
      sourceLocationId: locationId,
      enteredQuantity: "5",
      enteredUnitId: item.baseUnitId,
      clientRequestId: randomUUID(),
    });
    expect(await getBalance(item.inventoryItemId, locationId)).toBe(12); // net-zero, confirmed

    await expect(
      completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." })
    ).rejects.toThrow(StaleCycleCountError); // must still be stale, even though currentExpected === snapshotExpected
  });

  it("20. one stale line rolls back adjustments for the ENTIRE count, not just the stale line", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const stale = await createTestItem("LB");
    const fine = await createTestItem("PIECE");
    await receiveExact(stale.inventoryItemId, stale.baseUnitId, locationId, 12);
    await receiveExact(fine.inventoryItemId, fine.baseUnitId, locationId, 8);

    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: stale.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: fine.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: stale.inventoryItemId, physicalCountQuantity: "9", actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: fine.inventoryItemId, physicalCountQuantity: "10", actorAppUserId: fx.changeableEmployeeAppUserId });

    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: stale.inventoryItemId,
      sourceLocationId: locationId,
      enteredQuantity: "1",
      enteredUnitId: stale.baseUnitId,
      clientRequestId: randomUUID(),
    });

    await expect(
      completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." })
    ).rejects.toThrow(StaleCycleCountError);

    // "fine" was never itself stale, but the WHOLE session commits zero
    // adjustments (Part 13-14) -- its balance must be untouched too.
    expect(await getBalance(fine.inventoryItemId, locationId)).toBe(8);
    const { count: movementCount } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("cycle_count_id", cycleCount.cycleCountId);
    expect(movementCount).toBe(0);
  });

  it("recount clears staleness: refreshSnapshot re-anchors the line and allows a subsequent finalize to succeed", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("LB");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 12);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "9", actorAppUserId: fx.changeableEmployeeAppUserId });

    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: item.inventoryItemId,
      sourceLocationId: locationId,
      enteredQuantity: "2",
      enteredUnitId: item.baseUnitId,
      clientRequestId: randomUUID(),
    });

    await expect(
      completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." })
    ).rejects.toThrow(StaleCycleCountError);

    // Recount: new expected is 10, manager confirms 8 now.
    await recordCycleCountLineObservation(fx.supabase, {
      cycleCountId: cycleCount.cycleCountId,
      inventoryItemId: item.inventoryItemId,
      physicalCountQuantity: "8",
      actorAppUserId: fx.changeableEmployeeAppUserId,
      refreshSnapshot: true,
    });

    const result = await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });
    expect(result.outMovementId).not.toBeNull();
    expect(await getBalance(item.inventoryItemId, locationId)).toBe(8);
  });
});

describe("complete_cycle_count -- concurrency, idempotency, immutability", () => {
  it("21-22. concurrent finalization cannot double-adjust", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("PIECE");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 10);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "7", actorAppUserId: fx.changeableEmployeeAppUserId });

    const [a, b] = await Promise.all([
      completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." }),
      completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." }),
    ]);

    expect(a.outMovementId).toBe(b.outMovementId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await getBalance(item.inventoryItemId, locationId)).toBe(7); // exactly once, not twice
    const { count: outCount } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("cycle_count_id", cycleCount.cycleCountId).eq("movement_type", "COUNT_ADJUSTMENT_OUT");
    expect(outCount).toBe(1);
  });

  it("23. completing an already-completed count replays the original result (double-click/retry safe)", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("PIECE");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 6);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "6", actorAppUserId: fx.changeableEmployeeAppUserId });

    const first = await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });
    expect(first.replayed).toBe(false);

    const second = await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });
    expect(second.replayed).toBe(true);
    expect(second.countedLineCount).toBe(first.countedLineCount);
  });

  it("24. a completed count is immutable -- further mutation attempts are rejected", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("PIECE");
    const another = await createTestItem("PIECE");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 3);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "3", actorAppUserId: fx.changeableEmployeeAppUserId });
    await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });

    await expect(
      addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: another.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId })
    ).rejects.toThrow(/not open for counting/);

    await expect(
      recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "99", actorAppUserId: fx.changeableEmployeeAppUserId })
    ).rejects.toThrow(/not open for counting/);

    await expect(
      cancelCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version + 1, cancelledByAppUserId: fx.changeableEmployeeAppUserId, reason: "test" })
    ).rejects.toThrow(CycleCountLockedError);

    // Direct row mutation is ALSO rejected at the DB level (not just via
    // the RPCs' own status checks) -- the append-only-once-locked trigger.
    const { error } = await fx.supabase.from("inventory_cycle_counts").update({ cancellation_reason: "hack" }).eq("id", cycleCount.cycleCountId);
    expect(error).not.toBeNull();
  });
});

describe("cancel_cycle_count", () => {
  it("25-26. cancellation creates no movements and the cancelled count is immutable", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    const item = await createTestItem("PIECE");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 4);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "1", actorAppUserId: fx.changeableEmployeeAppUserId });

    const cancelled = await cancelCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, cancelledByAppUserId: fx.changeableEmployeeAppUserId, reason: "wrong location selected" });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.replayed).toBe(false);

    expect(await getBalance(item.inventoryItemId, locationId)).toBe(4); // untouched -- the "1" physical count never reconciled
    const { count: movementCount } = await fx.supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("cycle_count_id", cycleCount.cycleCountId);
    expect(movementCount).toBe(0);

    await expect(
      completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version + 1, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." })
    ).rejects.toThrow(/cancelled and cannot be completed/);

    // Cancelling an already-cancelled count replays rather than erroring.
    const replay = await cancelCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version + 1, cancelledByAppUserId: fx.changeableEmployeeAppUserId, reason: "n/a" });
    expect(replay.replayed).toBe(true);
  });

  it("rejects an empty cancellation reason", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    await expect(
      cancelCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, cancelledByAppUserId: fx.changeableEmployeeAppUserId, reason: "   " })
    ).rejects.toThrow(/reason is required/);
  });
});

describe("audit events (Part 33)", () => {
  it("35. STARTED, COMPLETED, and CANCELLED each produce exactly one audit event", async () => {
    const locationId = await createStorageLocation(fx.organizationId);
    const cycleCount = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: fx.changeableEmployeeAppUserId });

    const { count: startedCount } = await fx.supabase
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("action", "CYCLE_COUNT_STARTED")
      .eq("entity_id", cycleCount.cycleCountId);
    expect(startedCount).toBe(1);

    const item = await createTestItem("PIECE");
    await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, 2);
    await addCycleCountLine(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: fx.changeableEmployeeAppUserId });
    await recordCycleCountLineObservation(fx.supabase, { cycleCountId: cycleCount.cycleCountId, inventoryItemId: item.inventoryItemId, physicalCountQuantity: "1", actorAppUserId: fx.changeableEmployeeAppUserId });
    await completeCycleCount(fx.supabase, { cycleCountId: cycleCount.cycleCountId, expectedVersion: cycleCount.version, completedByAppUserId: fx.changeableEmployeeAppUserId, completionNote: "Test completion note." });

    const { count: completedCount } = await fx.supabase
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("action", "CYCLE_COUNT_COMPLETED")
      .eq("entity_id", cycleCount.cycleCountId);
    expect(completedCount).toBe(1);

    const otherLocationId = await createStorageLocation(fx.organizationId);
    const another = await startOrResumeCycleCount(fx.supabase, { locationId: otherLocationId, startedByAppUserId: fx.changeableEmployeeAppUserId });
    await cancelCycleCount(fx.supabase, { cycleCountId: another.cycleCountId, expectedVersion: another.version, cancelledByAppUserId: fx.changeableEmployeeAppUserId, reason: "test cancel" });

    const { count: cancelledCount } = await fx.supabase
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("action", "CYCLE_COUNT_CANCELLED")
      .eq("entity_id", another.cycleCountId);
    expect(cancelledCount).toBe(1);
  });
});
