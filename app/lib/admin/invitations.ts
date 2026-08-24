import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { linkInvitedAppUser, startManagerOrAdminProvisioning, markProvisioningFailed } from "@/app/lib/admin/users";
import { AdminActionError } from "@/app/lib/admin/errors";
import { logAuthOperation, newCorrelationId } from "@/app/lib/admin/authOperationLog";

/**
 * Identity + Access Management milestone -- Manager/Admin invitation and
 * password-reset orchestration. Supabase Auth account creation
 * (auth.admin.*) can ONLY happen server-side with the service-role
 * client (never exposed to the browser, Part 23/48) -- every function
 * here assumes it is already running in a Server Action/RPC context that
 * has already verified requireAdmin().
 *
 * ============================================================
 * PROVISIONING-RESUMABILITY FIX (post-launch bug)
 * ============================================================
 * The first real Admin invite hit Supabase's project-wide email rate
 * limit. The OLD version of this function called createEmployee, THEN
 * called inviteUserByEmail with no local record of intent in between --
 * when the invite failed, nothing distinguished that employee from an
 * ordinary kiosk-only Employee. The Users list showed "Employee / No
 * access configured," silently discarding the Admin's actual choice of
 * Manager.
 *
 * inviteManagerOrAdmin now always calls startManagerOrAdminProvisioning
 * FIRST (records intended_role + pending_email + 'invite_pending' in
 * app_users, upserted by employee_id -- idempotent) BEFORE ever touching
 * the Auth Admin API. Every exit path after that point -- success,
 * rate limit, provider error, or an email conflict discovered during
 * reconciliation -- either links the account (STEP 6A) or calls
 * markProvisioningFailed (STEP 6B), which preserves the employee,
 * intended role, and email and changes ONLY provisioning_status. A
 * failed invite can therefore always be retried by calling this SAME
 * function again with the same employeeId: if a prior attempt already
 * linked an Auth identity (out_existing_auth_user_id from step 1), this
 * skips the Auth Admin API entirely and just reconciles (Part 15 -- never
 * blindly re-invite an identity that already exists).
 *
 * DESIGN NOTE on partial-failure safety (Part 49/50), still true: the
 * employee record itself is created by a separate, earlier call
 * (createEmployee, from the Admin Foundation milestone) -- this function
 * only ever takes an existing employeeId and performs the invite+link
 * step, so a failure here never risks a duplicate person.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

type AuthErrorCategory = "rate_limited" | "already_registered" | "provider_error";

interface SupabaseAuthErrorLike {
  status?: number;
  code?: string;
  message?: string;
}

/** Classifies a raw Supabase Auth error into a safe, stable category
 * instead of ever showing/branching on its raw message (Part 6). Errs
 * toward "provider_error" (the generic, no-auto-retry-implied bucket)
 * for anything not clearly a rate limit or an existing-account signal. */
function classifyAuthError(error: SupabaseAuthErrorLike | null | undefined): AuthErrorCategory {
  const code = error?.code?.toLowerCase() ?? "";
  const message = error?.message?.toLowerCase() ?? "";
  if (error?.status === 429 || code.includes("rate_limit") || message.includes("rate limit")) {
    return "rate_limited";
  }
  if (code.includes("already") || code.includes("exists") || message.includes("already registered") || message.includes("already exists")) {
    return "already_registered";
  }
  return "provider_error";
}

const FRIENDLY_MESSAGE: Record<Exclude<AuthErrorCategory, "already_registered">, string> = {
  rate_limited: "Email sending is temporarily limited. This person's setup has been saved -- you can retry the invitation later.",
  provider_error: "The invitation could not be sent. This person's setup has been saved -- you can retry.",
};

export type InviteManagerOrAdminResult =
  | { ok: true; appUserId: string }
  | { ok: false; reason: "validation"; message: string }
  | { ok: false; reason: "email_conflict"; message: string }
  | { ok: false; reason: "rate_limited"; message: string }
  | { ok: false; reason: "provider_error"; message: string };

export async function inviteManagerOrAdmin(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    actorAppUserId: string;
    employeeId: string;
    email: string;
    role: "manager" | "admin";
    redirectTo: string;
  }
): Promise<InviteManagerOrAdminResult> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, reason: "validation", message: "Enter a valid email address." };
  }

  const correlationId = newCorrelationId();

  // STEP 1 (Part 9): record intent BEFORE the Auth Admin API is ever
  // called, so a failure below always has something truthful to fail
  // into rather than leaving no trace of the Admin's chosen role.
  const started = await startManagerOrAdminProvisioning(supabase, input.organizationId, input.actorAppUserId, input.employeeId, email, input.role);

  async function fail(reason: Exclude<InviteManagerOrAdminResult, { ok: true }>["reason"], message: string, authError?: SupabaseAuthErrorLike): Promise<InviteManagerOrAdminResult> {
    logAuthOperation({
      operation: "invite",
      correlationId,
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      appUserId: started.appUserId,
      attempt: 1,
      httpStatus: authError?.status,
      authErrorCode: authError?.code,
      result: reason === "validation" ? "validation_error" : reason,
    });
    await markProvisioningFailed(supabase, input.organizationId, input.actorAppUserId, input.employeeId, reason);
    return { ok: false, reason, message };
  }

  // Already linked -- either a genuine retry after an earlier success,
  // or a stale 'invite_failed' left from before this fix. Reconcile
  // WITHOUT calling the Auth Admin API again (Part 15).
  if (started.existingAuthUserId) {
    logAuthOperation({
      operation: "invite",
      correlationId,
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      appUserId: started.appUserId,
      attempt: 1,
      result: "reconciled",
    });
    const appUserId = await linkInvitedAppUser(supabase, input.organizationId, input.actorAppUserId, input.employeeId, started.existingAuthUserId, input.role);
    return { ok: true, appUserId };
  }

  const { data: invited, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo: input.redirectTo });

  let authUserId: string;
  if (invited?.user) {
    authUserId = invited.user.id;
    logAuthOperation({
      operation: "invite",
      correlationId,
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      appUserId: started.appUserId,
      attempt: 1,
      result: "success",
    });
  } else {
    const category = classifyAuthError(inviteError);

    if (category === "rate_limited" || category === "provider_error") {
      return fail(category, FRIENDLY_MESSAGE[category], inviteError ?? undefined);
    }

    // "already_registered": resolve carefully rather than guessing --
    // never silently attach an unproven identity to this employee (Part
    // 24). Every branch below still terminates via markProvisioningFailed
    // through fail(), so local state stays consistent either way.
    logAuthOperation({
      operation: "invite",
      correlationId,
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      appUserId: started.appUserId,
      attempt: 1,
      httpStatus: inviteError?.status,
      authErrorCode: inviteError?.code,
      result: "already_registered",
    });

    const { data: list, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) {
      return fail("provider_error", FRIENDLY_MESSAGE.provider_error, listError ?? undefined);
    }
    const existingAuthUser = list.users.find((u) => u.email?.toLowerCase() === email);
    if (!existingAuthUser) {
      return fail("provider_error", FRIENDLY_MESSAGE.provider_error, inviteError ?? undefined);
    }

    const { data: existingLink } = await supabase
      .from("app_users")
      .select("id, organization_id, employee_id")
      .eq("auth_user_id", existingAuthUser.id)
      .maybeSingle();

    if (existingLink && existingLink.organization_id !== input.organizationId) {
      return fail("email_conflict", "This email is already associated with an account in a different organization.");
    }
    if (existingLink && existingLink.employee_id !== input.employeeId) {
      return fail("email_conflict", "This email is already linked to a different user in this organization.");
    }
    if (!existingLink) {
      // An auth identity exists but is linked to nobody, in any org --
      // attaching it here without proof of ownership is exactly what
      // Part 24 forbids. Surface it plainly rather than guessing.
      return fail("email_conflict", "An account with this email already exists. Resolve this before inviting.");
    }
    // existingLink.employee_id === input.employeeId: this IS a safe
    // resend/retry for the same person -- reuse the existing auth identity.
    authUserId = existingAuthUser.id;
  }

  try {
    const appUserId = await linkInvitedAppUser(supabase, input.organizationId, input.actorAppUserId, input.employeeId, authUserId, input.role);
    return { ok: true, appUserId };
  } catch (err) {
    if (err instanceof AdminActionError) {
      return fail("provider_error", err.message);
    }
    throw err;
  }
}

export type ResendInvitationResult = { ok: true } | { ok: false; reason: "error"; message: string };

/**
 * Supabase's admin.inviteUserByEmail is documented to resend the
 * invitation email for an existing, not-yet-confirmed user rather than
 * erroring -- this reuses that same call rather than a separate
 * mechanism (Part 26/50: never create a duplicate auth account on
 * resend). If Supabase's behavior differs in this project's actual
 * configured version, this surfaces a clean error rather than crashing
 * or fabricating success -- verify by manual test (see final report).
 *
 * For a FAILED provisioning attempt (provisioning_status = 'invite_
 * failed'), use inviteManagerOrAdmin again instead ("Retry Invitation")
 * -- it already reconciles an existing Auth identity safely and updates
 * provisioning_status. This function is for the separate case of an
 * already-successfully-invited-but-still-unconfirmed person asking for
 * the email again.
 */
export async function resendInvitation(supabase: SupabaseClient, organizationId: string, email: string, redirectTo: string): Promise<ResendInvitationResult> {
  const correlationId = newCorrelationId();
  const { error } = await supabase.auth.admin.inviteUserByEmail(normalizeEmail(email), { redirectTo });
  if (error) {
    logAuthOperation({ operation: "resend", correlationId, organizationId, attempt: 1, httpStatus: error.status, authErrorCode: error.code, result: classifyAuthError(error) });
    return { ok: false, reason: "error", message: "Unable to resend the invitation. Try again." };
  }
  logAuthOperation({ operation: "resend", correlationId, organizationId, attempt: 1, result: "success" });
  return { ok: true };
}

export type SendPasswordResetResult = { ok: true } | { ok: false; reason: "error"; message: string };

/** The SAME self-service password-recovery mechanism the public login
 * page's own "Forgot password?" uses (Part 21) -- Admin triggers it on
 * the user's behalf but never sets, sees, or chooses a password. */
export async function sendAdminTriggeredPasswordReset(supabase: SupabaseClient, organizationId: string, email: string, redirectTo: string): Promise<SendPasswordResetResult> {
  const correlationId = newCorrelationId();
  const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email), { redirectTo });
  if (error) {
    logAuthOperation({ operation: "password_reset", correlationId, organizationId, attempt: 1, result: "provider_error" });
    return { ok: false, reason: "error", message: "Unable to send the password reset email. Try again." };
  }
  logAuthOperation({ operation: "password_reset", correlationId, organizationId, attempt: 1, result: "success" });
  return { ok: true };
}
