import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashPinLookup, hashPinForStorage, isValidPinFormat } from "@/app/lib/auth/pin";
import { mapAdminRpcError } from "@/app/lib/admin/errors";

/**
 * Admin Foundation milestone -- Users (really: employees + their optional
 * app_user/kiosk-PIN/role records, never a single unified "user" table --
 * this schema deliberately keeps EMPLOYEE and APPLICATION ACCOUNT
 * separate, and this file preserves that distinction rather than
 * flattening it, Part 8). Wraps list_admin_users / get_admin_user /
 * create_employee / update_employee_name / set_employee_default_station /
 * set_employee_status / set_user_role (20260811100094).
 */

export type EmployeeStatus = "active" | "inactive" | "terminated";
export type PrimaryRole = "employee" | "manager" | "admin";
/** Auth-invitation lifecycle only -- deliberately separate from
 * app_users.is_active/isAppUserActive (Part 7 of the provisioning-
 * resumability fix: "enabled" and "onboarding finished" are different
 * questions). 'none' means no Manager/Admin provisioning was ever
 * started for this person. */
export type ProvisioningStatus = "none" | "invite_pending" | "invited" | "invite_failed";

export function primaryRoleFromRoles(roles: string[]): PrimaryRole {
  if (roles.includes("admin")) return "admin";
  if (roles.includes("manager")) return "manager";
  return "employee";
}

export interface AdminUserSummary {
  employeeId: string;
  firstName: string;
  lastName: string;
  employeeStatus: EmployeeStatus;
  defaultStationId: string | null;
  defaultStationName: string | null;
  appUserId: string | null;
  isAppUserActive: boolean | null;
  hasAuthAccount: boolean;
  /** Whether a kiosk PIN is actually configured -- distinct from
   * appUserId existing, since a Manager/Admin-only app_user (Identity +
   * Access Management milestone) has neither PIN field set. Never the
   * PIN itself. */
  hasPin: boolean;
  /** True only when hasPin is also true: a configured PIN that predates
   * the four-digit kiosk PIN feature and cannot authenticate at the
   * kiosk until a manager assigns a new four-digit PIN (forced-reset
   * transition). Never true for an employee with no PIN at all. */
  kioskPinResetRequired: boolean;
  roles: string[];
  /** The role that is actually GRANTED (usable for authorization) --
   * never influenced by an in-progress or failed invitation. */
  primaryRole: PrimaryRole;
  /** The role an Admin chose when starting Manager/Admin provisioning,
   * preserved across a failed invite (never downgraded to 'employee' by
   * an Auth/email failure -- the bug this field exists to fix). Null
   * when no provisioning was ever started. */
  intendedRole: PrimaryRole | null;
  provisioningStatus: ProvisioningStatus;
  /** The email a Manager/Admin invitation was/is being sent to,
   * preserved across a failed attempt so Retry Invitation never needs
   * retyping and never risks a stale email from elsewhere. */
  pendingEmail: string | null;
  /** What the Users list/detail page should actually show as this
   * person's role: the intended role while provisioning is in progress
   * or failed (so a failed invite still reads "Manager," never
   * "Employee"), otherwise the real granted role. This is a DISPLAY
   * value only -- authorization always uses primaryRole/roles. */
  displayRole: PrimaryRole;
}

interface AdminUserRow {
  out_employee_id: string;
  out_first_name: string;
  out_last_name: string;
  out_employee_status: EmployeeStatus;
  out_default_station_id: string | null;
  out_default_station_name: string | null;
  out_app_user_id: string | null;
  out_is_app_user_active: boolean | null;
  out_has_auth_account: boolean;
  out_has_pin: boolean;
  out_kiosk_pin_reset_required: boolean;
  out_intended_role: PrimaryRole | null;
  out_provisioning_status: ProvisioningStatus;
  out_pending_email: string | null;
  out_roles: string[] | null;
}

function mapUserRow(row: AdminUserRow): AdminUserSummary {
  const roles = row.out_roles ?? [];
  const primaryRole = primaryRoleFromRoles(roles);
  return {
    employeeId: row.out_employee_id,
    firstName: row.out_first_name,
    lastName: row.out_last_name,
    employeeStatus: row.out_employee_status,
    defaultStationId: row.out_default_station_id,
    defaultStationName: row.out_default_station_name,
    appUserId: row.out_app_user_id,
    isAppUserActive: row.out_is_app_user_active,
    hasAuthAccount: row.out_has_auth_account,
    hasPin: row.out_has_pin,
    kioskPinResetRequired: row.out_kiosk_pin_reset_required,
    roles,
    primaryRole,
    intendedRole: row.out_intended_role,
    provisioningStatus: row.out_provisioning_status,
    pendingEmail: row.out_pending_email,
    displayRole: row.out_intended_role ?? primaryRole,
  };
}

export interface ListAdminUsersInput {
  organizationId: string;
  search?: string | null;
  role?: PrimaryRole | null;
  status?: EmployeeStatus | null;
}

export async function listAdminUsers(supabase: SupabaseClient, input: ListAdminUsersInput): Promise<AdminUserSummary[]> {
  const { data, error } = await supabase.rpc("list_admin_users", {
    p_organization_id: input.organizationId,
    p_search: input.search?.trim() ? input.search.trim() : null,
    p_role: input.role ?? null,
    p_status: input.status ?? null,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as AdminUserRow[]).map(mapUserRow);
}

export async function getAdminUser(supabase: SupabaseClient, organizationId: string, employeeId: string): Promise<AdminUserSummary | null> {
  const { data, error } = await supabase.rpc("get_admin_user", { p_organization_id: organizationId, p_employee_id: employeeId });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as AdminUserRow | undefined;
  return row ? mapUserRow(row) : null;
}

/**
 * Resolves the raw auth_user_id for one employee's app_user row, so the
 * detail page can look up their email/invitation status via the Auth
 * Admin API (Part 25) -- a plain table read, not part of the RPC surface,
 * since it returns no business data of its own and list_admin_users
 * deliberately does not carry it (Part 25: avoid an N+1 Admin API call
 * per row on the list page).
 */
export async function getEmployeeAuthUserId(supabase: SupabaseClient, organizationId: string, employeeId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("app_users")
    .select("auth_user_id")
    .eq("organization_id", organizationId)
    .eq("employee_id", employeeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { auth_user_id: string | null } | null)?.auth_user_id ?? null;
}

/** A pre-RPC validation failure (never reaches the database) -- shaped
 * the same as AdminActionError so callers handle both uniformly. */
export class AdminValidationError extends Error {
  code = "VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "AdminValidationError";
  }
}

export interface CreateEmployeeInput {
  organizationId: string;
  createdByAppUserId: string;
  firstName: string;
  lastName: string;
  defaultStationId: string | null;
  grantKioskAccess: boolean;
  pin: string | null;
  pinPepper: string;
}

export interface CreateEmployeeResult {
  employeeId: string;
  appUserId: string | null;
}

/** Creates an OPERATIONAL employee, optionally with kiosk PIN access --
 * never a Supabase Auth account (Part 9/38/39: no safe production
 * account-provisioning flow currently exists in this codebase). PIN
 * hashing happens here, using the exact same helpers every other
 * PIN-writing path already trusts, before the already-hashed values are
 * handed to the RPC -- the RPC itself never sees a raw PIN. */
export async function createEmployee(supabase: SupabaseClient, input: CreateEmployeeInput): Promise<CreateEmployeeResult> {
  if (input.grantKioskAccess) {
    if (!input.pin || !isValidPinFormat(input.pin)) {
      throw new AdminValidationError("Enter a 4-digit PIN for kiosk access.");
    }
  }

  const pinLookupHash = input.grantKioskAccess && input.pin ? hashPinLookup(input.pin, input.pinPepper) : null;
  const pinHash = input.grantKioskAccess && input.pin ? await hashPinForStorage(input.pin) : null;

  const { data, error } = await supabase.rpc("create_employee", {
    p_organization_id: input.organizationId,
    p_created_by_app_user_id: input.createdByAppUserId,
    p_first_name: input.firstName,
    p_last_name: input.lastName,
    p_default_station_id: input.defaultStationId,
    p_grant_kiosk_access: input.grantKioskAccess,
    p_pin_lookup_hash: pinLookupHash,
    p_pin_hash: pinHash,
  });
  if (error) throw mapAdminRpcError(error);

  const row = (Array.isArray(data) ? data[0] : data) as { out_employee_id: string; out_app_user_id: string | null } | undefined;
  if (!row) throw new Error("create_employee returned no result");
  return { employeeId: row.out_employee_id, appUserId: row.out_app_user_id };
}

export async function updateEmployeeName(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  employeeId: string,
  firstName: string,
  lastName: string
): Promise<void> {
  const { error } = await supabase.rpc("update_employee_name", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_employee_id: employeeId,
    p_first_name: firstName,
    p_last_name: lastName,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function setEmployeeDefaultStation(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  employeeId: string,
  stationId: string | null
): Promise<void> {
  const { error } = await supabase.rpc("set_employee_default_station", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_employee_id: employeeId,
    p_station_id: stationId,
  });
  if (error) throw mapAdminRpcError(error);
}

/**
 * Identity + Access Management milestone -- the ONE authoritative path
 * for setting or resetting an employee's kiosk PIN (Part 43: create,
 * reset, and enable-kiosk-access all use this). Hashing (HMAC lookup +
 * Argon2id) happens here, using the exact helpers every other PIN-
 * writing path already trusts -- the RPC never sees a raw PIN and never
 * returns one (Part 3/16: the reset flow can never redisplay a PIN,
 * old or new, after submission).
 */
export async function setEmployeeKioskPin(supabase: SupabaseClient, organizationId: string, actorAppUserId: string, employeeId: string, pin: string, pinPepper: string): Promise<void> {
  if (!isValidPinFormat(pin)) {
    throw new AdminValidationError("Enter a valid PIN.");
  }

  const pinLookupHash = hashPinLookup(pin, pinPepper);
  const pinHash = await hashPinForStorage(pin);

  const { error } = await supabase.rpc("set_employee_kiosk_pin", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_employee_id: employeeId,
    p_pin_lookup_hash: pinLookupHash,
    p_pin_hash: pinHash,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function setEmployeeStatus(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  employeeId: string,
  status: "active" | "inactive"
): Promise<void> {
  const { error } = await supabase.rpc("set_employee_status", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_employee_id: employeeId,
    p_status: status,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function setUserRole(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  appUserId: string,
  role: PrimaryRole
): Promise<void> {
  const { error } = await supabase.rpc("set_user_role", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_app_user_id: appUserId,
    p_role_name: role,
  });
  if (error) throw mapAdminRpcError(error);
}

/**
 * The LOCAL half of inviting a Manager/Admin (Part 22/23) -- links an
 * already-created-or-resolved Supabase Auth user id to the employee's
 * app_users row and grants the role, atomically. The Auth account itself
 * (auth.admin.inviteUserByEmail) is created by the caller BEFORE this is
 * called -- SQL cannot reach the Auth Admin API. Safe to call again for
 * the same employee (upserts by employee_id, Part 50), and never touches
 * pin_lookup_hash/pin_hash, so an employee being promoted from kiosk-only
 * keeps their existing PIN/kiosk access untouched (Part 30).
 */
export async function linkInvitedAppUser(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  employeeId: string,
  authUserId: string,
  role: "manager" | "admin"
): Promise<string> {
  const { data, error } = await supabase.rpc("link_invited_app_user", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_employee_id: employeeId,
    p_auth_user_id: authUserId,
    p_role_name: role,
  });
  if (error) throw mapAdminRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_app_user_id: string } | undefined;
  if (!row) throw new Error("link_invited_app_user returned no result");
  return row.out_app_user_id;
}

export interface StartManagerOrAdminProvisioningResult {
  appUserId: string;
  /** Set only when this employee's app_users row already has a linked
   * Auth identity (a genuine retry after an earlier success, or a stale
   * 'invite_failed' left over from before this fix). When present, the
   * caller must NOT call the Auth Admin API again -- reconcile using
   * this id instead (Part 15). */
  existingAuthUserId: string | null;
}

/**
 * STEP 1 of the resumable Manager/Admin provisioning workflow (Part 9) --
 * records the Admin's intent (role + email) and marks provisioning
 * 'invite_pending' BEFORE the Auth Admin API is ever called, so a
 * subsequent Auth/email failure has something to fail INTO rather than
 * leaving no trace at all (the exact bug this fixes: a failed invite
 * used to leave nothing but a bare employee record, silently discarding
 * the chosen role). Upserts by employee_id -- idempotent, never touches
 * pin_lookup_hash/pin_hash/is_active/auth_user_id, so retrying never
 * creates a second person and never disturbs an existing kiosk PIN.
 */
export async function startManagerOrAdminProvisioning(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  employeeId: string,
  email: string,
  role: "manager" | "admin"
): Promise<StartManagerOrAdminProvisioningResult> {
  const { data, error } = await supabase.rpc("start_manager_admin_provisioning", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_employee_id: employeeId,
    p_email: email,
    p_role_name: role,
  });
  if (error) throw mapAdminRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_app_user_id: string; out_existing_auth_user_id: string | null } | undefined;
  if (!row) throw new Error("start_manager_admin_provisioning returned no result");
  return { appUserId: row.out_app_user_id, existingAuthUserId: row.out_existing_auth_user_id };
}

/**
 * STEP 6B (failure) of the resumable provisioning workflow -- flips
 * ONLY provisioning_status to 'invite_failed'. Never touches the
 * employee, intended_role, pending_email, or any PIN field, so the
 * Admin UI can show "Manager / Setup Incomplete" (Part 21: an Auth
 * failure changes application-access state only, never role intent).
 * `reason` must be a short safe CATEGORY (e.g. "rate_limited"), never a
 * raw provider error string.
 */
export async function markProvisioningFailed(
  supabase: SupabaseClient,
  organizationId: string,
  actorAppUserId: string,
  employeeId: string,
  reason: string
): Promise<void> {
  const { error } = await supabase.rpc("mark_app_user_provisioning_failed", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_employee_id: employeeId,
    p_reason: reason,
  });
  if (error) throw mapAdminRpcError(error);
}
