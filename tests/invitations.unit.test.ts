import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// CI-safe: no network, no database. Exercises inviteManagerOrAdmin's own
// orchestration logic (Identity + Access Management milestone, Part
// 22/24/49/50, extended by the provisioning-resumability fix Part 9/15)
// against a fully mocked Supabase client -- real Auth Admin API behavior
// (actual email delivery, actual inviteUserByEmail resend semantics,
// actual rate-limit thresholds) is explicitly NOT covered here and needs
// the user's manual verification / Supabase Auth log inspection.

const { linkInvitedAppUserMock, startProvisioningMock, markFailedMock } = vi.hoisted(() => ({
  linkInvitedAppUserMock: vi.fn(async () => "linked-app-user-1"),
  startProvisioningMock: vi.fn(async () => ({ appUserId: "app-user-1", existingAuthUserId: null as string | null })),
  markFailedMock: vi.fn(async () => undefined),
}));
vi.mock("@/app/lib/admin/users", () => ({
  linkInvitedAppUser: linkInvitedAppUserMock,
  startManagerOrAdminProvisioning: startProvisioningMock,
  markProvisioningFailed: markFailedMock,
}));

import { inviteManagerOrAdmin, resendInvitation, sendAdminTriggeredPasswordReset } from "@/app/lib/admin/invitations";
import { AdminActionError } from "@/app/lib/admin/errors";

interface FakeAuthUser {
  id: string;
  email: string;
}

function makeSupabase(opts: {
  inviteResult?: { user: FakeAuthUser } | null;
  inviteError?: { message: string; status?: number; code?: string } | null;
  listUsers?: FakeAuthUser[];
  listError?: { message: string } | null;
  existingLink?: { id: string; organization_id: string; employee_id: string } | null;
}): SupabaseClient {
  const inviteUserByEmail = vi.fn(async () => ({
    data: opts.inviteResult ? { user: opts.inviteResult.user } : { user: null },
    error: opts.inviteError ?? null,
  }));
  const listUsers = vi.fn(async () => ({
    data: { users: opts.listUsers ?? [] },
    error: opts.listError ?? null,
  }));
  const resetPasswordForEmail = vi.fn(async () => ({ error: null }));

  const maybeSingle = vi.fn(async () => ({ data: opts.existingLink ?? null }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));

  return {
    auth: { admin: { inviteUserByEmail, listUsers }, resetPasswordForEmail },
    from,
  } as unknown as SupabaseClient;
}

afterEach(() => {
  linkInvitedAppUserMock.mockClear();
  linkInvitedAppUserMock.mockResolvedValue("linked-app-user-1");
  startProvisioningMock.mockClear();
  startProvisioningMock.mockResolvedValue({ appUserId: "app-user-1", existingAuthUserId: null });
  markFailedMock.mockClear();
  markFailedMock.mockResolvedValue(undefined);
});

const BASE_INPUT = {
  organizationId: "org-1",
  actorAppUserId: "actor-1",
  employeeId: "emp-1",
  email: "Person@Example.Test",
  role: "manager" as const,
  redirectTo: "https://app.example.test/manager/reset-password",
};

describe("inviteManagerOrAdmin", () => {
  it("rejects an invalid email before ever recording provisioning intent or calling the Auth Admin API", async () => {
    const inviteUserByEmail = vi.fn();
    const supabase = { auth: { admin: { inviteUserByEmail } } } as unknown as SupabaseClient;

    const result = await inviteManagerOrAdmin(supabase, { ...BASE_INPUT, email: "not-an-email" });
    expect(result).toEqual({ ok: false, reason: "validation", message: "Enter a valid email address." });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(startProvisioningMock).not.toHaveBeenCalled();
  });

  it("fresh invite: records intent first, then creates the auth user, links it, and normalizes the email", async () => {
    const supabase = makeSupabase({ inviteResult: { user: { id: "auth-new", email: "person@example.test" } } });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result).toEqual({ ok: true, appUserId: "linked-app-user-1" });
    expect(startProvisioningMock).toHaveBeenCalledWith(supabase, "org-1", "actor-1", "emp-1", "person@example.test", "manager");
    expect(linkInvitedAppUserMock).toHaveBeenCalledWith(supabase, "org-1", "actor-1", "emp-1", "auth-new", "manager");
    expect((supabase.auth.admin.inviteUserByEmail as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("person@example.test");
    expect(markFailedMock).not.toHaveBeenCalled();
  });

  it("a rate-limit failure preserves the intended role/email: no employee downgrade, no duplicate record, provisioning marked failed with the right category", async () => {
    const supabase = makeSupabase({ inviteResult: null, inviteError: { message: "email rate limit exceeded", status: 429, code: "over_email_send_rate_limit" } });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("rate_limited");
    expect((result as { message: string }).message).not.toMatch(/rate limit exceeded/); // never the raw provider string
    expect(markFailedMock).toHaveBeenCalledWith(supabase, "org-1", "actor-1", "emp-1", "rate_limited");
    expect(linkInvitedAppUserMock).not.toHaveBeenCalled();
  });

  it("a generic provider failure is handled the same resumable way -- not special-cased only for the rate-limit string", async () => {
    const supabase = makeSupabase({ inviteResult: null, inviteError: { message: "SMTP connection refused", status: 500, code: "unexpected_failure" } });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("provider_error");
    expect((result as { message: string }).message).not.toMatch(/SMTP connection refused/);
    expect(markFailedMock).toHaveBeenCalledWith(supabase, "org-1", "actor-1", "emp-1", "provider_error");
  });

  it("retry success: a prior invite_pending record with no linked auth user retries inviteUserByEmail again and succeeds", async () => {
    startProvisioningMock.mockResolvedValueOnce({ appUserId: "app-user-1", existingAuthUserId: null });
    const supabase = makeSupabase({ inviteResult: { user: { id: "auth-retry", email: "person@example.test" } } });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result).toEqual({ ok: true, appUserId: "linked-app-user-1" });
    expect(linkInvitedAppUserMock).toHaveBeenCalledWith(supabase, "org-1", "actor-1", "emp-1", "auth-retry", "manager");
  });

  it("retry with an already-linked auth identity: reconciles WITHOUT calling the Auth Admin API again", async () => {
    startProvisioningMock.mockResolvedValueOnce({ appUserId: "app-user-1", existingAuthUserId: "auth-already-linked" });
    const inviteUserByEmail = vi.fn();
    const supabase = { auth: { admin: { inviteUserByEmail } } } as unknown as SupabaseClient;

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result).toEqual({ ok: true, appUserId: "linked-app-user-1" });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
    expect(linkInvitedAppUserMock).toHaveBeenCalledWith(supabase, "org-1", "actor-1", "emp-1", "auth-already-linked", "manager");
  });

  it("safe resend: invite fails because the auth user already exists AND is linked to this SAME employee -- reuses it, no email_conflict", async () => {
    const supabase = makeSupabase({
      inviteResult: null,
      inviteError: { message: "User already registered", code: "email_exists" },
      listUsers: [{ id: "auth-existing", email: "person@example.test" }],
      existingLink: { id: "app-user-existing", organization_id: "org-1", employee_id: "emp-1" },
    });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result).toEqual({ ok: true, appUserId: "linked-app-user-1" });
    expect(linkInvitedAppUserMock).toHaveBeenCalledWith(supabase, "org-1", "actor-1", "emp-1", "auth-existing", "manager");
  });

  it("cross-org conflict: the existing auth identity belongs to a DIFFERENT organization -- rejected, never attached", async () => {
    const supabase = makeSupabase({
      inviteResult: null,
      inviteError: { message: "User already registered", code: "email_exists" },
      listUsers: [{ id: "auth-existing", email: "person@example.test" }],
      existingLink: { id: "app-user-existing", organization_id: "org-2", employee_id: "emp-1" },
    });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("email_conflict");
    expect(linkInvitedAppUserMock).not.toHaveBeenCalled();
    expect(markFailedMock).toHaveBeenCalledWith(supabase, "org-1", "actor-1", "emp-1", "email_conflict");
  });

  it("same-org, different-employee conflict: rejected rather than silently reattached to this employee", async () => {
    const supabase = makeSupabase({
      inviteResult: null,
      inviteError: { message: "User already registered", code: "email_exists" },
      listUsers: [{ id: "auth-existing", email: "person@example.test" }],
      existingLink: { id: "app-user-existing", organization_id: "org-1", employee_id: "emp-other" },
    });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("email_conflict");
    expect(linkInvitedAppUserMock).not.toHaveBeenCalled();
  });

  it("orphaned auth identity (exists, linked to nobody): rejected rather than guessed at", async () => {
    const supabase = makeSupabase({
      inviteResult: null,
      inviteError: { message: "User already registered", code: "email_exists" },
      listUsers: [{ id: "auth-existing", email: "person@example.test" }],
      existingLink: null,
    });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("email_conflict");
    expect(linkInvitedAppUserMock).not.toHaveBeenCalled();
  });

  it("invite fails as 'already registered' but no matching auth user is found at all -- surfaces a resumable provider error, never fabricates success", async () => {
    const supabase = makeSupabase({
      inviteResult: null,
      inviteError: { message: "User already registered", code: "email_exists" },
      listUsers: [],
    });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("provider_error");
    expect(linkInvitedAppUserMock).not.toHaveBeenCalled();
  });

  it("invite fails as 'already registered' and listUsers itself fails -- surfaces a resumable provider error rather than throwing", async () => {
    const supabase = makeSupabase({
      inviteResult: null,
      inviteError: { message: "User already registered", code: "email_exists" },
      listError: { message: "listUsers failed" },
    });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("provider_error");
  });

  it("maps a domain error from linkInvitedAppUser to a resumable provisioning failure instead of throwing", async () => {
    linkInvitedAppUserMock.mockRejectedValueOnce(new AdminActionError("ROLE_REQUIRES_APPLICATION_ACCOUNT", "This employee has no application login account."));
    const supabase = makeSupabase({ inviteResult: { user: { id: "auth-new", email: "person@example.test" } } });

    const result = await inviteManagerOrAdmin(supabase, BASE_INPUT);
    expect(result).toEqual({ ok: false, reason: "provider_error", message: "This employee has no application login account." });
    expect(markFailedMock).toHaveBeenCalledWith(supabase, "org-1", "actor-1", "emp-1", "provider_error");
  });
});

describe("resendInvitation / sendAdminTriggeredPasswordReset", () => {
  it("resendInvitation succeeds by calling inviteUserByEmail again for the normalized email", async () => {
    const supabase = makeSupabase({});
    const result = await resendInvitation(supabase, "org-1", "Person@Example.Test", "https://app.example.test/manager/reset-password");
    expect(result).toEqual({ ok: true });
    expect((supabase.auth.admin.inviteUserByEmail as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("person@example.test");
  });

  it("resendInvitation surfaces a clean error rather than throwing", async () => {
    const inviteUserByEmail = vi.fn(async () => ({ data: { user: null }, error: { message: "boom" } }));
    const supabase = { auth: { admin: { inviteUserByEmail } } } as unknown as SupabaseClient;
    const result = await resendInvitation(supabase, "org-1", "person@example.test", "https://app.example.test/manager/reset-password");
    expect(result).toEqual({ ok: false, reason: "error", message: "Unable to resend the invitation. Try again." });
  });

  it("sendAdminTriggeredPasswordReset calls the same resetPasswordForEmail mechanism the public Forgot Password flow uses", async () => {
    const resetPasswordForEmail = vi.fn(async () => ({ error: null }));
    const supabase = { auth: { resetPasswordForEmail } } as unknown as SupabaseClient;

    const result = await sendAdminTriggeredPasswordReset(supabase, "org-1", "Person@Example.Test", "https://app.example.test/manager/reset-password");
    expect(result).toEqual({ ok: true });
    expect(resetPasswordForEmail).toHaveBeenCalledWith("person@example.test", { redirectTo: "https://app.example.test/manager/reset-password" });
  });

  it("sendAdminTriggeredPasswordReset surfaces a clean error rather than throwing", async () => {
    const resetPasswordForEmail = vi.fn(async () => ({ error: { message: "boom" } }));
    const supabase = { auth: { resetPasswordForEmail } } as unknown as SupabaseClient;

    const result = await sendAdminTriggeredPasswordReset(supabase, "org-1", "person@example.test", "https://app.example.test/manager/reset-password");
    expect(result).toEqual({ ok: false, reason: "error", message: "Unable to send the password reset email. Try again." });
  });
});
