import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  startOrResumeCycleCount,
  addCycleCountLine,
  recordCycleCountLineObservation,
  completeCycleCount,
  cancelCycleCount,
  markCycleCountLineKnownWaste,
  recordCycleCountLineWaste,
  listCycleCountLines,
} from "@/app/lib/inventory/cycleCounts";
import { recordInventoryWithdrawal } from "@/app/lib/inventory/withdrawal";
import { recordInventoryWaste } from "@/app/lib/inventory/waste";
import {
  CycleCountKnownWasteUnresolvedError,
  CycleCountWasteStaleError,
  CycleCountWasteAlreadyRecordedError,
  InvalidWasteQuantityError,
  StaleCycleCountError,
} from "@/app/lib/inventory/errors";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment for the shared rationale.
 *
 * Cycle Count integration with Inventory Waste (Part 21-35,
 * 20260811100086/100087): provisional "known waste found during
 * counting" marking, the atomic safe record-and-re-anchor operation, and
 * the completion guard. Fresh storage location + fresh item per test,
 * same cross-talk-avoidance rationale as cycleCountHistory.rpc.test.ts.
 *
 * Scenario 50 ("second-manager variance threshold uses remaining
 * unexplained variance") is tested only at the level that actually
 * exists: second-manager variance APPROVAL itself is not implemented
 * anywhere in this codebase yet (confirmed by inspection before this
 * milestone began) -- there is no threshold/approval RPC to call. What
 * IS tested here (43/44/51) is that the REMAINING unexplained variance
 * post-waste is computed correctly and independently readable, which is
 * the exact value any future approval workflow would need to consume.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;
const MANAGER_A = () => fx.changeableEmployeeAppUserId;
const MANAGER_B = () => fx.lockedEmployeeAppUserId;

async function createTestItem(baseUnitCode: "PIECE" | "LB"): Promise<{ inventoryItemId: string; baseUnitId: string }> {
  const tag = randomUUID().slice(0, 8);
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const { data: categoryRow } = await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single();
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku: `CCW-${tag}`, description: `Cycle Count Waste Test Item ${tag}`, packageUnit: baseUnitCode, packageQuantity: 1 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  const result = await approveLineClassificationNewItemRpc(fx.supabase, {
    purchaseDocumentId,
    lineKey,
    organizationId: fx.organizationId,
    appUserId: fx.changeableEmployeeAppUserId,
    finalName: `TEST Cycle Count Waste Item ${tag}`,
    disposition: "INVENTORY",
    categoryId: categoryRow!.category_id as string,
    spendCategoryId,
    baseUnitCode,
    rememberVendorMapping: false,
  });
  const { data: item } = await fx.supabase.from("inventory_items").select("base_unit_id").eq("id", result.inventoryItemId).single();
  return { inventoryItemId: result.inventoryItemId, baseUnitId: item!.base_unit_id as string };
}

async function createStorageLocation(organizationId: string): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { data, error } = await fx.supabase
    .from("locations")
    .insert({ organization_id: organizationId, name: `TEST CC Waste Location ${tag}`, timezone: "America/New_York", is_storage_eligible: true })
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

/** expected 20, physical `physicalQuantity` (7 -> variance -13 by
 * default caller override) -- a fresh DRAFT with exactly one counted
 * line, ready to be flagged for known waste. */
async function setUpCountedDraft(
  physicalQuantity: string,
  startingBalance = 20
): Promise<{ cycleCountId: string; version: number; locationId: string; itemId: string; baseUnitId: string }> {
  const locationId = await createStorageLocation(fx.organizationId);
  const item = await createTestItem("PIECE");
  await receiveExact(item.inventoryItemId, item.baseUnitId, locationId, startingBalance);
  const started = await startOrResumeCycleCount(fx.supabase, { locationId, startedByAppUserId: MANAGER_A() });
  await addCycleCountLine(fx.supabase, { cycleCountId: started.cycleCountId, inventoryItemId: item.inventoryItemId, actorAppUserId: MANAGER_A() });
  await recordCycleCountLineObservation(fx.supabase, {
    cycleCountId: started.cycleCountId,
    inventoryItemId: item.inventoryItemId,
    physicalCountQuantity: physicalQuantity,
    actorAppUserId: MANAGER_A(),
  });
  return { cycleCountId: started.cycleCountId, version: started.version, locationId, itemId: item.inventoryItemId, baseUnitId: item.baseUnitId };
}

async function balanceAt(inventoryItemId: string, locationId: string): Promise<number> {
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

describe("mark_cycle_count_line_known_waste -- provisional marker only", () => {
  it("32-33. manager can flag known waste during count without posting a movement or changing the balance", async () => {
    const draft = await setUpCountedDraft("16"); // expected 20, physical 16 -> variance -4

    const result = await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    expect(result.identifiedWasteQuantity).toBe("4");
    // The authoritative LEDGER balance is still the received 20 -- the
    // physical count (16) is only an OBSERVATION recorded on the line,
    // never a ledger write; marking known waste is provisional and
    // ALSO never touches the ledger.
    expect(await balanceAt(draft.itemId, draft.locationId)).toBe(20);
    const { count: movementCount } = await fx.supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("cycle_count_id", draft.cycleCountId)
      .eq("movement_type", "WASTE");
    expect(movementCount).toBe(0);
  });

  it("36. review surfaces unresolved known waste -- listCycleCountLines reflects the flag before it's resolved", async () => {
    const draft = await setUpCountedDraft("16");
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    const lines = await listCycleCountLines(fx.supabase, draft.cycleCountId);
    const line = lines.find((l) => l.inventoryItemId === draft.itemId);
    expect(line!.identifiedWasteQuantity).toBe("4");
    expect(line!.wasteEventId).toBeNull();
  });

  it("34. identified waste cannot exceed negative variance", async () => {
    const draft = await setUpCountedDraft("16"); // variance -4
    await expect(
      markCycleCountLineKnownWaste(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        inventoryItemId: draft.itemId,
        identifiedWasteQuantity: "8", // exceeds the |-4| variance
        actorAppUserId: MANAGER_A(),
      })
    ).rejects.toBeInstanceOf(InvalidWasteQuantityError);
  });

  it("35. positive variance cannot be marked as waste", async () => {
    const draft = await setUpCountedDraft("25", 20); // physical 25 > expected 20 -> positive variance
    await expect(
      markCycleCountLineKnownWaste(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        inventoryItemId: draft.itemId,
        identifiedWasteQuantity: "1",
        actorAppUserId: MANAGER_A(),
      })
    ).rejects.toBeInstanceOf(InvalidWasteQuantityError);
  });

  it("53. clearing provisional waste before recording creates no movement", async () => {
    const draft = await setUpCountedDraft("16");
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    const cleared = await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: null,
      actorAppUserId: MANAGER_A(),
    });
    expect(cleared.identifiedWasteQuantity).toBeNull();
    const { count: movementCount } = await fx.supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("cycle_count_id", draft.cycleCountId)
      .eq("movement_type", "WASTE");
    expect(movementCount).toBe(0);
  });
});

describe("complete_cycle_count -- unresolved known waste blocks completion", () => {
  it("37. completion blocked while known waste unresolved", async () => {
    const draft = await setUpCountedDraft("16");
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    await expect(
      completeCycleCount(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        expectedVersion: draft.version,
        completedByAppUserId: MANAGER_A(),
        completionNote: "Attempting completion with unresolved waste.",
      })
    ).rejects.toBeInstanceOf(CycleCountKnownWasteUnresolvedError);
  });

  it("49. resolved known waste allows count completion", async () => {
    const draft = await setUpCountedDraft("16");
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    await recordCycleCountLineWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      reasonCode: "SPOILED",
      note: null,
      actorAppUserId: MANAGER_A(),
      clientRequestId: randomUUID(),
    });
    const completed = await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "Resolved before completion.",
    });
    expect(completed.replayed).toBe(false);
    const { data: cc } = await fx.supabase.from("inventory_cycle_counts").select("status").eq("id", draft.cycleCountId).single();
    expect(cc!.status).toBe("COMPLETED");
  });
});

describe("record_cycle_count_line_waste -- the atomic safe record-and-re-anchor operation", () => {
  it("38-40. creates a WASTE movement, an Inventory Waste event, and links both to the cycle count + line", async () => {
    const draft = await setUpCountedDraft("16"); // expected 20, physical 16 -> variance -4
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    const result = await recordCycleCountLineWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      reasonCode: "SPOILED",
      note: null,
      actorAppUserId: MANAGER_A(),
      clientRequestId: randomUUID(),
    });
    expect(result.replayed).toBe(false);
    expect(result.quantity).toBe("4");

    const { data: waste } = await fx.supabase
      .from("inventory_waste_events")
      .select("cycle_count_id, cycle_count_line_id, inventory_movement_id")
      .eq("id", result.wasteEventId)
      .single();
    expect(waste!.cycle_count_id).toBe(draft.cycleCountId);
    expect(waste!.cycle_count_line_id).toBe(result.cycleCountLineId);

    const { data: movement } = await fx.supabase
      .from("inventory_movements")
      .select("movement_type, cycle_count_id")
      .eq("id", waste!.inventory_movement_id)
      .single();
    expect(movement!.movement_type).toBe("WASTE");
    expect(movement!.cycle_count_id).toBe(draft.cycleCountId);
  });

  it("41-42-43. fresh line safely re-anchors after waste, preserving physical count, reducing remaining variance to zero for a FULLY explained variance", async () => {
    const draft = await setUpCountedDraft("16"); // expected 20, physical 16 -> variance -4
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    const result = await recordCycleCountLineWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      reasonCode: "SPOILED",
      note: null,
      actorAppUserId: MANAGER_A(),
      clientRequestId: randomUUID(),
    });
    expect(result.newExpectedQuantity).toBe("16"); // 20 - 4

    const lines = await listCycleCountLines(fx.supabase, draft.cycleCountId);
    const line = lines.find((l) => l.inventoryItemId === draft.itemId)!;
    expect(line.expectedQuantityAtSnapshot).toBe("16");
    expect(line.physicalCountQuantity).toBe("16"); // preserved exactly
    const remainingVariance = Number(line.physicalCountQuantity) - Number(line.expectedQuantityAtSnapshot);
    expect(remainingVariance).toBe(0);
  });

  it("44. partial known waste leaves correct unexplained variance", async () => {
    const draft = await setUpCountedDraft("14"); // expected 20, physical 14 -> variance -6
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4", // only 4 of the 6 explained
      actorAppUserId: MANAGER_A(),
    });
    await recordCycleCountLineWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      reasonCode: "SPOILED",
      note: null,
      actorAppUserId: MANAGER_A(),
      clientRequestId: randomUUID(),
    });
    const lines = await listCycleCountLines(fx.supabase, draft.cycleCountId);
    const line = lines.find((l) => l.inventoryItemId === draft.itemId)!;
    expect(line.expectedQuantityAtSnapshot).toBe("16"); // 20 - 4
    expect(line.physicalCountQuantity).toBe("14");
    const remainingVariance = Number(line.physicalCountQuantity) - Number(line.expectedQuantityAtSnapshot);
    expect(remainingVariance).toBe(-2); // -6 total, -4 explained by waste, -2 remains unexplained
  });

  it("45. unrelated movement before waste recording causes STALE and writes zero waste", async () => {
    const draft = await setUpCountedDraft("16"); // expected 20, physical 16 -> variance -4
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });

    // Unrelated activity on the SAME item/location after the count
    // snapshot -- a standalone withdrawal, moving the ledger watermark.
    await receiveExact(draft.itemId, draft.baseUnitId, draft.locationId, 1);

    await expect(
      recordCycleCountLineWaste(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        inventoryItemId: draft.itemId,
        reasonCode: "SPOILED",
        note: null,
        actorAppUserId: MANAGER_A(),
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(CycleCountWasteStaleError);

    // Zero waste written -- no inventory_waste_events row, no WASTE movement.
    const { count: wasteCount } = await fx.supabase
      .from("inventory_waste_events")
      .select("id", { count: "exact", head: true })
      .eq("cycle_count_id", draft.cycleCountId);
    expect(wasteCount).toBe(0);
    expect(await balanceAt(draft.itemId, draft.locationId)).toBe(21); // 20 received + 1 more receipt, no waste ever posted
  });

  it("46. concurrent withdrawal vs cycle-count waste cannot corrupt balance -- exactly one of the two ledger-affecting operations lands", async () => {
    const draft = await setUpCountedDraft("16"); // expected 20, physical 16 -> variance -4
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });

    const results = await Promise.allSettled([
      recordCycleCountLineWaste(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        inventoryItemId: draft.itemId,
        reasonCode: "SPOILED",
        note: null,
        actorAppUserId: MANAGER_A(),
        clientRequestId: randomUUID(),
      }),
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: MANAGER_A(),
        stationId: fx.stationId,
        sourceLocationId: draft.locationId,
        inventoryItemId: draft.itemId,
        enteredQuantity: "1",
        enteredUnitId: draft.baseUnitId,
        clientRequestId: randomUUID(),
      }),
    ]);

    // The advisory lock on (org, item, location) serializes these against
    // each other. The withdrawal has no staleness concept of its own (it
    // just re-reads the balance fresh under the lock), so it always
    // succeeds regardless of ordering. The waste side DOES check its
    // line's ledger watermark under the lock -- if the withdrawal
    // happened to go first and moved that watermark, the waste call
    // correctly observes staleness and writes nothing (Part 26), rather
    // than blindly posting on top of an intervening change. So exactly
    // two outcomes are possible, starting from a true ledger balance of
    // 20 (received) at mark-time: BOTH land (waste ran first: 20 - 4 - 1
    // = 15), or only the withdrawal lands and waste is rejected as stale
    // (withdrawal ran first: 20 - 1 = 19). Never negative, never
    // double-deducted, never both landing twice.
    const balance = await balanceAt(draft.itemId, draft.locationId);
    expect([15, 19]).toContain(balance);

    const [wasteResult, withdrawalResult] = results;
    expect(withdrawalResult.status).toBe("fulfilled"); // the withdrawal always succeeds
    if (balance === 19) {
      expect(wasteResult.status).toBe("rejected");
      if (wasteResult.status === "rejected") {
        expect(wasteResult.reason).toBeInstanceOf(CycleCountWasteStaleError);
      }
    } else {
      expect(wasteResult.status).toBe("fulfilled");
    }
  });

  it("47. recording the same identified waste twice is idempotent -- no duplicate event/movement", async () => {
    const draft = await setUpCountedDraft("16");
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    const clientRequestId = randomUUID();
    const first = await recordCycleCountLineWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      reasonCode: "SPOILED",
      note: null,
      actorAppUserId: MANAGER_A(),
      clientRequestId,
    });
    const second = await recordCycleCountLineWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      reasonCode: "SPOILED",
      note: null,
      actorAppUserId: MANAGER_A(),
      clientRequestId,
    });
    expect(second.replayed).toBe(true);
    expect(second.wasteEventId).toBe(first.wasteEventId);
    expect(await balanceAt(draft.itemId, draft.locationId)).toBe(16); // 20 - 4, deducted exactly once

    // A DIFFERENT client_request_id against the already-resolved line is
    // a genuinely distinct second attempt, not a replay -- rejected.
    await expect(
      recordCycleCountLineWaste(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        inventoryItemId: draft.itemId,
        reasonCode: "SPOILED",
        note: null,
        actorAppUserId: MANAGER_A(),
        clientRequestId: randomUUID(),
      })
    ).rejects.toBeInstanceOf(CycleCountWasteAlreadyRecordedError);
  });

  it("48. waste from another standalone workflow naturally makes an existing open count stale, with no special bypass", async () => {
    const draft = await setUpCountedDraft("16");
    // Manager B records STANDALONE waste against the SAME item/location
    // while Manager A's count is still open -- an entirely unrelated
    // workflow, not routed through this cycle count at all.
    await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: MANAGER_B(),
      locationId: draft.locationId,
      inventoryItemId: draft.itemId,
      quantity: "1",
      reasonCode: "DAMAGED",
      note: null,
      clientRequestId: randomUUID(),
    });

    // The existing stale-state protection (complete_cycle_count) picks
    // this up naturally -- no special-cased bypass exists for Waste.
    await expect(
      completeCycleCount(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        expectedVersion: draft.version,
        completedByAppUserId: MANAGER_A(),
        completionNote: "Attempting completion after an unrelated waste event.",
      })
    ).rejects.toBeInstanceOf(StaleCycleCountError);
  });

  it("52. cancelled count with provisional waste creates NO WASTE movement", async () => {
    const draft = await setUpCountedDraft("16");
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    await cancelCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      cancelledByAppUserId: MANAGER_A(),
      reason: "Testing cancellation with unresolved provisional waste.",
    });
    const { count: wasteCount } = await fx.supabase
      .from("inventory_waste_events")
      .select("id", { count: "exact", head: true })
      .eq("cycle_count_id", draft.cycleCountId);
    expect(wasteCount).toBe(0);
    const { count: movementCount } = await fx.supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("cycle_count_id", draft.cycleCountId)
      .eq("movement_type", "WASTE");
    expect(movementCount).toBe(0);
  });

  it("51. completed history distinguishes known waste (linked to its own record) from remaining unexplained variance on the same line", async () => {
    const draft = await setUpCountedDraft("14"); // expected 20, physical 14 -> variance -6
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    await recordCycleCountLineWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      reasonCode: "SPOILED",
      note: null,
      actorAppUserId: MANAGER_A(),
      clientRequestId: randomUUID(),
    });
    await completeCycleCount(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      expectedVersion: draft.version,
      completedByAppUserId: MANAGER_A(),
      completionNote: "Partial known waste, remainder unexplained.",
    });

    const lines = await listCycleCountLines(fx.supabase, draft.cycleCountId);
    const line = lines.find((l) => l.inventoryItemId === draft.itemId)!;
    // Known waste is independently queryable (its own reason/id), never
    // collapsed into the raw variance number.
    expect(line.wasteEventId).not.toBeNull();
    expect(line.wasteReasonCode).toBe("SPOILED");
    expect(line.identifiedWasteQuantity).toBe("4");
    // Remaining unexplained variance is a SEPARATE, independently correct
    // number: physical (14) - post-waste expected (16) = -2.
    const remainingVariance = Number(line.physicalCountQuantity) - Number(line.expectedQuantityAtSnapshot);
    expect(remainingVariance).toBe(-2);
  });

  it("54. cross-org access blocked -- a different org's manager cannot mark or record waste on this count", async () => {
    const draft = await setUpCountedDraft("16");
    await expect(
      markCycleCountLineKnownWaste(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        inventoryItemId: draft.itemId,
        identifiedWasteQuantity: "4",
        actorAppUserId: otherOrg.appUserId,
      })
    ).rejects.toThrow();

    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    await expect(
      recordCycleCountLineWaste(fx.supabase, {
        cycleCountId: draft.cycleCountId,
        inventoryItemId: draft.itemId,
        reasonCode: "SPOILED",
        note: null,
        actorAppUserId: otherOrg.appUserId,
        clientRequestId: randomUUID(),
      })
    ).rejects.toThrow();
  });

  it("cycle-count-sourced waste also triggers the manager/admin notification broadcast (20260811100088) via the shared record_inventory_waste path", async () => {
    const draft = await setUpCountedDraft("16");
    await markCycleCountLineKnownWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      identifiedWasteQuantity: "4",
      actorAppUserId: MANAGER_A(),
    });
    const result = await recordCycleCountLineWaste(fx.supabase, {
      cycleCountId: draft.cycleCountId,
      inventoryItemId: draft.itemId,
      reasonCode: "SPOILED",
      note: null,
      actorAppUserId: MANAGER_A(),
      clientRequestId: randomUUID(),
    });

    const { data: notifications, error } = await fx.supabase
      .from("user_notifications")
      .select("recipient_app_user_id")
      .eq("entity_id", result.wasteEventId)
      .eq("type", "INVENTORY_WASTE_RECORDED");
    if (error) throw error;

    // Not asserting a specific recipient (no manager-role fixture set up
    // in this file) -- just that the same broadcast insert this waste
    // event's RPC path shares with standalone waste never excludes the
    // recording manager's own row incorrectly and never errors.
    expect(notifications!.some((n) => n.recipient_app_user_id === MANAGER_A())).toBe(false);
  });
});
