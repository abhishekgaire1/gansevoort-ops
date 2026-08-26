import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures } from "./testFixtures";
import { verifyPinCore } from "@/app/lib/auth/verifyPin";
import {
  createEmployee,
  setEmployeeKioskPin,
  setEmployeeStatus,
  getAdminUser,
  linkInvitedAppUser,
  startManagerOrAdminProvisioning,
  markProvisioningFailed,
} from "@/app/lib/admin/users";
import { AdminActionError } from "@/app/lib/admin/errors";

/**
 * MANUAL / ON-DEMAND ONLY -- see adminFoundation.rpc.test.ts's header
 * comment (same convention every other .rpc.test.ts file in this repo
 * follows: not run by `npm test`, run explicitly).
 *
 * Identity + Access Management milestone (20260811100095/96) -- exercises
 * the collision-safe kiosk PIN lifecycle (set/reset, concurrent-assignment
 * race, cross-org allowance, reactivation-collision blocking) and
 * link_invited_app_user against the real linked dev database.
 *
 * Also covers the provisioning-resumability fix (20260811100097), added
 * after a real Admin invite hit Supabase's email rate limit and the
 * resulting employee silently lost its intended Manager role. These
 * tests exercise start_manager_admin_provisioning /
 * mark_app_user_provisioning_failed / link_invited_app_user's new
 * provisioning_status field directly at the RPC level -- real Auth Admin
 * API behavior (actual inviteUserByEmail sends) is deliberately NOT
 * exercised here; see invitations.unit.test.ts for that orchestration,
 * mocked to avoid burning real Supabase email quota.
 */

let fx: RpcTestFixtures;
const PIN_PEPPER = process.env.PIN_PEPPER!;
const KIOSK_TOKEN_SECRET = "test-iam-rpc-kiosk-secret";

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
});

function uniquePin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function newEmployee(organizationId: string, actorAppUserId: string, label: string): Promise<string> {
  const result = await createEmployee(fx.supabase, {
    organizationId,
    createdByAppUserId: actorAppUserId,
    firstName: "IAM",
    lastName: `${label}${randomUUID().slice(0, 6)}`,
    defaultStationId: null,
    grantKioskAccess: false,
    pin: null,
    pinPepper: PIN_PEPPER,
  });
  return result.employeeId;
}

describe("setEmployeeKioskPin -- set/reset lifecycle", () => {
  it("sets a PIN for an employee with no prior kiosk access, and it authenticates", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "Set");
    const pin = uniquePin();
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, pin, PIN_PEPPER);

    const fetched = await getAdminUser(fx.supabase, fx.organizationId, employeeId);
    expect(fetched?.hasPin).toBe(true);
    expect(fetched?.isAppUserActive).toBe(true);

    const auth = await verifyPinCore(fx.supabase, {
      pin,
      organizationId: fx.organizationId,
      sourceIp: `iam-set-${randomUUID()}`,
      deviceId: `iam-set-${randomUUID()}`,
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });
    expect(auth.ok).toBe(true);
  });

  it("resetting a PIN immediately invalidates the old one -- no grace period, no dual-active hashes", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "Reset");
    const oldPin = uniquePin();
    let newPin = uniquePin();
    while (newPin === oldPin) newPin = uniquePin();

    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, oldPin, PIN_PEPPER);
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, newPin, PIN_PEPPER);

    const oldAuth = await verifyPinCore(fx.supabase, {
      pin: oldPin,
      organizationId: fx.organizationId,
      sourceIp: `iam-reset-old-${randomUUID()}`,
      deviceId: `iam-reset-old-${randomUUID()}`,
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });
    expect(oldAuth).toEqual({ ok: false, reason: "invalid_pin" });

    const newAuth = await verifyPinCore(fx.supabase, {
      pin: newPin,
      organizationId: fx.organizationId,
      sourceIp: `iam-reset-new-${randomUUID()}`,
      deviceId: `iam-reset-new-${randomUUID()}`,
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });
    expect(newAuth.ok).toBe(true);
  });

  it("rejects setting a PIN for an inactive employee (must reactivate first)", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "Inactive");
    await setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, "inactive");

    await expect(setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, uniquePin(), PIN_PEPPER)).rejects.toMatchObject({
      code: "EMPLOYEE_NOT_ELIGIBLE_FOR_PIN",
    });
  });

  it("rejects a same-org active PIN collision with a clear, non-attributing error", async () => {
    const employeeA = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "CollideA");
    const employeeB = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "CollideB");
    const pin = uniquePin();

    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeA, pin, PIN_PEPPER);

    await expect(setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeB, pin, PIN_PEPPER)).rejects.toMatchObject({
      code: "PIN_ALREADY_IN_USE",
    });
  });

  it("concurrent requests assigning the SAME PIN to two different eligible employees: exactly one succeeds", async () => {
    const employeeA = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "RaceA");
    const employeeB = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "RaceB");
    const pin = uniquePin();

    const results = await Promise.allSettled([
      setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeA, pin, PIN_PEPPER),
      setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeB, pin, PIN_PEPPER),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "PIN_ALREADY_IN_USE" });

    // No ambiguous/partial state: exactly one of the two employees ends up
    // with the PIN configured, the other has none.
    const [fetchedA, fetchedB] = await Promise.all([getAdminUser(fx.supabase, fx.organizationId, employeeA), getAdminUser(fx.supabase, fx.organizationId, employeeB)]);
    expect([fetchedA?.hasPin, fetchedB?.hasPin].filter(Boolean)).toHaveLength(1);
  });

  it("the same PIN is independently valid in two different organizations", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    const employeeHere = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "CrossOrgHere");
    const employeeThere = await newEmployee(other.organizationId, other.appUserId, "CrossOrgThere");
    const pin = uniquePin();

    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeHere, pin, PIN_PEPPER);
    await expect(setEmployeeKioskPin(fx.supabase, other.organizationId, other.appUserId, employeeThere, pin, PIN_PEPPER)).resolves.not.toThrow();

    const authHere = await verifyPinCore(fx.supabase, {
      pin,
      organizationId: fx.organizationId,
      sourceIp: `iam-crossorg-here-${randomUUID()}`,
      deviceId: `iam-crossorg-here-${randomUUID()}`,
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });
    const authThere = await verifyPinCore(fx.supabase, {
      pin,
      organizationId: other.organizationId,
      sourceIp: `iam-crossorg-there-${randomUUID()}`,
      deviceId: `iam-crossorg-there-${randomUUID()}`,
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });
    expect(authHere.ok).toBe(true);
    expect(authThere.ok).toBe(true);
  });

  it("audits the PIN reset without ever recording the PIN, its hash, or the lookup hash", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "Audit");
    const pin = uniquePin();
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, pin, PIN_PEPPER);

    const { data: events } = await fx.supabase
      .from("audit_events")
      .select("action, after_state, actor_app_user_id")
      .eq("organization_id", fx.organizationId)
      .eq("entity_type", "employee")
      .eq("entity_id", employeeId)
      .eq("action", "KIOSK_PIN_RESET");

    expect(events).toHaveLength(1);
    const event = events![0];
    expect(event.actor_app_user_id).toBe(fx.changeableEmployeeAppUserId);
    const serialized = JSON.stringify(event.after_state);
    expect(serialized).not.toMatch(new RegExp(pin));
    expect(serialized.toLowerCase()).not.toMatch(/pin_hash|pin_lookup_hash|argon2/);
  });

  it("no read API ever returns a PIN, PIN hash, or lookup hash", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "NoLeak");
    const pin = uniquePin();
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, pin, PIN_PEPPER);

    const fetched = await getAdminUser(fx.supabase, fx.organizationId, employeeId);
    const serialized = JSON.stringify(fetched);
    expect(serialized).not.toMatch(new RegExp(pin));
    expect(serialized.toLowerCase()).not.toMatch(/pin_hash|pin_lookup_hash|argon2/);
  });
});

describe("setEmployeeStatus -- reactivation PIN-collision protection", () => {
  it("an inactive employee's old PIN may be reused by a different active employee", async () => {
    const employeeA = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "ReuseA");
    const pin = uniquePin();
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeA, pin, PIN_PEPPER);
    await setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeA, "inactive");

    const employeeB = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "ReuseB");
    await expect(setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeB, pin, PIN_PEPPER)).resolves.not.toThrow();
  });

  it("reactivating an employee whose stored PIN is now held by another active employee is blocked, not silently reassigned", async () => {
    const employeeA = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "BlockA");
    const pin = uniquePin();
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeA, pin, PIN_PEPPER);
    await setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeA, "inactive");

    const employeeB = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "BlockB");
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeB, pin, PIN_PEPPER);

    await expect(setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeA, "active")).rejects.toMatchObject({
      code: "PIN_CONFLICTS_ON_REACTIVATION",
    });

    // Blocked, not partial: employee A remains inactive, its stored PIN
    // untouched, and B's active PIN is unaffected.
    const fetchedA = await getAdminUser(fx.supabase, fx.organizationId, employeeA);
    expect(fetchedA?.employeeStatus).toBe("inactive");
    const fetchedB = await getAdminUser(fx.supabase, fx.organizationId, employeeB);
    expect(fetchedB?.isAppUserActive).toBe(true);
  });

  it("reactivating an employee with no collision succeeds normally", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "CleanReactivate");
    const pin = uniquePin();
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, pin, PIN_PEPPER);
    await setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, "inactive");
    await setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, "active");

    const fetched = await getAdminUser(fx.supabase, fx.organizationId, employeeId);
    expect(fetched?.employeeStatus).toBe("active");
    expect(fetched?.isAppUserActive).toBe(true);
  });
});

describe("linkInvitedAppUser", () => {
  async function findOrCreateAuthUser(email: string): Promise<string> {
    const { data: created } = await fx.supabase.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true });
    if (created?.user) return created.user.id;
    const { data: list } = await fx.supabase.auth.admin.listUsers();
    const existing = list.users.find((u) => u.email === email);
    if (!existing) throw new Error(`could not find or create auth user ${email}`);
    return existing.id;
  }

  it("links a fresh employee to an auth account and grants the manager role", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "LinkFresh");
    const authUserId = await findOrCreateAuthUser(`iam-link-fresh-${randomUUID()}@gansevoort.test`);

    const appUserId = await linkInvitedAppUser(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, authUserId, "manager");
    expect(appUserId).toBeTruthy();

    const fetched = await getAdminUser(fx.supabase, fx.organizationId, employeeId);
    expect(fetched?.hasAuthAccount).toBe(true);
    expect(fetched?.primaryRole).toBe("manager");
    expect(fetched?.hasPin).toBe(false);
  });

  it("promoting a kiosk employee to Manager preserves their existing PIN/kiosk access", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "LinkKeepsPin");
    const pin = uniquePin();
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, pin, PIN_PEPPER);

    const authUserId = await findOrCreateAuthUser(`iam-link-keeps-pin-${randomUUID()}@gansevoort.test`);
    await linkInvitedAppUser(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, authUserId, "manager");

    const fetched = await getAdminUser(fx.supabase, fx.organizationId, employeeId);
    expect(fetched?.hasAuthAccount).toBe(true);
    expect(fetched?.hasPin).toBe(true);

    const auth = await verifyPinCore(fx.supabase, {
      pin,
      organizationId: fx.organizationId,
      sourceIp: `iam-link-keeps-pin-auth-${randomUUID()}`,
      deviceId: `iam-link-keeps-pin-auth-${randomUUID()}`,
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });
    expect(auth.ok).toBe(true);
  });

  it("is safe to call again for the same employee (resend) -- no duplicate app_user, role stays granted once", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "LinkResend");
    const authUserId = await findOrCreateAuthUser(`iam-link-resend-${randomUUID()}@gansevoort.test`);

    const firstAppUserId = await linkInvitedAppUser(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, authUserId, "manager");
    const secondAppUserId = await linkInvitedAppUser(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, authUserId, "manager");
    expect(secondAppUserId).toBe(firstAppUserId);

    const { data: roleGrants } = await fx.supabase.from("user_roles").select("role_id, roles(name)").eq("app_user_id", firstAppUserId);
    const managerGrants = (roleGrants ?? []).filter((r) => (r as unknown as { roles: { name: string } }).roles.name === "manager");
    expect(managerGrants).toHaveLength(1);
  });

  it("rejects linking to an employee that does not exist in this organization", async () => {
    const other = await setupOtherOrgFixtures(fx.supabase);
    const authUserId = await findOrCreateAuthUser(`iam-link-wrongorg-${randomUUID()}@gansevoort.test`);
    const employeeId = await newEmployee(other.organizationId, other.appUserId, "WrongOrgEmployee");

    await expect(linkInvitedAppUser(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, authUserId, "manager")).rejects.toThrow(AdminActionError);
  });
});

describe("Inactive employee kiosk authentication", () => {
  it("an inactive employee's PIN never authenticates, even though it was valid before deactivation", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "InactiveAuth");
    const pin = uniquePin();
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, pin, PIN_PEPPER);
    await setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, "inactive");

    const auth = await verifyPinCore(fx.supabase, {
      pin,
      organizationId: fx.organizationId,
      sourceIp: `iam-inactive-auth-${randomUUID()}`,
      deviceId: `iam-inactive-auth-${randomUUID()}`,
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });
    expect(auth).toEqual({ ok: false, reason: "invalid_pin" });
  });
});

describe("Manager/Admin provisioning resumability (post-launch fix)", () => {
  it("start_manager_admin_provisioning records intent (role + email) before any Auth call, and it is immediately visible on read", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "ProvisionFresh");
    const email = `provision-fresh-${randomUUID()}@gansevoort.test`;

    const started = await startManagerOrAdminProvisioning(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, email, "manager");
    expect(started.appUserId).toBeTruthy();
    expect(started.existingAuthUserId).toBeNull();

    const fetched = await getAdminUser(fx.supabase, fx.organizationId, employeeId);
    expect(fetched?.provisioningStatus).toBe("invite_pending");
    expect(fetched?.intendedRole).toBe("manager");
    expect(fetched?.pendingEmail).toBe(email);
    // Not yet authorized -- no role granted, no auth account.
    expect(fetched?.primaryRole).toBe("employee");
    expect(fetched?.hasAuthAccount).toBe(false);
    // Display value shows the INTENDED role, even though nothing is granted yet.
    expect(fetched?.displayRole).toBe("manager");
  });

  it("mark_app_user_provisioning_failed preserves the employee, intended role, and email -- never downgrades to Employee (the exact bug this fixes)", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "ProvisionFailed");
    const email = `provision-failed-${randomUUID()}@gansevoort.test`;

    await startManagerOrAdminProvisioning(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, email, "manager");
    await markProvisioningFailed(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, "rate_limited");

    const fetched = await getAdminUser(fx.supabase, fx.organizationId, employeeId);
    expect(fetched?.provisioningStatus).toBe("invite_failed");
    expect(fetched?.intendedRole).toBe("manager");
    expect(fetched?.pendingEmail).toBe(email);
    expect(fetched?.displayRole).toBe("manager"); // NOT "employee"
    expect(fetched?.employeeStatus).toBe("active");
    expect(fetched?.hasAuthAccount).toBe(false);
  });

  it("retrying after a failure resumes the SAME app_user row -- no duplicate person, then succeeds via link_invited_app_user", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "ProvisionRetry");
    const email = `provision-retry-${randomUUID()}@gansevoort.test`;

    const first = await startManagerOrAdminProvisioning(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, email, "manager");
    await markProvisioningFailed(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, "provider_error");

    // Retry: start again for the SAME employee.
    const retry = await startManagerOrAdminProvisioning(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, email, "manager");
    expect(retry.appUserId).toBe(first.appUserId);

    let fetched = await getAdminUser(fx.supabase, fx.organizationId, employeeId);
    expect(fetched?.provisioningStatus).toBe("invite_pending");

    const { data: created } = await fx.supabase.auth.admin.createUser({ email: `auth-${email}`, password: randomUUID(), email_confirm: true });
    const appUserId = await linkInvitedAppUser(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, created!.user!.id, "manager");
    expect(appUserId).toBe(first.appUserId);

    fetched = await getAdminUser(fx.supabase, fx.organizationId, employeeId);
    expect(fetched?.provisioningStatus).toBe("invited");
    expect(fetched?.hasAuthAccount).toBe(true);
    expect(fetched?.primaryRole).toBe("manager");

    const { data: appUsers } = await fx.supabase.from("app_users").select("id").eq("employee_id", employeeId);
    expect(appUsers).toHaveLength(1); // never duplicated across the retry
  });

  it("concurrent provisioning-start requests for the SAME employee resolve to one app_user row, not two", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "ProvisionConcurrent");
    const email = `provision-concurrent-${randomUUID()}@gansevoort.test`;

    const [a, b] = await Promise.all([
      startManagerOrAdminProvisioning(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, email, "manager"),
      startManagerOrAdminProvisioning(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, email, "manager"),
    ]);
    expect(a.appUserId).toBe(b.appUserId);

    const { data: appUsers } = await fx.supabase.from("app_users").select("id").eq("employee_id", employeeId);
    expect(appUsers).toHaveLength(1);
  });

  it("rejects starting provisioning for an inactive employee", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "ProvisionInactive");
    await setEmployeeStatus(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, "inactive");

    await expect(
      startManagerOrAdminProvisioning(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, "provision-inactive@gansevoort.test", "manager")
    ).rejects.toMatchObject({ code: "EMPLOYEE_NOT_ELIGIBLE_FOR_PROVISIONING" });
  });

  it("audits provisioning start and failure without ever recording the email, a PIN, or a token", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "ProvisionAudit");
    const email = `provision-audit-${randomUUID()}@gansevoort.test`;

    await startManagerOrAdminProvisioning(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, email, "admin");
    await markProvisioningFailed(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, "rate_limited");

    const { data: events } = await fx.supabase
      .from("audit_events")
      .select("action, after_state")
      .eq("organization_id", fx.organizationId)
      .eq("entity_type", "employee")
      .eq("entity_id", employeeId)
      .in("action", ["APP_USER_PROVISIONING_STARTED", "APP_INVITE_FAILED"])
      .order("occurred_at", { ascending: true });

    expect(events).toHaveLength(2);
    expect(events![0]).toMatchObject({ action: "APP_USER_PROVISIONING_STARTED", after_state: { role: "admin" } });
    expect(events![1]).toMatchObject({ action: "APP_INVITE_FAILED", after_state: { reason: "rate_limited" } });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(serialized.toLowerCase()).not.toMatch(/password|token|pin_hash|service_role/);
  });

  it("start_manager_admin_provisioning never touches an existing kiosk PIN when promoting an employee who already has one", async () => {
    const employeeId = await newEmployee(fx.organizationId, fx.changeableEmployeeAppUserId, "ProvisionKeepsPin");
    const pin = uniquePin();
    await setEmployeeKioskPin(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, pin, PIN_PEPPER);

    await startManagerOrAdminProvisioning(fx.supabase, fx.organizationId, fx.changeableEmployeeAppUserId, employeeId, `provision-keeps-pin-${randomUUID()}@gansevoort.test`, "manager");

    const fetched = await getAdminUser(fx.supabase, fx.organizationId, employeeId);
    expect(fetched?.hasPin).toBe(true);

    const auth = await verifyPinCore(fx.supabase, {
      pin,
      organizationId: fx.organizationId,
      sourceIp: `iam-provision-keeps-pin-${randomUUID()}`,
      deviceId: `iam-provision-keeps-pin-${randomUUID()}`,
      pinPepper: PIN_PEPPER,
      kioskTokenSecret: KIOSK_TOKEN_SECRET,
    });
    expect(auth.ok).toBe(true);
  });
});
