"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setAdminItemBaseUnitAction } from "@/app/actions/adminItems";
import type { AdminItemDetail } from "@/app/lib/admin/items";
import { panelClass, panelHeaderClass, panelBodyClass, panelTitleClass, panelMetaClass, selectClass } from "@/app/components/manager/surfaces";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Inventory Settings (spec section 3) -- base unit (structural, blocked
 * once movement history exists -- base-unit conversion/replacement is a
 * separate, deferred subsystem, not built this pass) and the existing
 * default receiving location, shown read-only here (no standalone
 * manager-facing action exists yet to change it outside the receiving
 * flow it's normally set from -- not inventing a new editable control
 * for a setting this pass doesn't otherwise touch).
 */
export function InventorySettingsSection({ item, units, canEditBaseUnit }: { item: AdminItemDetail; units: { id: string; code: string; name: string }[]; canEditBaseUnit: boolean }) {
  const router = useRouter();
  const [baseUnitId, setBaseUnitId] = useState(item.baseUnitId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const dirty = baseUnitId !== (item.baseUnitId ?? "");

  async function handleSave() {
    if (!dirty || pending) return;
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await setAdminItemBaseUnitAction(item.itemId, baseUnitId);
    setPending(false);
    if (!result.ok) {
      setError("message" in result ? result.message : "Unable to change base unit.");
      return;
    }
    setSuccess("Base unit updated.");
    router.refresh();
  }

  return (
    <div className={panelClass}>
      <div className={panelHeaderClass}>
        <p className={panelTitleClass}>Inventory Settings</p>
      </div>
      <div className={panelBodyClass}>
        <p className={panelMetaClass}>Base unit</p>
        {item.hasMovementHistory ? (
          <p className="mt-1 text-sm text-zinc-400">
            This item has inventory history, so its base unit cannot be changed directly. Changing it in place would alter the meaning of previous receipts, withdrawals, and balances. Current
            unit: <span className="font-medium text-zinc-200">{item.baseUnitCode}</span>.
          </p>
        ) : canEditBaseUnit ? (
          <div className="mt-2 flex items-center gap-3">
            <select value={baseUnitId} onChange={(e) => setBaseUnitId(e.target.value)} className={`${selectClass} w-48`}>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} — {u.name}
                </option>
              ))}
            </select>
            <button type="button" disabled={pending || !dirty} onClick={handleSave} className={secondaryButtonClass}>
              {pending ? "Saving…" : "Change Unit"}
            </button>
          </div>
        ) : (
          <p className="mt-1 text-sm text-zinc-200">{item.baseUnitCode}</p>
        )}
        {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
        {success ? <p className="mt-2 text-sm text-emerald-400">{success}</p> : null}

        <div className="mt-4 border-t border-zinc-800 pt-3">
          <p className={panelMetaClass}>Default receiving location</p>
          <p className="mt-1 text-sm text-zinc-200">{item.defaultReceivingLocationName ?? "Not set"}</p>
        </div>
      </div>
    </div>
  );
}
