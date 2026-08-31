import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Proves every Admin Server Action
// gates on requireAdmin() -- a plain manager (or unauthenticated caller)
// is rejected before any admin RPC is ever reached (Admin Foundation
// milestone, Part 5/55: "hiding Admin from the sidebar is NOT
// sufficient").

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireAdmin: requireAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn(() => ({})) }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const adminUsersLib = vi.hoisted(() => ({
  listAdminUsers: vi.fn(async () => []),
  getAdminUser: vi.fn(async () => ({ employeeId: "emp-1", firstName: "A", lastName: "B", employeeStatus: "active", defaultStationId: null, defaultStationName: null, appUserId: null, isAppUserActive: null, hasAuthAccount: false, hasPin: false, roles: [], primaryRole: "employee" })),
  createEmployee: vi.fn(async () => ({ employeeId: "emp-new", appUserId: null })),
  updateEmployeeName: vi.fn(async () => undefined),
  setEmployeeDefaultStation: vi.fn(async () => undefined),
  setEmployeeStatus: vi.fn(async () => undefined),
  setUserRole: vi.fn(async () => undefined),
  setEmployeeKioskPin: vi.fn(async () => undefined),
  AdminValidationError: class AdminValidationError extends Error {
    code = "VALIDATION";
  },
}));
vi.mock("@/app/lib/admin/users", () => adminUsersLib);

const invitationsLib = vi.hoisted(() => ({
  inviteManagerOrAdmin: vi.fn(async () => ({ ok: true, appUserId: "app-user-invited" })),
  resendInvitation: vi.fn(async () => ({ ok: true })),
  sendAdminTriggeredPasswordReset: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/lib/admin/invitations", () => invitationsLib);

vi.mock("@/app/lib/auth/siteOrigin", () => ({ resolveSiteOrigin: vi.fn(async () => "https://app.example.test") }));

const adminStationsLib = vi.hoisted(() => ({
  listAdminStations: vi.fn(async () => []),
  getAdminStation: vi.fn(async () => ({ stationId: "station-1", name: "Coffee", code: null, isActive: true, defaultEmployeeCount: 0 })),
  createStation: vi.fn(async () => "station-new"),
  updateStationName: vi.fn(async () => undefined),
  setStationStatus: vi.fn(async () => undefined),
}));
vi.mock("@/app/lib/admin/stations", () => adminStationsLib);

vi.mock("@/app/lib/kiosk/stations", () => ({ listAllActiveStationsForOrganization: vi.fn(async () => []) }));

import {
  listAdminUsersAction,
  getAdminUserAction,
  createEmployeeAction,
  updateEmployeeNameAction,
  setEmployeeDefaultStationAction,
  setEmployeeStatusAction,
  setUserRoleAction,
  listActiveStationsForAdminAction,
  resetEmployeeKioskPinAction,
  inviteManagerOrAdminAction,
  resendInvitationAction,
  sendPasswordResetAction,
} from "@/app/actions/adminUsers";
import { listAdminStationsAction, getAdminStationAction, createStationAction, updateStationNameAction, setStationStatusAction } from "@/app/actions/adminStations";

const ADMIN = { ok: true as const, manager: { appUserId: "admin-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager", "admin"] } };
const NOT_ADMIN = { ok: false as const, reason: "not_authorized" as const };
const NOT_AUTHENTICATED = { ok: false as const, reason: "not_authenticated" as const };

beforeEach(() => {
  requireAdminMock.mockReset().mockResolvedValue(ADMIN);
  process.env.PIN_PEPPER = "test-pepper";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Users actions -- authorization gate", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "listAdminUsersAction", call: () => listAdminUsersAction(null, null, null) },
    { name: "getAdminUserAction", call: () => getAdminUserAction("emp-1") },
    { name: "createEmployeeAction", call: () => createEmployeeAction({ firstName: "A", lastName: "B", defaultStationId: null, grantKioskAccess: false, pin: null }) },
    { name: "updateEmployeeNameAction", call: () => updateEmployeeNameAction("emp-1", "A", "B") },
    { name: "setEmployeeDefaultStationAction", call: () => setEmployeeDefaultStationAction("emp-1", null) },
    { name: "setEmployeeStatusAction", call: () => setEmployeeStatusAction("emp-1", "inactive") },
    { name: "setUserRoleAction", call: () => setUserRoleAction("app-user-1", "manager") },
    { name: "listActiveStationsForAdminAction", call: () => listActiveStationsForAdminAction() },
    { name: "resetEmployeeKioskPinAction", call: () => resetEmployeeKioskPinAction("emp-1", "123456", "123456") },
    { name: "inviteManagerOrAdminAction", call: () => inviteManagerOrAdminAction("emp-1", "person@example.test", "manager") },
    { name: "resendInvitationAction", call: () => resendInvitationAction("person@example.test") },
    { name: "sendPasswordResetAction", call: () => sendPasswordResetAction("person@example.test") },
  ];

  for (const { name, call } of cases) {
    it(`${name} rejects a non-admin (manager) caller`, async () => {
      requireAdminMock.mockResolvedValue(NOT_ADMIN);
      const result = await call();
      expect(result.ok).toBe(false);
      expect((result as { reason?: string }).reason).toBe("not_authorized");
    });

    it(`${name} rejects an unauthenticated caller`, async () => {
      requireAdminMock.mockResolvedValue(NOT_AUTHENTICATED);
      const result = await call();
      expect(result.ok).toBe(false);
    });

    it(`${name} succeeds for an admin caller`, async () => {
      const result = await call();
      expect(result.ok).toBe(true);
    });
  }
});

describe("Stations actions -- authorization gate", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "listAdminStationsAction", call: () => listAdminStationsAction(null, null) },
    { name: "getAdminStationAction", call: () => getAdminStationAction("station-1") },
    { name: "createStationAction", call: () => createStationAction("Coffee") },
    { name: "updateStationNameAction", call: () => updateStationNameAction("station-1", "Coffee Bar") },
    { name: "setStationStatusAction", call: () => setStationStatusAction("station-1", false) },
  ];

  for (const { name, call } of cases) {
    it(`${name} rejects a non-admin (manager) caller`, async () => {
      requireAdminMock.mockResolvedValue(NOT_ADMIN);
      const result = await call();
      expect(result.ok).toBe(false);
      expect((result as { reason?: string }).reason).toBe("not_authorized");
    });

    it(`${name} rejects an unauthenticated caller`, async () => {
      requireAdminMock.mockResolvedValue(NOT_AUTHENTICATED);
      const result = await call();
      expect(result.ok).toBe(false);
    });

    it(`${name} succeeds for an admin caller`, async () => {
      const result = await call();
      expect(result.ok).toBe(true);
    });
  }
});

describe("createEmployeeAction / createStationAction -- pass the actor's own org, never a client-supplied one", () => {
  it("createEmployeeAction always uses the authenticated admin's organizationId/appUserId", async () => {
    await createEmployeeAction({ firstName: "A", lastName: "B", defaultStationId: null, grantKioskAccess: false, pin: null });
    expect(adminUsersLib.createEmployee).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org-1", createdByAppUserId: "admin-1" })
    );
  });

  it("createStationAction always uses the authenticated admin's organizationId/appUserId", async () => {
    await createStationAction("Coffee");
    expect(adminStationsLib.createStation).toHaveBeenCalledWith(expect.anything(), "org-1", "admin-1", "Coffee");
  });
});

describe("resetEmployeeKioskPinAction -- confirmation-mismatch rejected before ever reaching setEmployeeKioskPin", () => {
  it("rejects a mismatched PIN/confirmation without calling setEmployeeKioskPin", async () => {
    const result = await resetEmployeeKioskPinAction("emp-1", "123456", "654321");
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("VALIDATION");
    expect(adminUsersLib.setEmployeeKioskPin).not.toHaveBeenCalled();
  });

  it("calls setEmployeeKioskPin with the authenticated admin's org/actor when the PIN and confirmation match", async () => {
    await resetEmployeeKioskPinAction("emp-1", "123456", "123456");
    expect(adminUsersLib.setEmployeeKioskPin).toHaveBeenCalledWith(expect.anything(), "org-1", "admin-1", "emp-1", "123456", expect.any(String));
  });
});

describe("Invitation / password-reset actions -- always use the authenticated admin's org/actor and a server-resolved redirect", () => {
  it("inviteManagerOrAdminAction passes the authenticated admin's org/actor and a redirectTo derived from resolveSiteOrigin", async () => {
    await inviteManagerOrAdminAction("emp-1", "person@example.test", "admin");
    expect(invitationsLib.inviteManagerOrAdmin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-1",
        actorAppUserId: "admin-1",
        employeeId: "emp-1",
        email: "person@example.test",
        role: "admin",
        redirectTo: "https://app.example.test/manager/reset-password",
      })
    );
  });

  it("resendInvitationAction and sendPasswordResetAction also use a server-resolved redirect, never a hardcoded URL", async () => {
    await resendInvitationAction("person@example.test");
    expect(invitationsLib.resendInvitation).toHaveBeenCalledWith(expect.anything(), "org-1", "person@example.test", "https://app.example.test/manager/reset-password");

    await sendPasswordResetAction("person@example.test");
    expect(invitationsLib.sendAdminTriggeredPasswordReset).toHaveBeenCalledWith(expect.anything(), "org-1", "person@example.test", "https://app.example.test/manager/reset-password");
  });
});
