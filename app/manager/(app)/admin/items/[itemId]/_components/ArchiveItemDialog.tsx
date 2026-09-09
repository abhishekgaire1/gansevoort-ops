"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getAdminItemArchiveDependenciesAction, setAdminItemStatusAction } from "@/app/actions/adminItems";
import type { ArchiveDependencies } from "@/app/lib/admin/itemWorkspace";
import type { ItemStatus } from "@/app/lib/admin/items";
import { primaryButtonClass, secondaryButtonClass, destructiveButtonClass } from "@/app/components/manager/buttonStyles";
import { inlineErrorClass, inlineWarningClass } from "@/app/components/manager/surfaces";

/**
 * Archive Item (spec section 11) -- never a hard delete. Positive stock
 * is a hard blocker (existing GA050, unchanged). Active vendor mappings,
 * active usage units, and open document lines are shown as information
 * the manager must explicitly acknowledge before Archive is enabled --
 * archiving with one of those still present is an operational
 * cleanliness concern, not an inventory-safety one, so it is a soft
 * confirm, not a second hard block.
 */
export function ArchiveItemDialog({ itemId, itemName, status, onClose }: { itemId: string; itemName: string; status: ItemStatus; onClose: () => void }) {
  const router = useRouter();
  const isActive = status === "active";
  const [dependencies, setDependencies] = useState<ArchiveDependencies | null>(null);
  const [loading, setLoading] = useState(isActive);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    getAdminItemArchiveDependenciesAction(itemId).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) setDependencies(result.dependencies);
    });
    return () => {
      cancelled = true;
    };
  }, [itemId, isActive]);

  const hasSoftDependencies = dependencies && (dependencies.activeVendorMappingCount > 0 || dependencies.activeUsageUnitCount > 0 || dependencies.openDocumentLineCount > 0);
  const blocked = Boolean(dependencies?.hasPositiveStock);
  const canConfirm = !isActive || (!loading && !blocked && (!hasSoftDependencies || acknowledged));

  async function handleConfirm() {
    if (!canConfirm || pending) return;
    setPending(true);
    setError(null);
    const result = await setAdminItemStatusAction(itemId, isActive ? "inactive" : "active");
    setPending(false);
    if (!result.ok) {
      setError("message" in result ? result.message : "Unable to update status.");
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
        <h2 className="text-sm font-semibold text-zinc-100">{isActive ? `Archive ${itemName}?` : `Reactivate ${itemName}?`}</h2>

        {isActive ? (
          loading ? (
            <p className="mt-3 text-sm text-zinc-500">Checking dependencies…</p>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              {blocked ? (
                <div className={inlineErrorClass}>
                  This item cannot be archived while inventory remains in stock. Transfer it, adjust/write it off through Adjust Inventory, or cancel archiving.
                  <ul className="mt-1 list-disc pl-4">
                    {dependencies?.positiveStockLocations.map((l) => (
                      <li key={l.locationId}>
                        {l.locationName}: {l.balance}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-zinc-400">This item will no longer be available for new receiving/withdrawals. Historical records remain unchanged.</p>
              )}

              {!blocked && hasSoftDependencies ? (
                <div className={inlineWarningClass}>
                  <p className="font-semibold">This item still has:</p>
                  <ul className="mt-1 list-disc pl-4">
                    {dependencies!.activeVendorMappingCount > 0 ? <li>{dependencies!.activeVendorMappingCount} active vendor mapping(s)</li> : null}
                    {dependencies!.activeUsageUnitCount > 0 ? <li>{dependencies!.activeUsageUnitCount} active secondary usage unit</li> : null}
                    {dependencies!.openDocumentLineCount > 0 ? <li>{dependencies!.openDocumentLineCount} open document line(s)</li> : null}
                  </ul>
                  <label className="mt-2 flex items-center gap-2">
                    <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                    I reviewed these dependencies and want to archive anyway.
                  </label>
                </div>
              ) : null}
            </div>
          )
        ) : (
          <p className="mt-2 text-sm text-zinc-400">This item will become available for matching and receiving again.</p>
        )}

        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-3">
          <button type="button" disabled={pending} onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="button" disabled={pending || !canConfirm} onClick={handleConfirm} className={isActive ? destructiveButtonClass : primaryButtonClass}>
            {pending ? "Saving…" : isActive ? "Archive" : "Reactivate"}
          </button>
        </div>
      </div>
    </div>
  );
}
