"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createStationAction } from "@/app/actions/adminStations";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Admin -> Stations "+ Add Station" (Admin Foundation milestone, Part
 * 21). If an INACTIVE station already has this name, the server
 * deliberately does not silently reactivate or create a duplicate (Part
 * 28) -- it returns the existing station's id so this can prompt the
 * Admin to go reactivate it explicitly instead.
 */
export function AddStationButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingInactiveStationId, setExistingInactiveStationId] = useState<string | null>(null);

  function reset() {
    setName("");
    setError(null);
    setExistingInactiveStationId(null);
  }

  async function handleSubmit() {
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    setExistingInactiveStationId(null);

    const result = await createStationAction(name);
    setPending(false);

    if (!result.ok) {
      if ("code" in result && result.code === "DUPLICATE_INACTIVE_STATION_NAME" && result.detail) {
        try {
          const parsed = JSON.parse(result.detail) as { existingStationId?: string };
          if (parsed.existingStationId) setExistingInactiveStationId(parsed.existingStationId);
        } catch {
          // fall through to the plain error message below
        }
      }
      setError(result.message);
      return;
    }

    setOpen(false);
    reset();
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonClass}>
        + Add Station
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <div className="flex items-start justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Add Station</h2>
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

            <label className="mt-4 flex flex-col gap-1 text-xs text-zinc-400">
              Station Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Coffee Bar"
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
              />
            </label>
            <p className="mt-2 text-xs text-zinc-500">Status: Active</p>

            {error ? (
              <div className="mt-3 text-sm text-red-400">
                <p>{error}</p>
                {existingInactiveStationId ? (
                  <Link href={`/manager/admin/stations/${existingInactiveStationId}`} className="mt-1 inline-block font-medium text-amber-400 hover:underline">
                    View that station →
                  </Link>
                ) : null}
              </div>
            ) : null}

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
              <button type="button" disabled={pending || !name.trim()} onClick={handleSubmit} className={primaryButtonClass}>
                {pending ? "Adding…" : "Add Station"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
