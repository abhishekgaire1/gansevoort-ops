"use server";

import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listActiveStationsForOrganization, type KioskStation } from "@/app/lib/kiosk/stations";
import {
  listAdminUsers,
  getAdminUser,
  createEmployee,
  updateEmployeeName,
  setEmployeeDefaultStation,
  setEmployeeStatus,
  setUserRole,
  setEmployeeKioskPin,
  AdminValidationError,
  type AdminUserSummary,
  type EmployeeStatus,
  type PrimaryRole,
} from "@/app/lib/admin/users";
import { AdminActionError } from "@/app/lib/admin/errors";
import { inviteManagerOrAdmin, resendInvitation, sendAdminTriggeredPasswordReset } from "@/app/lib/admin/invitations";
import { resolveSiteOrigin } from "@/app/lib/auth/siteOrigin";
import { getOrgPinRateLimitStatus, unlockOrgPinRateLimits, type OrgPinRateLimitStatus } from "@/app/lib/auth/rateLimit";

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as an Admin." };

function pinPepperEnv(): string {
  const pepper = process.env.PIN_PEPPER;
  if (!pepper) throw new Error("PIN_PEPPER is not set");
  return pepper;
}

export type ListAdminUsersResult = { ok: true; users: AdminUserSummary[] } | AuthFailure;

export async function listAdminUsersAction(search: string | null, role: PrimaryRole | null, status: EmployeeStatus | null): Promise<ListAdminUsersResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const users = await listAdminUsers(getServiceRoleClient(), { organizationId: auth.manager.organizationId, search, role, status });
  return { ok: true, users };
}

export type GetAdminUserResult = { ok: true; user: AdminUserSummary } | AuthFailure | { ok: false; reason: "not_found"; message: string };

export async function getAdminUserAction(employeeId: string): Promise<GetAdminUserResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const user = await getAdminUser(getServiceRoleClient(), auth.manager.organizationId, employeeId);
  if (!user) return { ok: false, reason: "not_found", message: "User not found." };
  return { ok: true, user };
}

export type ListActiveStationsForAdminResult = { ok: true; stations: KioskStation[] } | AuthFailure;

export async function listActiveStationsForAdminAction(): Promise<ListActiveStationsForAdminResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const stations = await listActiveStationsForOrganization(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, stations };
}

export type AdminMutationResult = { ok: true } | AuthFailure | { ok: false; reason: "error"; code: string; message: string };

function toMutationResult(err: unknown): AdminMutationResult {
  if (err instanceof AdminActionError || err instanceof AdminValidationError) {
    return { ok: false, reason: "error", code: err.code, message: err.message };
  }
  return { ok: false, reason: "error", code: "UNKNOWN", message: "Unable to save. Try again." };
}

export interface CreateEmployeeFormInput {
  firstName: string;
  lastName: string;
  defaultStationId: string | null;
  grantKioskAccess: boolean;
  pin: string | null;
}

export type CreateEmployeeActionResult = { ok: true; employeeId: string } | AuthFailure | { ok: false; reason: "error"; code: string; message: string };

export async function createEmployeeAction(input: CreateEmployeeFormInput): Promise<CreateEmployeeActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!input.firstName.trim() || !input.lastName.trim()) {
    return { ok: false, reason: "error", code: "VALIDATION", message: "Name is required." };
  }

  try {
    const result = await createEmployee(getServiceRoleClient(), {
      organizationId: auth.manager.organizationId,
      createdByAppUserId: auth.manager.appUserId,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      defaultStationId: input.defaultStationId,
      grantKioskAccess: input.grantKioskAccess,
      pin: input.pin,
      pinPepper: pinPepperEnv(),
    });
    return { ok: true, employeeId: result.employeeId };
  } catch (err) {
    const mapped = toMutationResult(err);
    if (mapped.ok) throw err;
    return mapped;
  }
}

export async function updateEmployeeNameAction(employeeId: string, firstName: string, lastName: string): Promise<AdminMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await updateEmployeeName(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, employeeId, firstName, lastName);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export async function setEmployeeDefaultStationAction(employeeId: string, stationId: string | null): Promise<AdminMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await setEmployeeDefaultStation(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, employeeId, stationId);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export async function setEmployeeStatusAction(employeeId: string, status: "active" | "inactive"): Promise<AdminMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await setEmployeeStatus(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, employeeId, status);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export async function setUserRoleAction(appUserId: string, role: PrimaryRole): Promise<AdminMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await setUserRole(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, appUserId, role);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

/** Reset (or set for the first time) an employee's kiosk PIN (Part 4/43).
 * The raw PIN travels only over this one trusted Server Action call and
 * is never returned -- the RPC layer only ever receives already-hashed
 * values and only ever confirms success/failure. */
export async function resetEmployeeKioskPinAction(employeeId: string, pin: string, confirmPin: string): Promise<AdminMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (pin !== confirmPin) {
    return { ok: false, reason: "error", code: "VALIDATION", message: "PIN and confirmation do not match." };
  }

  try {
    await setEmployeeKioskPin(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, employeeId, pin, pinPepperEnv());
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export type InviteManagerOrAdminActionResult =
  | { ok: true }
  | AuthFailure
  | { ok: false; reason: "validation" | "email_conflict" | "rate_limited" | "provider_error"; message: string };

/** Invites (or, for an existing kiosk-only employee being promoted,
 * links) a Manager/Admin application account (Part 22/23/30). Never
 * accepts or sets a password -- the invited person establishes their own
 * via the emailed Supabase Auth link.
 *
 * A failure here NEVER discards the Admin's chosen role or the target
 * employee -- inviteManagerOrAdmin always records intent before calling
 * the Auth Admin API, so `reason` distinguishes an actionable, resumable
 * failure (rate_limited/provider_error -- Setup Incomplete, Retry
 * Invitation available) from a hard validation/conflict error the Admin
 * must fix before retrying (post-launch provisioning-resumability fix). */
export async function inviteManagerOrAdminAction(employeeId: string, email: string, role: "manager" | "admin"): Promise<InviteManagerOrAdminActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const origin = await resolveSiteOrigin();
  const result = await inviteManagerOrAdmin(getServiceRoleClient(), {
    organizationId: auth.manager.organizationId,
    actorAppUserId: auth.manager.appUserId,
    employeeId,
    email,
    role,
    redirectTo: `${origin}/manager/reset-password`,
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason, message: result.message };
  }
  return { ok: true };
}

export type ResendInvitationActionResult = { ok: true } | AuthFailure | { ok: false; reason: "error"; message: string };

export async function resendInvitationAction(email: string): Promise<ResendInvitationActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const origin = await resolveSiteOrigin();
  const result = await resendInvitation(getServiceRoleClient(), auth.manager.organizationId, email, `${origin}/manager/reset-password`);
  if (!result.ok) return { ok: false, reason: "error", message: result.message };
  return { ok: true };
}

export type SendPasswordResetActionResult = { ok: true } | AuthFailure | { ok: false; reason: "error"; message: string };

/** Admin-triggered password reset (Part 21) -- Admin never enters,
 * chooses, or sees a password; this sends the exact same Supabase Auth
 * recovery email the self-service "Forgot password?" flow sends. */
export async function sendPasswordResetAction(email: string): Promise<SendPasswordResetActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const origin = await resolveSiteOrigin();
  const result = await sendAdminTriggeredPasswordReset(getServiceRoleClient(), auth.manager.organizationId, email, `${origin}/manager/reset-password`);
  if (!result.ok) return { ok: false, reason: "error", message: result.message };
  return { ok: true };
}

export type GetOrgPinRateLimitStatusResult = { ok: true; status: OrgPinRateLimitStatus } | AuthFailure;

/** Read-only: whether this Admin's own organization's kiosk PIN login is
 * currently locked out (org-wide failed-attempt scope only) and when that
 * lockout's window expires. Never exposes raw IPs, rate-limit keys, or
 * any employee/PIN data -- see getOrgPinRateLimitStatus's own comment. */
export async function getOrgPinRateLimitStatusAction(): Promise<GetOrgPinRateLimitStatusResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const status = await getOrgPinRateLimitStatus(getServiceRoleClient(), auth.manager.organizationId);
  return { ok: true, status };
}

export type UnlockOrgPinRateLimitsActionResult = { ok: true } | AuthFailure | { ok: false; reason: "error"; message: string };

/** Operational recovery: clears every PIN rate-limit record for this
 * Admin's own organization only -- organizationId always comes from
 * requireAdmin()'s server-resolved session, never client input. Restores
 * kiosk login ATTEMPTS only; does not change any employee's PIN, hash, or
 * kiosk token. Writes exactly one audit event (KIOSK_PIN_RATE_LIMIT_UNLOCK,
 * see unlock_org_pin_rate_limits). Client only ever receives generic
 * success/error, never the underlying counters. */
export async function unlockOrgPinRateLimitsAction(): Promise<UnlockOrgPinRateLimitsActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await unlockOrgPinRateLimits(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId);
    return { ok: true };
  } catch {
    return { ok: false, reason: "error", message: "Unable to unlock kiosk PIN attempts. Try again." };
  }
}
