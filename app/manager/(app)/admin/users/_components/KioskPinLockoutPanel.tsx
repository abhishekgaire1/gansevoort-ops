"use client";

import { useEffect, useState } from "react";
import { getOrgPinRateLimitStatusAction, unlockOrgPinRateLimitsAction } from "@/app/actions/adminUsers";
import { secondaryButtonClass, primaryButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Org-wide kiosk PIN login status + recovery (closes the operational-
 * recovery gap: once the organization-wide failed-attempt scope trips,
 * every kiosk in this organization is locked out of PIN login until that
 * window naturally expires, up to an hour). Deliberately shows only a
 * count/boolean/expiry -- never a raw IP, device identifier, or
 * rate-limit key (see getOrgPinRateLimitStatusAction's own comment).
 *
 * Unlocking restores kiosk login ATTEMPTS only -- it never changes any
 * employee's PIN, hash, or kiosk token, which the confirmation copy below
 * says explicitly so a manager can't mistake this for a PIN reset.
 */
export function KioskPinLockoutPanel() {
  const [status, setStatus] = useState<{ isLockedOut: boolean; windowExpiresAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function refresh() {
    setLoading(true);
    const result = await getOrgPinRateLimitStatusAction();
    setLoading(false);
    if (result.ok) {
      setStatus({ isLockedOut: result.status.isLockedOut, windowExpiresAt: result.status.windowExpiresAt });
    }
  }

  useEffect(() => {
    // Deliberate fetch-on-mount, same pattern as the app's other
    // section-level panels.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, []);

  async function handleUnlock() {
    if (unlocking) return; // prevents accidental double submission
    setUnlocking(true);
    const result = await unlockOrgPinRateLimitsAction();
    setUnlocking(false);
    setConfirmOpen(false);
    if (result.ok) {
      setMessage({ kind: "success", text: "Kiosk PIN attempts have been unlocked." });
      await refresh();
    } else {
      setMessage({ kind: "error", text: "message" in result ? result.message : "Unable to unlock kiosk PIN attempts." });
    }
  }

  if (loading || !status || !status.isLockedOut) {
    return null;
  }

  const expiresAt = new Date(status.windowExpiresAt);
  const expiresLabel = Number.isNaN(expiresAt.getTime()) ? "shortly" : expiresAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="mb-4 rounded-2xl border border-amber-800/60 bg-amber-950/20 p-4">
      <p className="text-sm font-semibold text-amber-300">Kiosk PIN login is currently locked out for this organization</p>
      <p className="mt-1 text-sm text-zinc-400">
        Too many failed PIN attempts were recorded. This will clear on its own by {expiresLabel}, or you can unlock it now.
      </p>
      {message && (
        <p className={`mt-2 text-sm ${message.kind === "success" ? "text-emerald-400" : "text-red-400"}`}>{message.text}</p>
      )}
      <button type="button" className={`mt-3 ${secondaryButtonClass}`} onClick={() => setConfirmOpen(true)}>
        Unlock Kiosk PIN Attempts
      </button>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby="unlock-pin-title" className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <h2 id="unlock-pin-title" className="text-sm font-semibold text-zinc-100">
              Unlock kiosk PIN attempts?
            </h2>
            <p className="mt-2 text-sm text-zinc-400">
              This restores kiosk PIN login attempts for every kiosk in this organization. It does not reset, change, or reveal any
              employee&apos;s PIN.
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button type="button" disabled={unlocking} onClick={() => setConfirmOpen(false)} className={secondaryButtonClass}>
                Cancel
              </button>
              <button type="button" disabled={unlocking} onClick={handleUnlock} className={primaryButtonClass}>
                {unlocking ? "Unlocking…" : "Unlock"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
