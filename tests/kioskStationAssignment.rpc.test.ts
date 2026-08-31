import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { hashPinForStorage, hashPinLookup } from "@/app/lib/auth/pin";
import { verifyPinCore } from "@/app/lib/auth/verifyPin";
import { listAssignedActiveStationsForEmployee } from "@/app/lib/kiosk/stations";
import { recordInventoryWithdrawal } from "@/app/lib/inventory/withdrawal";

/**
 * MANUAL / ON-DEMAND ONLY -- not run in CI (`npm test` does not include
 * this file; run explicitly via `npm run test:integration`).
 *
 * Kiosk station assignment enforcement (20260811100130): proves the fix
 * for a confirmed real-UAT authorization defect -- after PIN login, the
 * kiosk showed every active organization station (including TEST RPC
 * fixture stations) regardless of actual assignment, and
 * record_inventory_withdrawal only restricted a station choice for one
 * narrow employee configuration, leaving every other employee able to
 * submit a withdrawal for ANY active station in the organization.
 *
 * Every synthetic employee here is created fresh, scoped to this file's
 * own randomUUID()-suffixed employee_code, and is never Melani or any
 * other real employee -- this file never touches, resets, or reads a
 * real employee's PIN, and never posts a withdrawal under a real
 * employee's account. inventory_movements/employees are append-only or
 * safely idempotent -- see the plan's own "RPC test strategy" note in
 * withdrawal.rpc.test.ts for the same accepted no-cleanup tradeoff.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;
let locationId: string;
const PIN_PEPPER = process.env.PIN_PEPPER!;

interface SyntheticEmployee {
  employeeId: string;
  appUserId: string;
  pin: string;
}

async function createSyntheticEmployee(organizationId: string, label: string): Promise<SyntheticEmployee> {
  const suffix = randomUUID().slice(0, 8);
  const pin = String(1000 + Math.floor(Math.random() * 9000));

  const { data: employee, error: employeeError } = await fx.supabase
    .from("employees")
    .insert({
      organization_id: organizationId,
      first_name: "SyntheticStationTest",
      last_name: label,
      employee_code: `TEST-STATION-${label}-${suffix}`,
      status: "active",
    })
    .select("id")
    .single();
  if (employeeError) throw employeeError;

  const { data: appUser, error: appUserError } = await fx.supabase
    .from("app_users")
    .insert({
      organization_id: organizationId,
      employee_id: employee!.id,
      pin_lookup_hash: hashPinLookup(pin, PIN_PEPPER),
      pin_hash: await hashPinForStorage(pin),
      is_active: true,
    })
    .select("id")
    .single();
  if (appUserError) throw appUserError;

  return { employeeId: employee!.id as string, appUserId: appUser!.id as string, pin };
}

async function assignStation(organizationId: string, employeeId: string, stationId: string, isActive = true): Promise<void> {
  const { error } = await fx.supabase
    .from("employee_station_assignments")
    .upsert(
      { organization_id: organizationId, employee_id: employeeId, station_id: stationId, is_active: isActive },
      { onConflict: "employee_id,station_id" }
    );
  if (error) throw error;
}

async function verifyPin(organizationId: string, pin: string) {
  return verifyPinCore(fx.supabase, {
    pin,
    organizationId,
    sourceIp: `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
    deviceId: `device-${randomUUID()}`,
    pinPepper: PIN_PEPPER,
    kioskTokenSecret: process.env.KIOSK_TOKEN_SECRET!,
  });
}

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
  const { data: location } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).limit(1).single();
  locationId = location!.id as string;

  // Abundant stock for fx.noRuleItemId, matching the exact idempotent
  // pattern established in withdrawal.rpc.test.ts (cumulative ledger
  // truth -- safe to re-seed).
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
    .insert({ movement_id: movement!.id, inventory_item_id: fx.noRuleItemId, entered_quantity: 10_000_000, entered_unit_id: fx.noRuleUnitId });
  if (lineError) throw lineError;
});

function withdrawInput(appUserId: string, stationId: string) {
  return {
    performedByAppUserId: appUserId,
    stationId,
    sourceLocationId: locationId,
    inventoryItemId: fx.noRuleItemId,
    enteredQuantity: "1",
    enteredUnitId: fx.noRuleUnitId,
    clientRequestId: randomUUID(),
  };
}

describe("1. zero assignments blocks kiosk access", () => {
  it("PIN verification reports stationAccess: blocked, never falling back to any station", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "ZERO");
    const result = await verifyPin(fx.organizationId, employee.pin);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stationAccess).toEqual({ kind: "blocked" });
    }
  });

  it("record_inventory_withdrawal independently rejects any station for an employee with zero assignments", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "ZERO-WD");
    await expect(recordInventoryWithdrawal(fx.supabase, withdrawInput(employee.appUserId, fx.stationId))).rejects.toThrow();
  });
});

describe("2. exactly one assignment auto-selects", () => {
  it("PIN verification reports stationAccess: single, with the correct station id/name", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "ONE");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId);

    const result = await verifyPin(fx.organizationId, employee.pin);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stationAccess.kind).toBe("single");
      if (result.stationAccess.kind === "single") {
        expect(result.stationAccess.stationId).toBe(fx.stationId);
      }
    }
  });

  it("that employee can successfully withdraw at their one assigned station", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "ONE-WD");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId);

    const result = await recordInventoryWithdrawal(fx.supabase, withdrawInput(employee.appUserId, fx.stationId));
    expect(result.movementId).toBeTruthy();
  });
});

describe("3. multiple assignments show only those assigned stations", () => {
  it("PIN verification reports stationAccess: multiple, and the station-picker list contains exactly the two assigned stations", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "MULTI");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId);
    await assignStation(fx.organizationId, employee.employeeId, fx.otherStationId);

    const result = await verifyPin(fx.organizationId, employee.pin);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stationAccess).toEqual({ kind: "multiple" });
    }

    const stations = await listAssignedActiveStationsForEmployee(fx.supabase, fx.organizationId, employee.employeeId);
    expect(stations.map((s) => s.id).sort()).toEqual([fx.otherStationId, fx.stationId].sort());
  });

  it("can withdraw at either assigned station", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "MULTI-WD");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId);
    await assignStation(fx.organizationId, employee.employeeId, fx.otherStationId);

    const first = await recordInventoryWithdrawal(fx.supabase, withdrawInput(employee.appUserId, fx.stationId));
    const second = await recordInventoryWithdrawal(fx.supabase, withdrawInput(employee.appUserId, fx.otherStationId));
    expect(first.movementId).toBeTruthy();
    expect(second.movementId).toBeTruthy();
  });
});

describe("4. unassigned stations never appear", () => {
  it("an employee assigned to one station never sees a second, unrelated active station in their list", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "UNASSIGNED");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId);

    const stations = await listAssignedActiveStationsForEmployee(fx.supabase, fx.organizationId, employee.employeeId);
    expect(stations.map((s) => s.id)).toEqual([fx.stationId]);
    expect(stations.map((s) => s.id)).not.toContain(fx.otherStationId);
  });
});

describe("5. TEST RPC fixture stations do not appear unless explicitly assigned -- the exact real-UAT bug", () => {
  it("an employee assigned to exactly one station sees ONLY that station, never every fixture station in the organization", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "FIXTURE-ISOLATION");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId);

    // Confirm the organization genuinely has more than one active station
    // (multiple TEST RPC fixture stations accumulate across this shared
    // suite) -- otherwise this test would trivially pass for the wrong
    // reason.
    const { count: totalActiveStations } = await fx.supabase
      .from("stations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("is_active", true);
    expect(totalActiveStations ?? 0).toBeGreaterThan(1);

    const stations = await listAssignedActiveStationsForEmployee(fx.supabase, fx.organizationId, employee.employeeId);
    expect(stations).toHaveLength(1);
    expect(stations[0]!.id).toBe(fx.stationId);
  });
});

describe("6. inactive assignments and inactive stations are excluded", () => {
  it("a deactivated assignment (is_active=false) never appears in the employee's station list", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "INACTIVE-ASSIGN");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId, false);

    const stations = await listAssignedActiveStationsForEmployee(fx.supabase, fx.organizationId, employee.employeeId);
    expect(stations).toEqual([]);
  });

  it("record_inventory_withdrawal rejects a station the employee's assignment for is inactive", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "INACTIVE-ASSIGN-WD");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId, false);

    await expect(recordInventoryWithdrawal(fx.supabase, withdrawInput(employee.appUserId, fx.stationId))).rejects.toThrow();
  });

  it("an active assignment to a now-inactive station never appears, and withdrawal is rejected", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "INACTIVE-STATION");
    const { data: tempStation, error } = await fx.supabase
      .from("stations")
      .insert({ organization_id: fx.organizationId, location_id: locationId, name: `TEST Deactivated Station ${randomUUID().slice(0, 8)}`, is_active: true })
      .select("id")
      .single();
    if (error) throw error;
    await assignStation(fx.organizationId, employee.employeeId, tempStation!.id as string, true);

    // Deactivate the station itself (not the assignment).
    await fx.supabase.from("stations").update({ is_active: false }).eq("id", tempStation!.id);

    const stations = await listAssignedActiveStationsForEmployee(fx.supabase, fx.organizationId, employee.employeeId);
    expect(stations).toEqual([]);

    await expect(recordInventoryWithdrawal(fx.supabase, withdrawInput(employee.appUserId, tempStation!.id as string))).rejects.toThrow();
  });
});

describe("7. cross-organization assignments are rejected", () => {
  it("an assignment recorded under the OTHER organization is invisible when read under this organization", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "CROSS-ORG");
    // Directly insert an assignment row scoped to the WRONG (other)
    // organization -- simulates data that should never legitimately
    // exist, proving the read is scoped by organization_id, not merely
    // by employee_id.
    const { error } = await fx.supabase
      .from("employee_station_assignments")
      .insert({ organization_id: otherOrg.organizationId, employee_id: employee.employeeId, station_id: fx.stationId, is_active: true });
    // The composite FK (employee_id, organization_id) -> employees(id, organization_id)
    // should itself reject this cross-organization row outright.
    expect(error).not.toBeNull();
  });

  it("record_inventory_withdrawal rejects a station belonging to a different organization than the employee", async () => {
    let otherOrgStationId = (
      await fx.supabase.from("stations").select("id").eq("organization_id", otherOrg.organizationId).eq("is_active", true).limit(1).maybeSingle()
    ).data?.id as string | undefined;

    if (!otherOrgStationId) {
      let otherOrgLocationId = (await fx.supabase.from("locations").select("id").eq("organization_id", otherOrg.organizationId).limit(1).maybeSingle())
        .data?.id as string | undefined;
      if (!otherOrgLocationId) {
        const { data: createdLocation, error: locationError } = await fx.supabase
          .from("locations")
          .insert({ organization_id: otherOrg.organizationId, name: "TEST Org B Location", timezone: "America/New_York", is_active: true })
          .select("id")
          .single();
        if (locationError) throw locationError;
        otherOrgLocationId = createdLocation!.id as string;
      }
      const { data: createdStation, error: stationError } = await fx.supabase
        .from("stations")
        .insert({ organization_id: otherOrg.organizationId, location_id: otherOrgLocationId, name: `TEST Org B Station ${randomUUID().slice(0, 8)}`, is_active: true })
        .select("id")
        .single();
      if (stationError) throw stationError;
      otherOrgStationId = createdStation!.id as string;
    }

    const employee = await createSyntheticEmployee(fx.organizationId, "CROSS-ORG-WD");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId);

    await expect(recordInventoryWithdrawal(fx.supabase, withdrawInput(employee.appUserId, otherOrgStationId))).rejects.toThrow();
  });
});

describe("8. tampering with the submitted station id is rejected server-side", () => {
  it("a manually altered station_id that was never assigned to this employee is rejected, even though it is a genuinely active station in the same organization", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "TAMPER");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId);

    // fx.otherStationId is a real, active, same-organization station --
    // exactly what a manually-altered request body would contain -- but
    // this employee was never assigned to it.
    await expect(recordInventoryWithdrawal(fx.supabase, withdrawInput(employee.appUserId, fx.otherStationId))).rejects.toThrow(
      /not assigned to active station/
    );
  });
});

describe("9. assignment removal prevents subsequent withdrawal attempts", () => {
  it("a withdrawal that succeeded before removal is rejected immediately after the assignment is deactivated -- from the SAME already-known app_user id, simulating an existing session", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "REMOVAL");
    await assignStation(fx.organizationId, employee.employeeId, fx.stationId);

    const before = await recordInventoryWithdrawal(fx.supabase, withdrawInput(employee.appUserId, fx.stationId));
    expect(before.movementId).toBeTruthy();

    await assignStation(fx.organizationId, employee.employeeId, fx.stationId, false);

    await expect(recordInventoryWithdrawal(fx.supabase, withdrawInput(employee.appUserId, fx.stationId))).rejects.toThrow(
      /not assigned to active station/
    );
  });
});

describe("10. assignment addition appears on a new login", () => {
  it("an employee blocked at first PIN verification sees stationAccess: single immediately after an assignment is added, on the next verification -- no caching, no stale token data", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "ADDED");

    const before = await verifyPin(fx.organizationId, employee.pin);
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.stationAccess).toEqual({ kind: "blocked" });

    await assignStation(fx.organizationId, employee.employeeId, fx.stationId);

    const after = await verifyPin(fx.organizationId, employee.pin);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.stationAccess).toEqual({ kind: "single", stationId: fx.stationId, stationName: expect.any(String) });
    }
  });
});

describe("13. admin station-assignment saving persists correctly", () => {
  it("manager_set_employee_station_assignments activates exactly the requested set and deactivates everything else, verified by re-reading the assignment table directly", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "ADMIN-SAVE");
    const adminActor = fx.changeableEmployeeAppUserId;

    const { error: firstSave } = await fx.supabase.rpc("manager_set_employee_station_assignments", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: adminActor,
      p_employee_id: employee.employeeId,
      p_station_ids: [fx.stationId, fx.otherStationId],
    });
    expect(firstSave).toBeNull();

    let stations = await listAssignedActiveStationsForEmployee(fx.supabase, fx.organizationId, employee.employeeId);
    expect(stations.map((s) => s.id).sort()).toEqual([fx.otherStationId, fx.stationId].sort());

    // Persist a narrower set -- must deactivate the one no longer listed.
    const { error: secondSave } = await fx.supabase.rpc("manager_set_employee_station_assignments", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: adminActor,
      p_employee_id: employee.employeeId,
      p_station_ids: [fx.stationId],
    });
    expect(secondSave).toBeNull();

    stations = await listAssignedActiveStationsForEmployee(fx.supabase, fx.organizationId, employee.employeeId);
    expect(stations.map((s) => s.id)).toEqual([fx.stationId]);

    const { data: auditRow, error: auditError } = await fx.supabase
      .from("audit_events")
      .select("action")
      .eq("organization_id", fx.organizationId)
      .eq("entity_id", employee.employeeId)
      .eq("action", "EMPLOYEE_STATION_ASSIGNMENTS_SET")
      .order("occurred_at", { ascending: false })
      .limit(1);
    if (auditError) throw auditError;
    expect(auditRow).toHaveLength(1);
  });

  it("rejects an inactive/nonexistent station id (GA074)", async () => {
    const employee = await createSyntheticEmployee(fx.organizationId, "ADMIN-SAVE-INVALID");
    const { error } = await fx.supabase.rpc("manager_set_employee_station_assignments", {
      p_organization_id: fx.organizationId,
      p_actor_app_user_id: fx.changeableEmployeeAppUserId,
      p_employee_id: employee.employeeId,
      p_station_ids: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(error?.code).toBe("GA074");
  });
});
