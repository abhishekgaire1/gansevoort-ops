import { randomUUID } from "node:crypto";
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
 *
 * Every recordInventoryWithdrawal call below supplies a fresh
 * randomUUID() as clientRequestId (required as of
 * 20260811100015_withdrawal_idempotency.sql) so that ordinary,
 * non-idempotency-focused tests never collide with each other or with a
 * prior run. The dedicated "idempotency" describe block below is the only
 * place a clientRequestId is deliberately reused across calls.
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
      clientRequestId: randomUUID(),
    });
    expect(result.normalizedBaseQuantity).toBe("8");
    expect(result.exceptionRaised).toBe(false); // threshold is 10, strict ">"
    expect(result.replayed).toBe(false);
  });

  it("records a fixed-conversion withdrawal (normalized = entered * conversion_factor)", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.fixedConversionItemId,
      enteredQuantity: "3",
      enteredUnitId: fx.fixedConversionCaseUnitId,
      clientRequestId: randomUUID(),
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
        clientRequestId: randomUUID(),
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
        clientRequestId: randomUUID(),
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
        clientRequestId: randomUUID(),
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
        clientRequestId: randomUUID(),
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
      clientRequestId: randomUUID(),
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
      clientRequestId: randomUUID(),
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
      clientRequestId: randomUUID(),
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
      clientRequestId: randomUUID(),
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

  it("rejects a null client_request_id", async () => {
    // recordInventoryWithdrawal's TS type requires clientRequestId, but the
    // RPC itself is the actual enforcement boundary -- confirm it rejects a
    // literal null even if some other caller managed to send one.
    await expect(
      fx.supabase.rpc("record_inventory_withdrawal", {
        p_performed_by_app_user_id: fx.changeableEmployeeAppUserId,
        p_station_id: fx.stationId,
        p_inventory_item_id: fx.noRuleItemId,
        p_entered_quantity: "1",
        p_entered_unit_id: fx.noRuleUnitId,
        p_measured_base_quantity: null,
        p_notes: null,
        p_client_request_id: null,
      })
    ).resolves.toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining("client_request_id is required") }) });
  });
});

describe("record_inventory_withdrawal idempotency", () => {
  it("replays the original result (no new rows) when the same clientRequestId is retried with an identical payload", async () => {
    const clientRequestId = randomUUID();
    const before = await movementCountFor(fx.stationId, fx.changeableEmployeeAppUserId);

    const input = {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.fixedConversionItemId,
      enteredQuantity: "2",
      enteredUnitId: fx.fixedConversionCaseUnitId,
      clientRequestId,
    };

    const first = await recordInventoryWithdrawal(fx.supabase, input);
    expect(first.replayed).toBe(false);

    const second = await recordInventoryWithdrawal(fx.supabase, input);
    expect(second.replayed).toBe(true);
    expect(second.movementId).toBe(first.movementId);
    expect(second.movementLineId).toBe(first.movementLineId);
    expect(second.normalizedBaseQuantity).toBe(first.normalizedBaseQuantity);
    expect(second.exceptionRaised).toBe(first.exceptionRaised);

    const after = await movementCountFor(fx.stationId, fx.changeableEmployeeAppUserId);
    expect(after).toBe(before + 1); // only ONE movement, despite two calls
  });

  it("treats null vs. non-null measuredBaseQuantity as a mismatch, not an equal retry", async () => {
    const clientRequestId = randomUUID();

    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "1",
      enteredUnitId: fx.variableWeightBoxUnitId,
      measuredBaseQuantity: "5",
      clientRequestId,
    });

    // Same id, same everything else, but a DIFFERENT measuredBaseQuantity --
    // must fail closed, not silently replay the first withdrawal's result.
    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        inventoryItemId: fx.variableWeightItemId,
        enteredQuantity: "1",
        enteredUnitId: fx.variableWeightBoxUnitId,
        measuredBaseQuantity: "6",
        clientRequestId,
      })
    ).rejects.toThrow(/already used with a different withdrawal payload/);
  });

  it("fails closed when the same clientRequestId is reused for a different station, without mutating the original movement", async () => {
    const clientRequestId = randomUUID();

    const original = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.noRuleItemId,
      enteredQuantity: "1",
      enteredUnitId: fx.noRuleUnitId,
      clientRequestId,
    });

    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.otherStationId, // different station, same id
        inventoryItemId: fx.noRuleItemId,
        enteredQuantity: "1",
        enteredUnitId: fx.noRuleUnitId,
        clientRequestId,
      })
    ).rejects.toThrow(/already used with a different withdrawal payload/);

    // The original movement is untouched -- append-only history preserved.
    const { data: movement, error } = await fx.supabase
      .from("inventory_movements")
      .select("station_id")
      .eq("id", original.movementId)
      .single();
    expect(error).toBeNull();
    expect(movement!.station_id).toBe(fx.stationId);
  });

  it("fails closed when the same clientRequestId is reused by a different employee (actor mismatch)", async () => {
    const clientRequestId = randomUUID();

    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.noRuleItemId,
      enteredQuantity: "1",
      enteredUnitId: fx.noRuleUnitId,
      clientRequestId,
    });

    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.lockedEmployeeAppUserId, // different actor, same id
        stationId: fx.stationId,
        inventoryItemId: fx.noRuleItemId,
        enteredQuantity: "1",
        enteredUnitId: fx.noRuleUnitId,
        clientRequestId,
      })
    ).rejects.toThrow(/already used with a different withdrawal payload/);
  });

  it("two genuinely concurrent calls with the same clientRequestId and an identical payload both resolve to the one successful result", async () => {
    const clientRequestId = randomUUID();
    const before = await movementCountFor(fx.stationId, fx.changeableEmployeeAppUserId);

    const input = {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      inventoryItemId: fx.noRuleItemId,
      enteredQuantity: "1",
      enteredUnitId: fx.noRuleUnitId,
      clientRequestId,
    };

    const [a, b] = await Promise.all([
      recordInventoryWithdrawal(fx.supabase, input),
      recordInventoryWithdrawal(fx.supabase, input),
    ]);

    expect(a.movementId).toBe(b.movementId);
    expect(a.movementLineId).toBe(b.movementLineId);
    // Exactly one of the two calls did the actual insert; the other found a
    // unique_violation and replayed it -- both are still "success" from the
    // caller's point of view, and only one row exists either way.
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);

    const after = await movementCountFor(fx.stationId, fx.changeableEmployeeAppUserId);
    expect(after).toBe(before + 1);
  });
});
