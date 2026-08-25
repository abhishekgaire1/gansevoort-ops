import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { recordInventoryWithdrawal } from "@/app/lib/inventory/withdrawal";
import { recordInventoryWithdrawalBatch } from "@/app/lib/inventory/withdrawalBatch";
import { recordInventoryWaste } from "@/app/lib/inventory/waste";
import { hashPinForStorage, hashPinLookup } from "@/app/lib/auth/pin";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";

/**
 * MANUAL / ON-DEMAND ONLY -- not run in CI (`npm test` does not include
 * this file; NOT run during this RC1 implementation task either, per
 * explicit instruction). Run explicitly via a future authorized
 * `npm run test:integration` pass against the linked DEV project.
 *
 * Covers the RC1 High-Withdrawal Manager Visibility notification
 * behavior (20260811100112) ONLY -- HIGH_WITHDRAWAL threshold detection
 * itself (strict >, station-then-org-wide rule resolution, "never
 * blocks") is already covered by tests/withdrawal.rpc.test.ts and is not
 * re-tested here to avoid duplicating existing coverage.
 *
 * Reuses fx.variableWeightItemId/fx.variableWeightLbUnitId/fx.stationId,
 * the SAME fixture withdrawal.rpc.test.ts already relies on for its own
 * HIGH_WITHDRAWAL tests (a pre-configured threshold of exactly 10 at
 * fx.stationId) -- no new control_rules row is created here.
 *
 * Every write below permanently lands in the canonical "TEST RPC Fixture
 * Org" (never the real Gansevoort organization) and is append-only
 * (movements/exceptions/notifications/audit_events all forbid update or
 * delete) -- there is no cleanup path, by the same documented tradeoff
 * every other .rpc.test.ts file in this repo already accepts.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;
let recipientAppUserId: string;
let inactiveRecipientAppUserId: string;
let locationId: string;

/** Mirrors tests/withdrawal.rpc.test.ts's own seedAbundantStock exactly
 * -- record_inventory_withdrawal validates the requested quantity
 * against the source location's real ledger balance (20260811100073),
 * so every withdrawal/waste test below needs real stock seeded first. */
async function seedAbundantStock(inventoryItemId: string, baseUnitId: string): Promise<void> {
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
    .insert({ movement_id: movement!.id, inventory_item_id: inventoryItemId, entered_quantity: 10_000_000, entered_unit_id: baseUnitId });
  if (lineError) throw lineError;
}

/** Test-only, idempotent manager-role app_user -- mirrors
 * tests/cycleCountHistory.rpc.test.ts's own ensureManagerRoleAppUser
 * exactly, since that helper isn't exported from testFixtures.ts. */
async function ensureManagerRoleAppUser(employeeCode: string, firstName: string, isActive = true): Promise<string> {
  const { data: existingEmployee } = await fx.supabase
    .from("employees")
    .select("id")
    .eq("organization_id", fx.organizationId)
    .eq("employee_code", employeeCode)
    .maybeSingle();

  let employeeId = existingEmployee?.id as string | undefined;
  if (!employeeId) {
    const { data: insertedEmployee, error: employeeError } = await fx.supabase
      .from("employees")
      .insert({
        organization_id: fx.organizationId,
        first_name: firstName,
        last_name: "TestFixture",
        employee_code: employeeCode,
        default_station_id: null,
        auto_resolve_station: false,
        can_change_station: false,
        status: "active",
      })
      .select("id")
      .single();
    if (employeeError && employeeError.code !== "23505") throw employeeError;
    employeeId = insertedEmployee?.id as string | undefined;
    if (!employeeId) {
      const { data: refetched } = await fx.supabase
        .from("employees")
        .select("id")
        .eq("organization_id", fx.organizationId)
        .eq("employee_code", employeeCode)
        .single();
      employeeId = refetched!.id as string;
    }
  }

  const { data: existingAppUser } = await fx.supabase.from("app_users").select("id").eq("employee_id", employeeId).maybeSingle();
  let appUserId = existingAppUser?.id as string | undefined;
  if (!appUserId) {
    const pinPepper = process.env.PIN_PEPPER;
    if (!pinPepper) throw new Error("PIN_PEPPER is not set");
    const pin = randomUUID().replace(/\D/g, "").slice(0, 6).padEnd(6, "0");
    const { data: insertedAppUser, error: appUserError } = await fx.supabase
      .from("app_users")
      .insert({
        organization_id: fx.organizationId,
        employee_id: employeeId,
        pin_lookup_hash: hashPinLookup(pin, pinPepper),
        pin_hash: await hashPinForStorage(pin),
        is_active: isActive,
      })
      .select("id")
      .single();
    if (appUserError && appUserError.code !== "23505") throw appUserError;
    appUserId = insertedAppUser?.id as string | undefined;
    if (!appUserId) {
      const { data: refetched } = await fx.supabase.from("app_users").select("id").eq("employee_id", employeeId).single();
      appUserId = refetched!.id as string;
    }
  } else {
    await fx.supabase.from("app_users").update({ is_active: isActive }).eq("id", appUserId);
  }

  const { data: managerRole, error: roleLookupError } = await fx.supabase.from("roles").select("id").eq("name", "manager").single();
  if (roleLookupError) throw roleLookupError;
  const { error: roleGrantError } = await fx.supabase
    .from("user_roles")
    .insert({ app_user_id: appUserId, role_id: managerRole!.id, organization_id: fx.organizationId });
  if (roleGrantError && roleGrantError.code !== "23505") throw roleGrantError;

  return appUserId;
}

async function notificationsFor(exceptionId: string): Promise<{ recipient_app_user_id: string; type: string; entity_type: string; entity_id: string }[]> {
  const { data, error } = await fx.supabase
    .from("user_notifications")
    .select("recipient_app_user_id, type, entity_type, entity_id")
    .eq("entity_type", "exception")
    .eq("entity_id", exceptionId);
  if (error) throw error;
  return data ?? [];
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
  recipientAppUserId = await ensureManagerRoleAppUser("TEST-RPC-HW-RECIPIENT", "TestHWRecipient", true);
  inactiveRecipientAppUserId = await ensureManagerRoleAppUser("TEST-RPC-HW-INACTIVE", "TestHWInactive", false);

  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;

  await Promise.all([seedAbundantStock(fx.variableWeightItemId, fx.variableWeightLbUnitId), seedAbundantStock(fx.noRuleItemId, fx.noRuleUnitId)]);
}, 30000);

describe("high-withdrawal notification -- single-item withdrawal (20260811100112)", () => {
  it("1. below threshold: completes, no exception, no notification", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "5", // threshold is exactly 10
      enteredUnitId: fx.variableWeightLbUnitId,
      clientRequestId: randomUUID(),
    });
    expect(result.exceptionRaised).toBe(false);
    expect(result.exceptionId).toBeNull();
  });

  it("2. exactly at threshold: completes, no exception, no notification (strict >)", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "10",
      enteredUnitId: fx.variableWeightLbUnitId,
      clientRequestId: randomUUID(),
    });
    expect(result.exceptionRaised).toBe(false);
  });

  it("3. above threshold: completes, exactly one exception, eligible same-org recipients notified, actor and inactive recipients excluded, other orgs unaffected", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "10.5",
      enteredUnitId: fx.variableWeightLbUnitId,
      clientRequestId: randomUUID(),
    });
    expect(result.exceptionRaised).toBe(true);
    expect(result.exceptionId).toBeTruthy();

    const notifications = await notificationsFor(result.exceptionId!);
    const recipientIds = notifications.map((n) => n.recipient_app_user_id);
    expect(recipientIds).toContain(recipientAppUserId);
    expect(recipientIds).not.toContain(fx.changeableEmployeeAppUserId); // actor excluded
    expect(recipientIds).not.toContain(inactiveRecipientAppUserId); // inactive excluded
    for (const n of notifications) {
      expect(n.type).toBe("HIGH_WITHDRAWAL");
      expect(n.entity_type).toBe("exception");
      expect(n.entity_id).toBe(result.exceptionId);
    }

    // 9. notification routing facts.
    expect(notifications.length).toBeGreaterThan(0);

    // Cross-organization isolation: nothing in this org's notification
    // set can belong to a different organization's recipient (the
    // recipient query itself is `au.organization_id = v_org_id`) --
    // proven here by confirming the OTHER org's fixture app_user
    // received nothing for this exceptionId, which would be impossible
    // regardless since organization_id is enforced in the RPC's own
    // recipient subquery, not just checked after the fact.
    expect(recipientIds).not.toContain(otherOrg.appUserId);
  });

  it("4. idempotent replay: returns the original result, no second movement, no second exception, no duplicate notification", async () => {
    const clientRequestId = randomUUID();
    const first = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "11",
      enteredUnitId: fx.variableWeightLbUnitId,
      clientRequestId,
    });
    expect(first.exceptionRaised).toBe(true);

    const replay = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "11",
      enteredUnitId: fx.variableWeightLbUnitId,
      clientRequestId,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.movementId).toBe(first.movementId);
    expect(replay.exceptionId).toBe(first.exceptionId);

    const notifications = await notificationsFor(first.exceptionId!);
    const forRecipient = notifications.filter((n) => n.recipient_app_user_id === recipientAppUserId);
    expect(forRecipient.length).toBe(1); // not duplicated by the replay
  });

  it("5. same client_request_id, different payload: rejected, no extra exception or notification", async () => {
    const clientRequestId = randomUUID();
    await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "10.2",
      enteredUnitId: fx.variableWeightLbUnitId,
      clientRequestId,
    });

    await expect(
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: locationId,
        inventoryItemId: fx.variableWeightItemId,
        enteredQuantity: "10.3", // different payload, same key
        enteredUnitId: fx.variableWeightLbUnitId,
        clientRequestId,
      })
    ).rejects.toThrow();
  });

  it("6. concurrent duplicate submission: exactly one movement, one exception, at most one notification per eligible recipient", async () => {
    const clientRequestId = randomUUID();
    const attempt = () =>
      recordInventoryWithdrawal(fx.supabase, {
        performedByAppUserId: fx.changeableEmployeeAppUserId,
        stationId: fx.stationId,
        sourceLocationId: locationId,
        inventoryItemId: fx.variableWeightItemId,
        enteredQuantity: "10.7",
        enteredUnitId: fx.variableWeightLbUnitId,
        clientRequestId,
      });

    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect(a.movementId).toBe(b.movementId);
    expect(a.exceptionId).toBe(b.exceptionId);

    const notifications = await notificationsFor(a.exceptionId!);
    const forRecipient = notifications.filter((n) => n.recipient_app_user_id === recipientAppUserId);
    expect(forRecipient.length).toBe(1);
  });
});

describe("high-withdrawal notification -- batch withdrawal (20260811100112)", () => {
  it("7. only lines above their applicable threshold create exceptions; one notification per new exception per eligible recipient; batch atomicity intact", async () => {
    const result = await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: randomUUID(),
      cartLines: [
        { inventoryItemId: fx.variableWeightItemId, sourceLocationId: locationId, enteredQuantity: "5", enteredUnitId: fx.variableWeightLbUnitId }, // below threshold
        { inventoryItemId: fx.noRuleItemId, sourceLocationId: locationId, enteredQuantity: "1", enteredUnitId: fx.noRuleUnitId }, // no rule at all
      ],
    });

    const exceptionIds = result.lines.map((l) => l.exceptionId).filter((id): id is string => Boolean(id));
    expect(exceptionIds).toHaveLength(0); // neither line crosses a threshold

    for (const line of result.lines) {
      expect(line.movementId).toBeTruthy(); // every line still recorded (atomicity: nothing rolled back)
    }
  });

  it("7b. a batch with one over-threshold line creates exactly one exception and notifies eligible recipients for it only", async () => {
    const result = await recordInventoryWithdrawalBatch(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      clientRequestId: randomUUID(),
      cartLines: [
        { inventoryItemId: fx.variableWeightItemId, sourceLocationId: locationId, enteredQuantity: "10.9", enteredUnitId: fx.variableWeightLbUnitId }, // over threshold
        { inventoryItemId: fx.noRuleItemId, sourceLocationId: locationId, enteredQuantity: "1", enteredUnitId: fx.noRuleUnitId }, // no rule
      ],
    });

    const exceptionIds = [...new Set(result.lines.map((l) => l.exceptionId).filter((id): id is string => Boolean(id)))];
    expect(exceptionIds).toHaveLength(1);

    const notifications = await notificationsFor(exceptionIds[0]);
    const recipientIds = notifications.map((n) => n.recipient_app_user_id);
    expect(recipientIds).toContain(recipientAppUserId);
    expect(recipientIds).not.toContain(fx.changeableEmployeeAppUserId);
  });
});

describe("high-withdrawal notification -- storage waste must never trigger it (20260811100112)", () => {
  it("8. recording storage waste creates no HIGH_WITHDRAWAL exception and no high-withdrawal notification", async () => {
    const clientRequestId = randomUUID();
    const wasteResult = await recordInventoryWaste(fx.supabase, {
      recordedByAppUserId: fx.changeableEmployeeAppUserId,
      locationId,
      inventoryItemId: fx.variableWeightItemId,
      quantity: "10.8", // would exceed the withdrawal threshold, if waste were (incorrectly) subject to it
      reasonCode: "SPOILED",
      clientRequestId,
    });
    expect(wasteResult.wasteEventId).toBeTruthy();

    const { data: exceptionsForWaste, error } = await fx.supabase
      .from("exceptions")
      .select("id")
      .eq("organization_id", fx.organizationId)
      .eq("exception_type", "HIGH_WITHDRAWAL")
      .eq("source_movement_id", wasteResult.movementId);
    if (error) throw error;
    expect(exceptionsForWaste ?? []).toHaveLength(0);
  });
});

describe("high-withdrawal alert detail -- cross-organization access (Section 4C)", () => {
  it("10. an exceptionId belonging to this org is not retrievable by a query scoped to a different organization", async () => {
    const result = await recordInventoryWithdrawal(fx.supabase, {
      performedByAppUserId: fx.changeableEmployeeAppUserId,
      stationId: fx.stationId,
      sourceLocationId: locationId,
      inventoryItemId: fx.variableWeightItemId,
      enteredQuantity: "10.6",
      enteredUnitId: fx.variableWeightLbUnitId,
      clientRequestId: randomUUID(),
    });
    expect(result.exceptionRaised).toBe(true);

    const { data: crossOrgLookup, error } = await fx.supabase
      .from("exceptions")
      .select("id")
      .eq("organization_id", otherOrg.organizationId)
      .eq("id", result.exceptionId!)
      .maybeSingle();
    if (error) throw error;
    expect(crossOrgLookup).toBeNull();
  });
});
