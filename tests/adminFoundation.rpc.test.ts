import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { hashPinLookup, hashPinForStorage } from "@/app/lib/auth/pin";
import {
  listAdminUsers,
  getAdminUser,
  createEmployee,
  updateEmployeeName,
  setEmployeeDefaultStation,
  setEmployeeStatus,
  setUserRole,
  AdminValidationError,
} from "@/app/lib/admin/users";
import { AdminActionError } from "@/app/lib/admin/errors";
import { listAdminStations, getAdminStation, createStation, updateStationName, setStationStatus } from "@/app/lib/admin/stations";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment (same convention every other .rpc.test.ts file in this repo
 * follows).
 *
 * Admin Foundation milestone (20260811100094) -- exercises every new
 * admin RPC against the real linked dev database: Users (employees +
 * app_users + roles), Stations, cross-org isolation, last-admin/self
 * protection, and audit_events emission for consequential mutations.
 */

let fx: RpcTestFixtures;
const PIN_PEPPER = process.env.PIN_PEPPER!;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

function uniquePin(): string {
  // 6 digits, astronomically unlikely to collide across parallel test runs.
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** A real, auth-linked test admin app_user -- idempotent find-or-create,
 * same technique scripts/dev-seed.ts already uses for exactly this
 * reason (app_users.auth_user_id has a hard FK to auth.users, so
 * Manager/Admin role tests need a genuine auth user, not a fabricated
 * id). Scoped to the TEST org only. */
async function findOrCreateTestAdminAppUser(fx: RpcTestFixtures, label: string): Promise<string> {
  const email = `admin-foundation-test-${label}@gansevoort.test`;
  const employeeCode = `TEST-ADMIN-${label.toUpperCase()}`;

  let authUserId: string;
  const { data: created } = await fx.supabase.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true });
  if (created?.user) {
    authUserId = created.user.id;
  } else {
    const { data: list } = await fx.supabase.auth.admin.listUsers();
    const existing = list.users.find((u) => u.email === email);
    if (!existing) throw new Error(`could not find or create auth user ${email}`);
    authUserId = existing.id;
  }

  const { data: existingEmployee } = await fx.supabase.from("employees").select("id").eq("organization_id", fx.organizationId).eq("employee_code", employeeCode).maybeSingle();
  let employeeId: string;
  if (existingEmployee) {
    employeeId = existingEmployee.id as string;
    await fx.supabase.from("employees").update({ status: "active" }).eq("id", employeeId);
  } else {
    const { data: inserted, error } = await fx.supabase
      .from("employees")
      .insert({ organization_id: fx.organizationId, first_name: "TestAdmin", last_name: label, employee_code: employeeCode, status: "active" })
      .select("id")
      .single();
    if (error) throw error;
    employeeId = inserted.id as string;
  }

  const { data: existingAppUser } = await fx.supabase.from("app_users").select("id").eq("employee_id", employeeId).maybeSingle();
  let appUserId: string;
  if (existingAppUser) {
    appUserId = existingAppUser.id as string;
    await fx.supabase.from("app_users").update({ is_active: true, auth_user_id: authUserId }).eq("id", appUserId);
  } else {
    const pin = uniquePin();
    const { data: inserted, error } = await fx.supabase
      .from("app_users")
      .insert({
        organization_id: fx.organizationId,
        employee_id: employeeId,
        auth_user_id: authUserId,
        pin_lookup_hash: hashPinLookup(pin, PIN_PEPPER),
        pin_hash: await hashPinForStorage(pin),
      })
      .select("id")
      .single();
    if (error) throw error;
    appUserId = inserted.id as string;
  }

  const { data: adminRole } = await fx.supabase.from("roles").select("id").eq("name", "admin").single();
  const { data: existingGrant } = await fx.supabase.from("user_roles").select("app_user_id").eq("app_user_id", appUserId).eq("role_id", adminRole!.id).maybeSingle();
  if (!existingGrant) {
    await fx.supabase.from("user_roles").insert({ app_user_id: appUserId, role_id: adminRole!.id, organization_id: fx.organizationId });
  }

  return appUserId;
}

describe("createEmployee / getAdminUser / listAdminUsers", () => {
  it("creates an operational employee with kiosk access and it is immediately listed/gettable", async () => {
    const pin = uniquePin();
    const result = await createEmployee(fx.supabase, {
      organizationId: fx.organizationId,
      createdByAppUserId: fx.changeableEmployeeAppUserId,
      firstName: "Admin",
      lastName: `Test${randomUUID().slice(0, 6)}`,
      defaultStationId: fx.stationId,
      grantKioskAccess: true,
      pin,
      pinPepper: PIN_PEPPER,
    });
    expect(result.employeeId).toBeTruthy();
    expect(result.appUserId).toBeTruthy();

    const fetched = await getAdminUser(fx.supabase, fx.organizationId, result.employeeId);
    expect(fetched?.defaultStationId).toBe(fx.stationId);
    expect(fetched?.employeeStatus).toBe("active");
    expect(fetched?.appUserId).toBe(result.appUserId);
    expect(fetched?.isAppUserActive).toBe(true);
    expect(fetched?.hasAuthAccount).toBe(false);
    expect(fetched?.primaryRole).toBe("employee");

    const listed = await listAdminUsers(fx.supabase, { organizationId: fx.organizationId, search: fetched!.lastName });
    expect(listed.some((u) => u.employeeId === result.employeeId)).toBe(true);
  });

  it("creates an employee with no kiosk access at all -- Access shows no app_user", async () => {
    const result = await createEmployee(fx.supabase, {
      organizationId: fx.organizationId,
      createdByAppUserId: fx.changeableEmployeeAppUserId,
      firstName: "NoAccess",
      lastName: `Test${randomUUID().slice(0, 6)}`,
      defaultStationId: null,
      grantKioskAccess: false,
      pin: null,
      pinPepper: PIN_PEPPER,
    });
    const fetched = await getAdminUser(fx.supabase, fx.organizationId, result.employeeId);
    expect(fetched?.appUserId).toBeNull();
    expect(fetched?.hasAuthAccount).toBe(false);
  });

  it("rejects an inactive/nonexistent default station", async () => {
    await expect(
      createEmployee(fx.supabase, {
        organizationId: fx.organizationId,
        createdByAppUserId: fx.changeableEmployeeAppUserId,
        firstName: "Bad",
        lastName: "Station",
        defaultStationId: randomUUID(),
        grantKioskAccess: false,
        pin: null,
        pinPepper: PIN_PEPPER,
      })
    ).rejects.toThrow(AdminActionError);
  });

  it("rejects a duplicate PIN within the same organization", async () => {
    const pin = uniquePin();
    await createEmployee(fx.supabase, {
      organizationId: fx.organizationId,
      createdByAppUserId: fx.changeableEmployeeAppUserId,
      firstName: "First",
      lastName: `Dup${randomUUID().slice(0, 6)}`,
      defaultStationId: null,
      grantKioskAccess: true,
      pin,
      pinPepper: PIN_PEPPER,
    });
    await expect(
      createEmployee(fx.supabase, {
        organizationId: fx.organizationId,
        createdByAppUserId: fx.changeableEmployeeAppUserId,
        firstName: "Second",
        lastName: `Dup${randomUUID().slice(0, 6)}`,
        defaultStationId: null,
        grantKioskAccess: true,
        pin,
        pinPepper: PIN_PEPPER,
      })
    ).rejects.toThrow(AdminActionError);
  });

  it("rejects kiosk access without a valid PIN before ever reaching the database", async () => {
    await expect(
      createEmployee(fx.supabase, {
        organizationId: fx.organizationId,
        createdByAppUserId: fx.changeableEmployeeAppUserId,
        firstName: "Bad",
        lastName: "Pin",
        defaultStationId: null,
        grantKioskAccess: true,
        pin: "abc",
        pinPepper: PIN_PEPPER,
      })
    ).rejects.toThrow(AdminValidationError);
  });

  it("cross-org isolation: another organization's employee is never listed/gettable", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    const result = await createEmployee(fx.supabase, {
      organizationId: other.organizationId,
      createdByAppUserId: other.appUserId,
      firstName: "OrgB",
      lastName: `Employee${randomUUID().slice(0, 6)}`,
      defaultStationId: null,
      grantKioskAccess: false,
      pin: null,
      pinPepper: PIN_PEPPER,
    });

    const fetchedFromWrongOrg = await getAdminUser(fx.supabase, fx.organizationId, result.employeeId);
    expect(fetchedFromWrongOrg).toBeNull();

    const listedFromWrongOrg = await listAdminUsers(fx.supabase, { organizationId: fx.organizationId });
    expect(listedFromWrongOrg.some((u) => u.employeeId === result.employeeId)).toBe(false);
  });

  it("an organization's own station can never be assigned to another organization's employee as default", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    await expect(
      createEmployee(fx.supabase, {
        organizationId: other.organizationId,
        createdByAppUserId: other.appUserId,
        firstName: "CrossOrg",
        lastName: "Default",
        defaultStationId: fx.stationId, // belongs to fx.organizationId, not other.organizationId
        grantKioskAccess: false,
        pin: null,
        pinPepper: PIN_PEPPER,
      })
    ).rejects.toThrow(AdminActionError);
  });
});

describe("updateEmployeeName / setEmployeeDefaultStation", () => {
  it("updates the name and it is reflected on read", async () => {
    const created = await createEmployee(fx.supabase, {
      organizationId: fx.organizationId,
      createdByAppUserId: fx.changeableEmployeeAppUserId,
      firstName: "Old",
      lastName: `Name${randomUUID().slice(0, 6)}`,
      defaultStationId: null,
      grantKioskAccess: false,
      pin: null,
      pinPepper: PIN_PEPPER,
    });
    await updateEmployeeName(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.employeeId, "New", "Name");
    const fetched = await getAdminUser(fx.supabase, fx.organizationId, created.employeeId);
    expect(fetched?.firstName).toBe("New");
    expect(fetched?.lastName).toBe("Name");
  });

  it("changes the default station, and rejects an inactive one", async () => {
    const created = await createEmployee(fx.supabase, {
      organizationId: fx.organizationId,
      createdByAppUserId: fx.changeableEmployeeAppUserId,
      firstName: "Station",
      lastName: `Change${randomUUID().slice(0, 6)}`,
      defaultStationId: null,
      grantKioskAccess: false,
      pin: null,
      pinPepper: PIN_PEPPER,
    });
    await setEmployeeDefaultStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.employeeId, fx.otherStationId);
    const fetched = await getAdminUser(fx.supabase, fx.organizationId, created.employeeId);
    expect(fetched?.defaultStationId).toBe(fx.otherStationId);

    await expect(setEmployeeDefaultStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.employeeId, randomUUID())).rejects.toThrow(AdminActionError);
  });
});

describe("setEmployeeStatus -- deactivate/reactivate, history preserved", () => {
  it("deactivates then reactivates an employee, keeping the same employee id throughout", async () => {
    const created = await createEmployee(fx.supabase, {
      organizationId: fx.organizationId,
      createdByAppUserId: fx.changeableEmployeeAppUserId,
      firstName: "Lifecycle",
      lastName: `Test${randomUUID().slice(0, 6)}`,
      defaultStationId: null,
      grantKioskAccess: true,
      pin: uniquePin(),
      pinPepper: PIN_PEPPER,
    });

    await setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.employeeId, "inactive");
    let fetched = await getAdminUser(fx.supabase, fx.organizationId, created.employeeId);
    expect(fetched?.employeeStatus).toBe("inactive");
    expect(fetched?.isAppUserActive).toBe(false); // kept in sync -- Part 47's kiosk-gap fix

    await setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.employeeId, "active");
    fetched = await getAdminUser(fx.supabase, fx.organizationId, created.employeeId);
    expect(fetched?.employeeId).toBe(created.employeeId);
    expect(fetched?.employeeStatus).toBe("active");
    expect(fetched?.isAppUserActive).toBe(true);
  });
});

describe("Role changes and last-Admin / self protection", () => {
  it("rejects granting Manager/Admin to an employee with no application login account", async () => {
    const created = await createEmployee(fx.supabase, {
      organizationId: fx.organizationId,
      createdByAppUserId: fx.changeableEmployeeAppUserId,
      firstName: "NoAuth",
      lastName: `Role${randomUUID().slice(0, 6)}`,
      defaultStationId: null,
      grantKioskAccess: true,
      pin: uniquePin(),
      pinPepper: PIN_PEPPER,
    });
    await expect(setUserRole(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.appUserId!, "manager")).rejects.toThrow(AdminActionError);
  });

  it("last-Admin protection: the only active Admin cannot be demoted, and can be promoted-then-demoted once a second Admin exists", async () => {
    const admin1 = await findOrCreateTestAdminAppUser(fx, "one");
    const admin2 = await findOrCreateTestAdminAppUser(fx, "two");
    const actor = fx.changeableEmployeeAppUserId;

    // Force a deterministic starting state (admin1 = admin, admin2 = manager
    // only) via DIRECT table writes, never through setUserRole itself --
    // using the RPC under test to arrange its own preconditions would run
    // straight into the very protection this test exercises (demoting
    // admin2 first could itself leave admin1 as the sole admin mid-setup
    // and get rejected).
    const { data: adminRole } = await fx.supabase.from("roles").select("id").eq("name", "admin").single();
    const { data: managerRole } = await fx.supabase.from("roles").select("id").eq("name", "manager").single();
    await fx.supabase.from("user_roles").delete().eq("app_user_id", admin2).in("role_id", [adminRole!.id, managerRole!.id]);
    await fx.supabase.from("user_roles").upsert({ app_user_id: admin2, role_id: managerRole!.id, organization_id: fx.organizationId });
    await fx.supabase.from("user_roles").upsert({ app_user_id: admin1, role_id: adminRole!.id, organization_id: fx.organizationId });

    // Now admin1 is the ONLY active admin -- demoting it via the RPC must be rejected.
    await expect(setUserRole(fx.supabase, fx.organizationId, actor, admin1, "manager")).rejects.toThrow(AdminActionError);

    // Promote admin2 to admin too -- now there are two, so admin1 CAN be demoted via the RPC.
    await setUserRole(fx.supabase, fx.organizationId, actor, admin2, "admin");
    await setUserRole(fx.supabase, fx.organizationId, actor, admin1, "manager");

    const { data: rolesAfter } = await fx.supabase.from("user_roles").select("roles(name)").eq("app_user_id", admin1);
    const roleNames = (rolesAfter ?? []).map((r) => (r as unknown as { roles: { name: string } }).roles.name);
    expect(roleNames).not.toContain("admin");

    // Restore admin1 to admin directly for future runs of this idempotent fixture.
    await fx.supabase.from("user_roles").upsert({ app_user_id: admin1, role_id: adminRole!.id, organization_id: fx.organizationId });
  });

  it("last-Admin protection also blocks deactivating the only active Admin", async () => {
    const admin1 = await findOrCreateTestAdminAppUser(fx, "one");
    const admin2 = await findOrCreateTestAdminAppUser(fx, "two");
    const actor = fx.changeableEmployeeAppUserId;

    await setUserRole(fx.supabase, fx.organizationId, actor, admin2, "employee");
    await setUserRole(fx.supabase, fx.organizationId, actor, admin1, "admin");

    const { data: admin1Row } = await fx.supabase.from("app_users").select("employee_id").eq("id", admin1).single();

    await expect(setEmployeeStatus(fx.supabase, fx.organizationId, actor, admin1Row!.employee_id as string, "inactive")).rejects.toThrow(AdminActionError);
  });

  it("self-protection: an Admin cannot change their own role or deactivate themselves", async () => {
    const admin1 = await findOrCreateTestAdminAppUser(fx, "one");
    const { data: admin1Row } = await fx.supabase.from("app_users").select("employee_id").eq("id", admin1).single();

    await expect(setUserRole(fx.supabase, fx.organizationId, admin1, admin1, "manager")).rejects.toThrow(AdminActionError);
    await expect(setEmployeeStatus(fx.supabase, fx.organizationId, admin1, admin1Row!.employee_id as string, "inactive")).rejects.toThrow(AdminActionError);
  });
});

describe("Stations -- create/list/get/rename/duplicate", () => {
  it("creates a station and it is immediately listed/gettable", async () => {
    const name = `TEST Admin Station ${randomUUID().slice(0, 8)}`;
    const stationId = await createStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, name);
    const fetched = await getAdminStation(fx.supabase, fx.organizationId, stationId);
    expect(fetched?.name).toBe(name);
    expect(fetched?.isActive).toBe(true);
    expect(fetched?.defaultEmployeeCount).toBe(0);

    const listed = await listAdminStations(fx.supabase, { organizationId: fx.organizationId, search: name });
    expect(listed.some((s) => s.stationId === stationId)).toBe(true);
  });

  it("trims whitespace and rejects an obvious duplicate active name", async () => {
    const name = `TEST Admin Dup ${randomUUID().slice(0, 8)}`;
    const stationId = await createStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, `  ${name}  `);
    const fetched = await getAdminStation(fx.supabase, fx.organizationId, stationId);
    expect(fetched?.name).toBe(name); // trimmed

    await expect(createStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, name)).rejects.toThrow(AdminActionError);
    await expect(createStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, `  ${name.toUpperCase()}  `)).rejects.toThrow(AdminActionError);
  });

  it("renaming a station preserves its id", async () => {
    const name = `TEST Admin Rename ${randomUUID().slice(0, 8)}`;
    const stationId = await createStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, name);
    const newName = `${name} Renamed`;
    await updateStationName(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, stationId, newName);

    const fetched = await getAdminStation(fx.supabase, fx.organizationId, stationId);
    expect(fetched?.stationId).toBe(stationId);
    expect(fetched?.name).toBe(newName);
  });

  it("cross-org isolation: another organization's station is never listed/gettable/mutable", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    const name = `TEST Admin OrgB Station ${randomUUID().slice(0, 8)}`;
    const stationId = await createStation(fx.supabase, other.organizationId, other.appUserId, name);

    expect(await getAdminStation(fx.supabase, fx.organizationId, stationId)).toBeNull();
    const listedFromWrongOrg = await listAdminStations(fx.supabase, { organizationId: fx.organizationId, search: name });
    expect(listedFromWrongOrg).toHaveLength(0);

    await expect(updateStationName(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, stationId, "Hijacked")).rejects.toThrow(AdminActionError);
    await expect(setStationStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, stationId, false)).rejects.toThrow(AdminActionError);
  });
});

describe("Stations -- deactivation dependency protection + reactivation", () => {
  it("deactivation is blocked while active employees use the station as their default, and succeeds once none do", async () => {
    const name = `TEST Admin Dependent ${randomUUID().slice(0, 8)}`;
    const stationId = await createStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, name);

    const employee = await createEmployee(fx.supabase, {
      organizationId: fx.organizationId,
      createdByAppUserId: fx.changeableEmployeeAppUserId,
      firstName: "Dependent",
      lastName: `Employee${randomUUID().slice(0, 6)}`,
      defaultStationId: stationId,
      grantKioskAccess: false,
      pin: null,
      pinPepper: PIN_PEPPER,
    });

    await expect(setStationStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, stationId, false)).rejects.toThrow(AdminActionError);

    // Still active -- deactivation was truly blocked, not silently applied.
    expect((await getAdminStation(fx.supabase, fx.organizationId, stationId))?.isActive).toBe(true);

    await setEmployeeDefaultStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employee.employeeId, null);
    await setStationStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, stationId, false);
    expect((await getAdminStation(fx.supabase, fx.organizationId, stationId))?.isActive).toBe(false);
  });

  it("an inactive station no longer appears in the active-station kiosk query, and reactivation restores it under the SAME id", async () => {
    const name = `TEST Admin Reactivate ${randomUUID().slice(0, 8)}`;
    const stationId = await createStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, name);
    await setStationStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, stationId, false);

    const { data: activeRows } = await fx.supabase.from("stations").select("id").eq("organization_id", fx.organizationId).eq("is_active", true).eq("id", stationId);
    expect(activeRows).toHaveLength(0);

    await setStationStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, stationId, true);
    const fetched = await getAdminStation(fx.supabase, fx.organizationId, stationId);
    expect(fetched?.stationId).toBe(stationId);
    expect(fetched?.isActive).toBe(true);
  });
});

describe("Audit events", () => {
  it("station creation, rename, and status change each produce an audit_events row", async () => {
    const name = `TEST Admin Audit ${randomUUID().slice(0, 8)}`;
    const stationId = await createStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, name);
    await updateStationName(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, stationId, `${name} v2`);
    await setStationStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, stationId, false);

    const { data: events } = await fx.supabase
      .from("audit_events")
      .select("action, entity_type, entity_id, actor_app_user_id")
      .eq("organization_id", fx.organizationId)
      .eq("entity_id", stationId)
      .eq("entity_type", "station");

    const actions = (events ?? []).map((e) => e.action);
    expect(actions).toContain("STATION_CREATED");
    expect(actions).toContain("STATION_RENAMED");
    expect(actions).toContain("STATION_STATUS_CHANGED");
    expect((events ?? []).every((e) => e.actor_app_user_id === fx.changeableEmployeeAppUserId)).toBe(true);
  });

  it("employee creation, status change, and default station change each produce an audit_events row", async () => {
    const created = await createEmployee(fx.supabase, {
      organizationId: fx.organizationId,
      createdByAppUserId: fx.changeableEmployeeAppUserId,
      firstName: "Audit",
      lastName: `Employee${randomUUID().slice(0, 6)}`,
      defaultStationId: null,
      grantKioskAccess: false,
      pin: null,
      pinPepper: PIN_PEPPER,
    });
    await setEmployeeDefaultStation(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.employeeId, fx.stationId);
    await setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, created.employeeId, "inactive");

    const { data: events } = await fx.supabase
      .from("audit_events")
      .select("action")
      .eq("organization_id", fx.organizationId)
      .eq("entity_id", created.employeeId)
      .eq("entity_type", "employee");

    const actions = (events ?? []).map((e) => e.action);
    expect(actions).toContain("EMPLOYEE_CREATED");
    expect(actions).toContain("EMPLOYEE_DEFAULT_STATION_CHANGED");
    expect(actions).toContain("EMPLOYEE_STATUS_CHANGED");
  });
});
