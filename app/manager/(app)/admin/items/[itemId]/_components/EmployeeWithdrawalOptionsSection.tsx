"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addSecondaryUsageUnitAction, deactivateSecondaryUsageUnitAction, setPrimaryUsageUnitAction, type ItemUsageUnitSummary } from "@/app/actions/itemUsageUnits";
import { panelClass, panelHeaderClass, panelBodyClass, panelTitleClass, panelMetaClass } from "@/app/components/manager/surfaces";

/**
 * Employee Withdrawal Options (spec section 3) -- view/add/deactivate/
 * reprioritize this item's kiosk usage units, independent of any
 * purchase document. Primary is always the item's own base unit
 * (structural, never editable here). Vendor purchase packages never
 * automatically become a usage option here -- this section only ever
 * reads/writes inventory_item_usage_units, never vendor_item_purchase_
 * units. Read-only for a plain Manager (canEdit=false hides the
 * mutation controls); the underlying actions independently re-gate
 * Admin-only server-side regardless of what's rendered.
 */
export function EmployeeWithdrawalOptionsSection({
  itemId,
  units,
  usageUnits,
  canEdit,
}: {
  itemId: string;
  units: { id: string; code: string; name: string }[];
  usageUnits: ItemUsageUnitSummary[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const primary = usageUnits.find((u) => u.slot === 1) ?? null;
  const secondary = usageUnits.find((u) => u.slot === 2) ?? null;

  const [adding, setAdding] = useState(false);
  const [secondaryUnitCode, setSecondaryUnitCode] = useState("");
  const [secondaryFactor, setSecondaryFactor] = useState("");
  const [secondaryMode, setSecondaryMode] = useState<"fixed" | "measured">("fixed");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSaveSecondary = secondaryUnitCode !== "" && (secondaryMode === "measured" || (secondaryFactor.trim() !== "" && Number(secondaryFactor) > 0));

  async function handleAddSecondary() {
    if (!canSaveSecondary) return;
    setPending(true);
    setError(null);
    const result = await addSecondaryUsageUnitAction(itemId, secondaryUnitCode, secondaryMode === "measured" ? null : Number(secondaryFactor), secondaryMode === "measured");
    setPending(false);
    if (!result.ok) {
      setError("message" in result ? result.message : "Unable to add secondary usage unit.");
      return;
    }
    setAdding(false);
    setSecondaryUnitCode("");
    setSecondaryFactor("");
    setSecondaryMode("fixed");
    router.refresh();
  }

  async function handleDeactivateSecondary() {
    setPending(true);
    setError(null);
    const result = await deactivateSecondaryUsageUnitAction(itemId);
    setPending(false);
    if (!result.ok) {
      setError("message" in result ? result.message : "Unable to deactivate secondary usage unit.");
      return;
    }
    router.refresh();
  }

  async function handleMakePrimary(usageUnitId: string) {
    setPending(true);
    setError(null);
    const result = await setPrimaryUsageUnitAction(itemId, usageUnitId);
    setPending(false);
    if (!result.ok) {
      setError("message" in result ? result.message : "Unable to change the primary usage unit.");
      return;
    }
    router.refresh();
  }

  return (
    <div className={panelClass}>
      <div className={panelHeaderClass}>
        <p className={panelTitleClass}>Employee Withdrawal Options</p>
      </div>
      <div className={panelBodyClass}>
        <p className={panelMetaClass}>What employees can choose when withdrawing this item at the kiosk -- one required primary, one optional secondary.</p>

        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
            <div>
              <p className="text-sm font-medium text-zinc-200">{primary ? `${primary.unitName} (${primary.unitCode})` : "Not configured"}</p>
              <p className="text-[11px] text-zinc-500">Primary</p>
            </div>
            {primary ? <UsageUnitModeBadge requiresActualMeasurement={primary.requiresActualMeasurement} /> : null}
          </div>

          {secondary ? (
            <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
              <div>
                <p className="text-sm font-medium text-zinc-200">
                  {secondary.unitName} ({secondary.unitCode})
                </p>
                <p className="text-[11px] text-zinc-500">Secondary</p>
              </div>
              <div className="flex items-center gap-3">
                <UsageUnitModeBadge requiresActualMeasurement={secondary.requiresActualMeasurement} />
                {canEdit ? (
                  <>
                    <button type="button" disabled={pending} onClick={() => handleMakePrimary(secondary.usageUnitId)} className="text-xs font-medium text-amber-300 hover:text-amber-200 disabled:opacity-40">
                      Make Primary
                    </button>
                    <button type="button" disabled={pending} onClick={handleDeactivateSecondary} className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-40">
                      Deactivate
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : canEdit && adding ? (
            <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <select value={secondaryUnitCode} onChange={(e) => setSecondaryUnitCode(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100">
                  <option value="">Select unit…</option>
                  {units
                    .filter((u) => u.code !== primary?.unitCode)
                    .map((u) => (
                      <option key={u.id} value={u.code}>
                        {u.name} ({u.code})
                      </option>
                    ))}
                </select>
                <div className="flex rounded-lg border border-zinc-700 text-xs">
                  <button type="button" onClick={() => setSecondaryMode("fixed")} className={`rounded-l-lg px-2 py-1.5 ${secondaryMode === "fixed" ? "bg-amber-400 text-zinc-950 font-semibold" : "bg-zinc-900 text-zinc-300"}`}>
                    Fixed conversion
                  </button>
                  <button type="button" onClick={() => setSecondaryMode("measured")} className={`rounded-r-lg px-2 py-1.5 ${secondaryMode === "measured" ? "bg-amber-400 text-zinc-950 font-semibold" : "bg-zinc-900 text-zinc-300"}`}>
                    Measured at withdrawal
                  </button>
                </div>
                {secondaryMode === "fixed" ? (
                  <input type="number" placeholder="Conversion factor" value={secondaryFactor} onChange={(e) => setSecondaryFactor(e.target.value)} className="w-32 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100" />
                ) : null}
              </div>
              <div className="flex gap-3">
                <button type="button" disabled={pending || !canSaveSecondary} onClick={handleAddSecondary} className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-zinc-950 disabled:opacity-40">
                  {pending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setSecondaryMode("fixed");
                    setSecondaryUnitCode("");
                    setSecondaryFactor("");
                  }}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : canEdit ? (
            <button type="button" onClick={() => setAdding(true)} className="self-start text-xs font-medium text-amber-300 hover:text-amber-200">
              + Add secondary usage unit
            </button>
          ) : (
            <p className="text-xs text-zinc-500">No secondary usage unit configured.</p>
          )}
        </div>

        {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
      </div>
    </div>
  );
}

function UsageUnitModeBadge({ requiresActualMeasurement }: { requiresActualMeasurement: boolean }) {
  return requiresActualMeasurement ? (
    <span className="rounded-full border border-sky-800 bg-sky-950/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">Measured</span>
  ) : (
    <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Fixed</span>
  );
}
