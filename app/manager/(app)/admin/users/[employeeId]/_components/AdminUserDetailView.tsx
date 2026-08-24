"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  updateEmployeeNameAction,
  setEmployeeDefaultStationAction,
  setEmployeeStatusAction,
  setUserRoleAction,
  resetEmployeeKioskPinAction,
  inviteManagerOrAdminAction,
  resendInvitationAction,
  sendPasswordResetAction,
} from "@/app/actions/adminUsers";
import type { AdminUserSummary, PrimaryRole } from "@/app/lib/admin/users";
import type { AuthAccountInfo } from "@/app/lib/admin/authAccounts";
import type { KioskStation } from "@/app/lib/kiosk/stations";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { textLinkClass, primaryButtonClass, secondaryButtonClass, destructiveButtonClass } from "@/app/components/manager/buttonStyles";

const ROLE_LABEL: Record<PrimaryRole, string> = { employee: "Employee", manager: "Manager", admin: "Admin" };

/**
 * Admin -> User detail (Identity + Access Management milestone, Part 2/35)
 * -- the information architecture branches by what the user ACTUALLY has,
 * never by a fixed role template: Kiosk Access only renders when the
 * person is kiosk-eligible (no application account) or already holds a
 * PIN (a promoted employee who kept it, Part 30); Application Access only
 * renders when an auth account genuinely exists. Never both empty, never
 * a section implying a capability nothing backs.
 */
export function AdminUserDetailView({
  user,
  stations,
  isSelf,
  authAccount,
}: {
  user: AdminUserSummary;
  stations: KioskStation[];
  isSelf: boolean;
  authAccount: AuthAccountInfo | null;
}) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);
  const [defaultStationId, setDefaultStationId] = useState(user.defaultStationId ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const [roleDraft, setRoleDraft] = useState<PrimaryRole>(user.primaryRole);
  const [roleConfirmOpen, setRoleConfirmOpen] = useState(false);
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  const [statusConfirmOpen, setStatusConfirmOpen] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusErrorCode, setStatusErrorCode] = useState<string | null>(null);

  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinResetSuccess, setPinResetSuccess] = useState(false);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteRole, setInviteRole] = useState<"manager" | "admin">("manager");
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePending, setInvitePending] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState(false);

  const [resendPending, setResendPending] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Synchronous double-submit guards -- React state only takes effect on
  // the next render, so two rapid clicks handled before that render
  // commits could both read the pending flag as false and both proceed.
  // A ref updates immediately, closing that window for every privileged
  // Auth-triggering action on this page (Part 4/29).
  const inviteSubmittingRef = useRef(false);
  const retrySubmittingRef = useRef(false);
  const resendSubmittingRef = useRef(false);
  const resetSubmittingRef = useRef(false);

  const dirty = firstName !== user.firstName || lastName !== user.lastName || (defaultStationId || null) !== user.defaultStationId;
  const isActive = user.employeeStatus === "active";
  const setupIncomplete = user.provisioningStatus === "invite_failed" || user.provisioningStatus === "invite_pending";
  // Kiosk Access only when genuinely kiosk-eligible (no Manager/Admin
  // provisioning ever started for this person) or they already hold a
  // PIN (a promoted employee who kept it, Part 30) -- an incomplete
  // Manager/Admin (provisioningStatus !== 'none', no PIN) must never show
  // a Kiosk Access section it has no PIN to back (Part 12).
  const showKioskSection = user.hasPin || (!user.hasAuthAccount && user.provisioningStatus === "none");
  const showAppAccessSection = user.hasAuthAccount || setupIncomplete;

  async function handleRetryInvitation() {
    if (retrySubmittingRef.current || !user.pendingEmail || !user.intendedRole) return;
    retrySubmittingRef.current = true;
    setRetryPending(true);
    setRetryError(null);
    try {
      const result = await inviteManagerOrAdminAction(user.employeeId, user.pendingEmail, user.intendedRole as "manager" | "admin");
      setRetryPending(false);
      if (!result.ok) {
        setRetryError(result.message);
        return;
      }
      router.refresh();
    } finally {
      retrySubmittingRef.current = false;
    }
  }

  async function handleSave() {
    if (saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    if (firstName !== user.firstName || lastName !== user.lastName) {
      const result = await updateEmployeeNameAction(user.employeeId, firstName, lastName);
      if (!result.ok) {
        setSaving(false);
        setSaveError("message" in result ? result.message : "Unable to save user.");
        return;
      }
    }

    if ((defaultStationId || null) !== user.defaultStationId) {
      const result = await setEmployeeDefaultStationAction(user.employeeId, defaultStationId || null);
      if (!result.ok) {
        setSaving(false);
        setSaveError("message" in result ? result.message : "Unable to save user.");
        return;
      }
    }

    setSaving(false);
    setSaveSuccess(`${firstName} ${lastName} updated.`);
    router.refresh();
  }

  async function handleConfirmRoleChange() {
    if (roleSaving) return;
    setRoleSaving(true);
    setRoleError(null);
    const result = await setUserRoleAction(user.appUserId!, roleDraft);
    setRoleSaving(false);
    if (!result.ok) {
      setRoleError("message" in result ? result.message : "Unable to change role.");
      return;
    }
    setRoleConfirmOpen(false);
    router.refresh();
  }

  async function handleConfirmStatusChange() {
    if (statusSaving) return;
    setStatusSaving(true);
    setStatusError(null);
    setStatusErrorCode(null);
    const nextStatus = isActive ? "inactive" : "active";
    const result = await setEmployeeStatusAction(user.employeeId, nextStatus);
    setStatusSaving(false);
    if (!result.ok) {
      setStatusError("message" in result ? result.message : "Unable to update status.");
      setStatusErrorCode("code" in result ? result.code : null);
      return;
    }
    setStatusConfirmOpen(false);
    router.refresh();
  }

  async function handleInviteSubmit() {
    if (inviteSubmittingRef.current) return;
    if (!inviteEmail.trim()) {
      setInviteError("Email is required.");
      return;
    }
    inviteSubmittingRef.current = true;
    setInvitePending(true);
    setInviteError(null);
    try {
      const result = await inviteManagerOrAdminAction(user.employeeId, inviteEmail.trim(), inviteRole);
      setInvitePending(false);
      if (!result.ok) {
        setInviteError("message" in result ? result.message : "Unable to send invitation.");
        return;
      }
      setInviteSuccess(true);
      router.refresh();
    } finally {
      inviteSubmittingRef.current = false;
    }
  }

  async function handleResend() {
    if (resendSubmittingRef.current || !authAccount?.email) return;
    resendSubmittingRef.current = true;
    setResendPending(true);
    setResendMessage(null);
    try {
      const result = await resendInvitationAction(authAccount.email);
      setResendPending(false);
      setResendMessage(result.ok ? "Invitation resent." : result.message);
    } finally {
      resendSubmittingRef.current = false;
    }
  }

  async function handleSendReset() {
    if (resetSubmittingRef.current || !authAccount?.email) return;
    resetSubmittingRef.current = true;
    setResetPending(true);
    setResetMessage(null);
    try {
      const result = await sendPasswordResetAction(authAccount.email);
      setResetPending(false);
      setResetConfirmOpen(false);
      setResetMessage(result.ok ? "Password reset email sent." : result.message);
    } finally {
      resetSubmittingRef.current = false;
    }
  }

  const canChangeRole = Boolean(user.appUserId) && user.hasAuthAccount && !isSelf;
  // A fresh "Invite to Manager / Admin" prompt only makes sense when no
  // provisioning attempt exists yet -- once one has started, the person
  // either already has an account (canChangeRole above) or is showing
  // "Setup Incomplete" with its own Retry Invitation button, which reuses
  // the SAME stored role/email rather than asking the Admin to re-enter
  // them here.
  const canInvite = !user.hasAuthAccount && !setupIncomplete && !isSelf;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/manager/admin/users" className={textLinkClass}>
        ← Users
      </Link>

      <div>
        <h1 className="mt-1 text-xl font-semibold text-zinc-100">
          {user.firstName} {user.lastName}
        </h1>
        <div className="mt-1 flex items-center gap-2">
          <StatusBadge label={isActive ? "Active" : "Inactive"} tone={isActive ? "success" : "neutral"} />
          <span className="text-xs uppercase tracking-wide text-zinc-500">{ROLE_LABEL[user.displayRole]}</span>
          {setupIncomplete ? <StatusBadge label="Setup Incomplete" tone="warning" /> : null}
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Basic Information</p>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
              First Name
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50" />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
              Last Name
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50" />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Default Station
            <select
              value={defaultStationId}
              onChange={(e) => setDefaultStationId(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
            >
              <option value="">None</option>
              {stations.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {saveError ? <p className="mt-3 text-sm text-red-400">{saveError}</p> : null}
        {saveSuccess ? <p className="mt-3 text-sm text-emerald-400">{saveSuccess}</p> : null}

        <button type="button" disabled={saving || !dirty} onClick={handleSave} className={`mt-4 ${primaryButtonClass}`}>
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>

      {showKioskSection ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Kiosk Access</p>
          <div className="mt-3 flex flex-col gap-2">
            <Row label="Status" value={user.appUserId ? (user.isAppUserActive ? "Enabled" : "Disabled") : "Not enabled"} />
            <Row label="PIN" value={user.hasPin ? "Configured" : "Not configured"} />
          </div>
          <button type="button" onClick={() => setPinModalOpen(true)} className={`mt-3 ${secondaryButtonClass}`}>
            {user.hasPin ? "Reset Kiosk PIN" : "Set Kiosk PIN"}
          </button>
        </div>
      ) : null}

      {showAppAccessSection && user.hasAuthAccount ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Application Access</p>
          <div className="mt-3 flex flex-col gap-2">
            <Row label="Email" value={authAccount?.email ?? "Unavailable"} />
            <Row label="Status" value={authAccount?.status === "invited" ? "Invited" : "Active"} />
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" disabled={resetPending || !authAccount?.email} onClick={() => setResetConfirmOpen(true)} className={secondaryButtonClass}>
              {resetPending ? "Sending…" : "Send Password Reset"}
            </button>
            {authAccount?.status === "invited" ? (
              <button type="button" disabled={resendPending || !authAccount?.email} onClick={handleResend} className={secondaryButtonClass}>
                {resendPending ? "Resending…" : "Resend Invitation"}
              </button>
            ) : null}
          </div>
          {resetMessage ? <p className="mt-2 text-sm text-zinc-400">{resetMessage}</p> : null}
          {resendMessage ? <p className="mt-2 text-sm text-zinc-400">{resendMessage}</p> : null}
          {user.primaryRole === "admin" ? <p className="mt-3 text-xs text-zinc-600">Admin Permissions: Enabled</p> : null}
        </div>
      ) : showAppAccessSection ? (
        <div className="rounded-2xl border border-amber-900/60 bg-zinc-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Application Access</p>
          <div className="mt-3 flex flex-col gap-2">
            <Row label="Email" value={user.pendingEmail ?? "Unavailable"} />
            <Row label="Invitation" value={user.provisioningStatus === "invite_pending" ? "Sending…" : "Failed"} />
          </div>
          {user.provisioningStatus === "invite_failed" ? (
            <>
              <p className="mt-3 text-sm text-zinc-400">The invitation could not be sent.</p>
              {retryError ? <p className="mt-2 text-sm text-red-400">{retryError}</p> : null}
              <button type="button" disabled={retryPending} onClick={handleRetryInvitation} className={`mt-3 ${primaryButtonClass}`}>
                {retryPending ? "Retrying…" : "Retry Invitation"}
              </button>
            </>
          ) : (
            <p className="mt-3 text-sm text-zinc-400">Sending the invitation…</p>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Account</p>
          <div className="mt-3">
            <Row label="Application Login" value="None" />
          </div>
        </div>
      )}

      {canChangeRole ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Role</p>
          <div className="mt-3 flex items-center gap-3">
            <select value={roleDraft} onChange={(e) => setRoleDraft(e.target.value as PrimaryRole)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50">
              <option value="employee">Employee</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="button"
              disabled={roleDraft === user.primaryRole}
              onClick={() => setRoleConfirmOpen(true)}
              className={secondaryButtonClass}
            >
              Change Role
            </button>
          </div>
          {roleError ? <p className="mt-2 text-sm text-red-400">{roleError}</p> : null}
        </div>
      ) : canInvite ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Application Access</p>
          {inviteSuccess ? (
            <p className="mt-3 text-sm text-emerald-400">Invitation sent to {inviteEmail.trim()}.</p>
          ) : inviteOpen ? (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex gap-4 text-sm text-zinc-300">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={inviteRole === "manager"} onChange={() => setInviteRole("manager")} />
                  Manager
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={inviteRole === "admin"} onChange={() => setInviteRole("admin")} />
                  Admin
                </label>
              </div>
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                Email
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
                />
              </label>
              {inviteRole === "admin" ? (
                <p className="text-xs text-amber-400">Admins can manage: users, roles, kiosk access, stations, and organization configuration.</p>
              ) : null}
              {inviteError ? <p className="text-sm text-red-400">{inviteError}</p> : null}
              <div className="flex gap-3">
                <button type="button" disabled={invitePending} onClick={() => setInviteOpen(false)} className={secondaryButtonClass}>
                  Cancel
                </button>
                <button type="button" disabled={invitePending} onClick={handleInviteSubmit} className={primaryButtonClass}>
                  {invitePending ? "Sending…" : "Add & Send Invitation"}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setInviteOpen(true)} className={`mt-3 ${secondaryButtonClass}`}>
              Invite to Manager / Admin
            </button>
          )}
        </div>
      ) : isSelf ? (
        <p className="text-xs text-zinc-600">You cannot change your own role.</p>
      ) : null}

      <div className="flex flex-col items-start gap-2">
        {isSelf ? (
          <p className="text-xs text-zinc-600">You cannot deactivate your own account.</p>
        ) : (
          <button type="button" onClick={() => setStatusConfirmOpen(true)} className={isActive ? destructiveButtonClass : primaryButtonClass}>
            {isActive ? "Deactivate User" : "Reactivate User"}
          </button>
        )}
        {statusError ? (
          <div>
            <p className="text-sm text-red-400">{statusError}</p>
            {statusErrorCode === "PIN_CONFLICTS_ON_REACTIVATION" ? (
              <button type="button" onClick={() => setPinModalOpen(true)} className={`mt-2 ${secondaryButtonClass}`}>
                Reset PIN
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {roleConfirmOpen ? (
        <ConfirmModal
          title={`Make ${user.firstName} ${user.lastName} ${ROLE_LABEL[roleDraft]}?`}
          body={
            roleDraft === "admin"
              ? "Admins can manage users, stations, and other organization configuration."
              : `${user.firstName} will have ${ROLE_LABEL[roleDraft].toLowerCase()} access.`
          }
          confirmLabel={roleSaving ? "Saving…" : `Make ${ROLE_LABEL[roleDraft]}`}
          onCancel={() => {
            setRoleConfirmOpen(false);
            setRoleDraft(user.primaryRole);
          }}
          onConfirm={handleConfirmRoleChange}
          disabled={roleSaving}
        />
      ) : null}

      {statusConfirmOpen ? (
        <ConfirmModal
          title={isActive ? `Deactivate ${user.firstName} ${user.lastName}?` : `Reactivate ${user.firstName} ${user.lastName}?`}
          body={
            isActive
              ? `${user.firstName} will no longer be available for new operational activity. Historical records will remain unchanged.`
              : `${user.firstName} will become available for operational activity again.`
          }
          confirmLabel={statusSaving ? "Saving…" : isActive ? "Deactivate" : "Reactivate"}
          destructive={isActive}
          onCancel={() => setStatusConfirmOpen(false)}
          onConfirm={handleConfirmStatusChange}
          disabled={statusSaving}
        />
      ) : null}

      {resetConfirmOpen && authAccount?.email ? (
        <ConfirmModal
          title="Send Password Reset?"
          body={`A password-reset email will be sent to: ${authAccount.email}`}
          confirmLabel={resetPending ? "Sending…" : "Send Reset Email"}
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={handleSendReset}
          disabled={resetPending}
        />
      ) : null}

      {pinModalOpen ? (
        <ResetPinModal
          employeeId={user.employeeId}
          firstName={user.firstName}
          lastName={user.lastName}
          hasPin={user.hasPin}
          success={pinResetSuccess}
          onClose={() => {
            setPinModalOpen(false);
            setPinResetSuccess(false);
            setStatusError(null);
            setStatusErrorCode(null);
            router.refresh();
          }}
          onSuccess={() => setPinResetSuccess(true)}
        />
      ) : null}
    </div>
  );
}

function ResetPinModal({
  employeeId,
  firstName,
  lastName,
  hasPin,
  success,
  onClose,
  onSuccess,
}: {
  employeeId: string;
  firstName: string;
  lastName: string;
  hasPin: boolean;
  success: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (pending) return;
    if (pin !== confirmPin) {
      setError("PIN and confirmation do not match.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await resetEmployeeKioskPinAction(employeeId, pin, confirmPin);
    setPending(false);
    if (!result.ok) {
      setError("message" in result ? result.message : "Unable to reset PIN.");
      return;
    }
    onSuccess();
  }

  if (success) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-400">PIN Reset</h2>
          <p className="mt-2 text-sm text-zinc-300">
            {firstName} {lastName}&rsquo;s kiosk PIN has been updated. The previous PIN no longer works.
          </p>
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={onClose} className={primaryButtonClass}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">{hasPin ? "Reset Kiosk PIN" : "Set Kiosk PIN"}</h2>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            New PIN
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Confirm New PIN
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
            />
          </label>
        </div>
        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-3">
          <button type="button" disabled={pending} onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="button" disabled={pending} onClick={handleSubmit} className={primaryButtonClass}>
            {pending ? "Saving…" : hasPin ? "Reset PIN" : "Set PIN"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-800 py-2 last:border-0">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="text-sm font-medium text-zinc-100">{value}</span>
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  destructive,
  disabled,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby="admin-confirm-title" className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
        <h2 id="admin-confirm-title" className="text-sm font-semibold text-zinc-100">
          {title}
        </h2>
        <p className="mt-2 text-sm text-zinc-400">{body}</p>
        <div className="mt-4 flex justify-end gap-3">
          <button type="button" disabled={disabled} onClick={onCancel} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="button" disabled={disabled} onClick={onConfirm} className={destructive ? destructiveButtonClass : primaryButtonClass}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
