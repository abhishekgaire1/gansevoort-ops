"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createEmployeeAction, inviteManagerOrAdminAction } from "@/app/actions/adminUsers";
import type { PrimaryRole } from "@/app/lib/admin/users";
import type { KioskStation } from "@/app/lib/kiosk/stations";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Admin -> Users "+ Add User" (Identity + Access Management milestone,
 * Part 9/33/34) -- branches by Role. Employee creates an operational
 * record with an optional kiosk PIN, exactly as before. Manager/Admin
 * creates the SAME operational employee record first (name only, no
 * PIN), then invites a Supabase Auth account via the same two-step,
 * safely-resumable path a promotion uses (Part 22/48) -- never a single
 * fake cross-system transaction. The Admin never invents a password for
 * the invitee; they set their own via the emailed link.
 *
 * PROVISIONING-RESUMABILITY FIX: a real first-use bug had a failed
 * invite (Supabase email rate limit) silently leave the new person as a
 * bare "Employee / No access configured," discarding the chosen Manager
 * role. inviteManagerOrAdminAction now always preserves the employee,
 * intended role, and email even when the invite fails (see
 * invitations.ts) -- on a rate_limited/provider_error result this modal
 * shows the SAVED confirmation below instead of a blocking form error;
 * the Admin retries from the Users list/detail page, never by
 * resubmitting this form (which would otherwise risk creating a second
 * employee if it re-ran createEmployeeAction).
 */
export function AddUserButton({ stations }: { stations: KioskStation[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<PrimaryRole>("employee");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [defaultStationId, setDefaultStationId] = useState("");
  const [grantKioskAccess, setGrantKioskAccess] = useState(true);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [pendingLabel, setPendingLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [setupIncompleteMessage, setSetupIncompleteMessage] = useState<string | null>(null);
  // Set once createEmployeeAction succeeds for the Manager/Admin path, so a
  // retry after a failed invite step (Part 49/50: never a single fake
  // cross-system transaction) resumes with the SAME employee instead of
  // creating a second, duplicate person.
  const [pendingEmployeeId, setPendingEmployeeId] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  // Synchronous double-submit guard: React state (`pending`) only takes
  // effect on the NEXT render, so two rapid clicks handled before that
  // render commits would both read pending===false and both proceed. A
  // ref updates immediately, closing that window (Part 4/29).
  const submittingRef = useRef(false);

  function reset() {
    setRole("employee");
    setFirstName("");
    setLastName("");
    setDefaultStationId("");
    setGrantKioskAccess(true);
    setPin("");
    setConfirmPin("");
    setEmail("");
    setError(null);
    setSetupIncompleteMessage(null);
    setPendingEmployeeId(null);
  }

  function closeAndRefresh() {
    setOpen(false);
    reset();
    router.refresh();
  }

  async function handleSubmit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      if (!firstName.trim() || !lastName.trim()) {
        setError("Name is required.");
        return;
      }

      if (role === "employee") {
        if (grantKioskAccess && !/^\d{4}$/.test(pin)) {
          setError("Enter a 4-digit PIN.");
          return;
        }
        if (grantKioskAccess && pin !== confirmPin) {
          setError("PIN and confirmation do not match.");
          return;
        }

        setPending(true);
        setPendingLabel("Creating account…");
        setError(null);
        const result = await createEmployeeAction({
          firstName,
          lastName,
          defaultStationId: defaultStationId || null,
          grantKioskAccess,
          pin: grantKioskAccess ? pin : null,
        });
        setPending(false);

        if (!result.ok) {
          setError(result.message);
          return;
        }

        closeAndRefresh();
        return;
      }

      if (!email.trim()) {
        setError("Email is required.");
        return;
      }

      setPending(true);
      setError(null);

      let employeeId = pendingEmployeeId;
      if (!employeeId) {
        setPendingLabel("Creating account…");
        const createResult = await createEmployeeAction({
          firstName,
          lastName,
          defaultStationId: defaultStationId || null,
          grantKioskAccess: false,
          pin: null,
        });
        if (!createResult.ok) {
          setPending(false);
          setError(createResult.message);
          return;
        }
        employeeId = createResult.employeeId;
        setPendingEmployeeId(employeeId);
      }

      setPendingLabel("Sending invitation…");
      const inviteResult = await inviteManagerOrAdminAction(employeeId, email.trim(), role);
      setPending(false);

      if (!inviteResult.ok) {
        if (inviteResult.reason === "rate_limited" || inviteResult.reason === "provider_error") {
          // Employee + intended role + email are already saved server-side
          // (start_manager_admin_provisioning ran before the Auth call) --
          // this is NOT a form error to fix and resubmit, so show the
          // saved-state confirmation instead of leaving the form open.
          setSetupIncompleteMessage(inviteResult.message);
          return;
        }
        setError(inviteResult.message);
        return;
      }

      closeAndRefresh();
    } finally {
      submittingRef.current = false;
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonClass}>
        + Add User
      </button>

      {open && setupIncompleteMessage ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">Invitation Couldn&rsquo;t Be Sent</h2>
            <p className="mt-2 text-sm text-zinc-300">{setupIncompleteMessage}</p>
            <p className="mt-2 text-xs text-zinc-500">
              {firstName} {lastName}&rsquo;s {role === "admin" ? "Admin" : "Manager"} setup has been saved. Retry the invitation from their user detail page.
            </p>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={closeAndRefresh} className={primaryButtonClass}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <div className="flex items-start justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Add User</h2>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                aria-label="Close"
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-3">
              <div className="flex gap-4 text-sm text-zinc-300">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={role === "employee"} onChange={() => setRole("employee")} />
                  Employee
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={role === "manager"} onChange={() => setRole("manager")} />
                  Manager
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={role === "admin"} onChange={() => setRole("admin")} />
                  Admin
                </label>
              </div>
              <p className="text-xs text-zinc-500">
                {role === "employee"
                  ? "Creates an operational employee record with kiosk PIN access."
                  : "Creates an employee record and sends an invitation email for the person to set their own password."}
              </p>

              <div className="flex gap-3">
                <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
                  First Name
                  <input
                    ref={firstFieldRef}
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
                  />
                </label>
                <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
                  Last Name
                  <input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
                  />
                </label>
              </div>

              {role === "employee" ? (
                <>
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

                  <label className="flex items-center gap-2 text-sm text-zinc-300">
                    <input type="checkbox" checked={grantKioskAccess} onChange={(e) => setGrantKioskAccess(e.target.checked)} className="h-4 w-4" />
                    Enable kiosk access (PIN)
                  </label>

                  {grantKioskAccess ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-zinc-500">Enter a 4-digit PIN.</p>
                      <div className="flex gap-3">
                        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
                          New PIN
                          <input
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            maxLength={4}
                            value={pin}
                            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
                          />
                        </label>
                        <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
                          Confirm PIN
                          <input
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            maxLength={4}
                            value={confirmPin}
                            onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
                          />
                        </label>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <label className="flex flex-col gap-1 text-xs text-zinc-400">
                    Email
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
                    />
                  </label>
                  {role === "admin" ? (
                    <p className="text-xs text-amber-400">Admins can manage: users, roles, kiosk access, stations, and organization configuration.</p>
                  ) : null}
                </>
              )}
            </div>

            {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                className={secondaryButtonClass}
              >
                Cancel
              </button>
              <button type="button" disabled={pending} onClick={handleSubmit} className={primaryButtonClass}>
                {pending ? pendingLabel : role === "employee" ? "Add Employee" : "Add & Send Invitation"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
