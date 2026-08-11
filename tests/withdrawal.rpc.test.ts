import { beforeAll, describe, expect, it } from "vitest";
import { recordInventoryWithdrawal } from "@/app/lib/inventory/withdrawal";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- not run in CI (`npm test` does not include
 * this file; run explicitly via `npm run test:integration`).
 *
 * Every successful call permanently writes to inventory_movements /
 * inventory_movement_lines / audit_events in the linked
 * gansevoort-ops-dev database: those tables are append-only even for
 * service_role (forbid_update_delete trigger), so there is no cleanup path.
 * This is a deliberate, documented tradeoff -- see the plan's "RPC test
 * strategy" decision -- not an oversight.
 */

let fx: RpcTestFixtures;

async function movementCountFor(stationId: string, appUserId: string): Promise<number> {
  const { count, error } = await fx.supabase
    .from("inventory_movements")
    .select("id", { count: "exact", head: true })
    .eq("station_id", stationId)
    .eq("performed_by_app_user_id", appUserId);
  if (error) throw error;
  return count ?? 0;
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

describe("record_inventory_withdrawal", () => {
  it("records a variable-weight withdrawal (BOX entered, actual LB measured)", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "2",
      enteredUnitId: fx.variableWeightBoxUnitId,
      measuredBaseQuantity: "8",
    });
    expect(result.normalizedBaseQuantity).toBe("8");
    expect(result.exceptionRaised).toBe(false); // threshold is 10, strict ">"
  });

  it("records a fixed-conversion withdrawal (normalized = entered * conversion_factor)", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.fixedConversionItemId,
      enteredQuantity: "3",
      enteredUnitId: fx.fixedConversionCaseUnitId,
    });
    expect(result.normalizedBaseQuantity).toBe("30"); // 3 * 10
  });

  it("rejects a variable-weight entry missing the required measured quantity, with no partial rows", async () => {
    const before = await movementCountFor(fx.stationId, fx.changeableEmployeeAppUserId);
    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        inventoryItemId: fx.variableWeightItemId,
        enteredQuantity: "1",
        enteredUnitId: fx.variableWeightBoxUnitId,
        // measuredBaseQuantity intentionally omitted
      })
    ).rejects.toThrow();
    const after = await movementCountFor(fx.stationId, fx.changeableEmployeeAppUserId);
    expect(after).toBe(before); // proves the whole call rolled back, not just the failing statement
  });

  it("rejects an item/unit combination that was never configured", async () => {
    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        inventoryItemId: fx.variableWeightItemId,
        enteredQuantity: "1",
        enteredUnitId: fx.wrongUnitId, // GAL was never added to this item's inventory_item_units
      })
    ).rejects.toThrow();
  });

  it("rejects an inactive app_user", async () => {
    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.inactiveEmployeeAppUserId,
        stationId: fx.stationId,
        inventoryItemId: fx.noRuleItemId,
        enteredQuantity: "1",
        enteredUnitId: fx.noRuleUnitId,
      })
    ).rejects.toThrow();
  });

  it("rejects a station other than the default for an employee locked to it (auto_resolve, cannot change)", async () => {
    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.lockedEmployeeAppUserId,
        stationId: fx.otherStationId,
        inventoryItemId: fx.noRuleItemId,
        enteredQuantity: "1",
        enteredUnitId: fx.noRuleUnitId,
      })
    ).rejects.toThrow();
  });

  it("allows an employee with can_change_station=true to withdraw at a non-default active station", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.otherStationId,
      inventoryItemId: fx.noRuleItemId,
      enteredQuantity: "1",
      enteredUnitId: fx.noRuleUnitId,
    });
    expect(result.movementId).toBeTruthy();
  });

  it("does not raise a HIGH_WITHDRAWAL exception exactly at the threshold (strict >)", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "1",
      enteredUnitId: fx.variableWeightBoxUnitId,
      measuredBaseQuantity: "10", // threshold is exactly 10
    });
    expect(result.exceptionRaised).toBe(false);
  });

  it("raises a HIGH_WITHDRAWAL exception one unit over the threshold, and still succeeds", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "1",
      enteredUnitId: fx.variableWeightBoxUnitId,
      measuredBaseQuantity: "10.01",
    });
    expect(result.exceptionRaised).toBe(true);
    expect(result.exceptionId).toBeTruthy();

    const { data: exceptionRow, error } = await fx.supabase
      .from("exceptions")
      .select("*")
      .eq("id", result.exceptionId!)
      .single();
    expect(error).toBeNull();
    expect(exceptionRow.exception_type).toBe("HIGH_WITHDRAWAL");
    expect(exceptionRow.source_movement_id).toBe(result.movementId);
  });

  it("creates exactly one audit_events row per successful call", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.fixedConversionItemId,
      enteredQuantity: "1",
      enteredUnitId: fx.fixedConversionCaseUnitId,
    });

    const { data: auditRows, error } = await fx.supabase
      .from("audit_events")
      .select("*")
      .eq("entity_id", result.movementId)
      .eq("action", "INVENTORY_WITHDRAWAL_RECORDED");
    expect(error).toBeNull();
    expect(auditRows).toHaveLength(1);
    expect(auditRows![0].entity_type).toBe("inventory_movement");
  });
});
