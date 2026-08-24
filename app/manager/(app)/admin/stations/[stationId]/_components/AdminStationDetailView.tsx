"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { updateStationNameAction, setStationStatusAction } from "@/app/actions/adminStations";
import type { AdminStationSummary } from "@/app/lib/admin/stations";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { textLinkClass, primaryButtonClass, secondaryButtonClass, destructiveButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Admin -> Station detail (Admin Foundation milestone, Part 22) -- no
 * Delete button anywhere (Part 24/49), no sales/withdrawal/cost reporting
 * (Part 22's own explicit scope limit). Deactivation is blocked
 * server-side while active employees still use this station as their
 * default (Part 25) -- the exact count comes straight from the server
 * error, never recomputed client-side, so it can never drift from what
 * the RPC actually enforced.
 */
export function AdminStationDetailView({ station }: { station: AdminStationSummary }) {
  const router = useRouter();
  const [name, setName] = useState(station.name);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const [statusConfirmOpen, setStatusConfirmOpen] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const dirty = name.trim() !== station.name;
  const isActive = station.isActive;

  async function handleSave() {
    if (saving || !dirty || !name.trim()) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    const result = await updateStationNameAction(station.stationId, name);
    setSaving(false);
    if (!result.ok) {
      setSaveError("message" in result ? result.message : "Unable to save station.");
      return;
    }
    setSaveSuccess("Station updated.");
    router.refresh();
  }

  async function handleConfirmStatusChange() {
    if (statusSaving) return;
    setStatusSaving(true);
    setStatusError(null);
    const result = await setStationStatusAction(station.stationId, !isActive);
    setStatusSaving(false);
    if (!result.ok) {
      setStatusError("message" in result ? result.message : "Unable to update station.");
      return;
    }
    setStatusConfirmOpen(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/manager/admin/stations" className={textLinkClass}>
        ← Stations
      </Link>

      <div>
        <h1 className="mt-1 text-xl font-semibold text-zinc-100">{station.name}</h1>
        <div className="mt-1">
          <StatusBadge label={isActive ? "Active" : "Inactive"} tone={isActive ? "success" : "neutral"} />
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Station Information</p>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50" />
          </label>
          <Row label="Default Station For" value={`${station.defaultEmployeeCount} active employee${station.defaultEmployeeCount === 1 ? "" : "s"}`} />
        </div>

        {saveError ? <p className="mt-3 text-sm text-red-400">{saveError}</p> : null}
        {saveSuccess ? <p className="mt-3 text-sm text-emerald-400">{saveSuccess}</p> : null}

        <button type="button" disabled={saving || !dirty || !name.trim()} onClick={handleSave} className={`mt-4 ${primaryButtonClass}`}>
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>

      <div className="flex flex-col items-start gap-2">
        <button type="button" onClick={() => setStatusConfirmOpen(true)} className={isActive ? destructiveButtonClass : primaryButtonClass}>
          {isActive ? "Deactivate Station" : "Reactivate Station"}
        </button>
        {statusError ? <p className="max-w-md text-sm text-red-400">{statusError}</p> : null}
      </div>

      {statusConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby="station-confirm-title" className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <h2 id="station-confirm-title" className="text-sm font-semibold text-zinc-100">
              {isActive ? `Deactivate ${station.name}?` : `Reactivate ${station.name}?`}
            </h2>
            <p className="mt-2 text-sm text-zinc-400">
              {isActive
                ? "This station will no longer be available for new withdrawals. Historical activity will remain unchanged."
                : "This station will become available for new withdrawals again."}
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button type="button" disabled={statusSaving} onClick={() => setStatusConfirmOpen(false)} className={secondaryButtonClass}>
                Cancel
              </button>
              <button type="button" disabled={statusSaving} onClick={handleConfirmStatusChange} className={isActive ? destructiveButtonClass : primaryButtonClass}>
                {statusSaving ? "Saving…" : isActive ? "Deactivate" : "Reactivate"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
