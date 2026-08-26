"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { updateAdminItemDetailsAction, setAdminItemBaseUnitAction, setAdminItemStatusAction } from "@/app/actions/adminItems";
import { addSecondaryUsageUnitAction, deactivateSecondaryUsageUnitAction, setPrimaryUsageUnitAction, type ItemUsageUnitSummary } from "@/app/actions/itemUsageUnits";
import type { AdminItemDetail, ItemStatus } from "@/app/lib/admin/items";
import type { VendorMappingSummary } from "@/app/actions/adminItems";
import type { CategorySummary } from "@/app/actions/itemMaster";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { textLinkClass, primaryButtonClass, secondaryButtonClass, destructiveButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Admin -> Item Master detail (Part 45-49/69) -- Canonical Name and
 * Category are always safely editable; Base Unit is guarded (Part 45)
 * and disabled outright once this item has any inventory movement
 * history, since changing it could corrupt historical quantities.
 * Deactivation is guarded too (Part 47) -- blocked while positive stock
 * remains anywhere, server-enforced regardless of what this page shows.
 */
export function AdminItemDetailView({
  item,
  categories,
  units,
  mappings,
  usageUnits,
}: {
  item: AdminItemDetail;
  categories: CategorySummary[];
  units: { id: string; code: string; name: string }[];
  mappings: VendorMappingSummary[];
  usageUnits: ItemUsageUnitSummary[];
}) {
  const router = useRouter();
  const [name, setName] = useState(item.name);
  const [categoryId, setCategoryId] = useState(item.categoryId ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<{ existingItemId: string; existingItemName: string } | null>(null);

  const [baseUnitId, setBaseUnitId] = useState(item.baseUnitId ?? "");
  const [unitSaving, setUnitSaving] = useState(false);
  const [unitError, setUnitError] = useState<string | null>(null);
  const [unitSuccess, setUnitSuccess] = useState<string | null>(null);

  const [statusConfirmOpen, setStatusConfirmOpen] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const isActive = item.status === "active";
  const dirty = name !== item.name || categoryId !== (item.categoryId ?? "");
  const unitDirty = baseUnitId !== (item.baseUnitId ?? "");

  async function handleSave() {
    if (saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    setDuplicateOf(null);

    const result = await updateAdminItemDetailsAction(item.itemId, name, categoryId);
    setSaving(false);
    if (!result.ok) {
      if ("existingItemId" in result && result.existingItemId && result.existingItemName) {
        setDuplicateOf({ existingItemId: result.existingItemId, existingItemName: result.existingItemName });
        return;
      }
      setSaveError("message" in result ? result.message : "Unable to save item.");
      return;
    }

    setSaveSuccess("Item updated.");
    router.refresh();
  }

  async function handleSaveBaseUnit() {
    if (unitSaving || !unitDirty) return;
    setUnitSaving(true);
    setUnitError(null);
    setUnitSuccess(null);
    const result = await setAdminItemBaseUnitAction(item.itemId, baseUnitId);
    setUnitSaving(false);
    if (!result.ok) {
      setUnitError("message" in result ? result.message : "Unable to change base unit.");
      return;
    }
    setUnitSuccess("Base unit updated.");
    router.refresh();
  }

  async function handleConfirmStatusChange() {
    if (statusSaving) return;
    setStatusSaving(true);
    setStatusError(null);
    const nextStatus: ItemStatus = isActive ? "inactive" : "active";
    const result = await setAdminItemStatusAction(item.itemId, nextStatus);
    setStatusSaving(false);
    if (!result.ok) {
      setStatusError("message" in result ? result.message : "Unable to update status.");
      return;
    }
    setStatusConfirmOpen(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/manager/admin/items" className={textLinkClass}>
        ← Item Master
      </Link>

      <div>
        <p className="mt-1 font-mono text-xs text-zinc-500">{item.itemNumber}</p>
        <h1 className="text-xl font-semibold text-zinc-100">{item.name}</h1>
        <div className="mt-1">
          <StatusBadge label={isActive ? "Active" : "Inactive"} tone={isActive ? "success" : "neutral"} />
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Inventory Details</p>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Canonical Name
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDuplicateOf(null);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50">
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Item Number
            <input value={item.itemNumber} disabled className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-500" />
          </label>
        </div>

        {duplicateOf ? (
          <div className="mt-3 rounded-xl border border-amber-900/60 bg-amber-950/20 p-3">
            <p className="text-sm text-amber-300">
              An active item named &ldquo;{duplicateOf.existingItemName}&rdquo; already exists.{" "}
              <a href={`/manager/admin/items/${duplicateOf.existingItemId}`} className="underline">
                View it
              </a>
              .
            </p>
          </div>
        ) : null}
        {saveError ? <p className="mt-3 text-sm text-red-400">{saveError}</p> : null}
        {saveSuccess ? <p className="mt-3 text-sm text-emerald-400">{saveSuccess}</p> : null}

        <button type="button" disabled={saving || !dirty} onClick={handleSave} className={`mt-4 ${primaryButtonClass}`}>
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Base Unit</p>
        {item.hasMovementHistory ? (
          <p className="mt-2 text-sm text-zinc-400">
            Base unit cannot be changed because this item already has inventory history. Current unit: <span className="font-medium text-zinc-200">{item.baseUnitCode}</span>
          </p>
        ) : (
          <div className="mt-3 flex items-center gap-3">
            <select value={baseUnitId} onChange={(e) => setBaseUnitId(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50">
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} — {u.name}
                </option>
              ))}
            </select>
            <button type="button" disabled={unitSaving || !unitDirty} onClick={handleSaveBaseUnit} className={secondaryButtonClass}>
              {unitSaving ? "Saving…" : "Change Unit"}
            </button>
          </div>
        )}
        {unitError ? <p className="mt-2 text-sm text-red-400">{unitError}</p> : null}
        {unitSuccess ? <p className="mt-2 text-sm text-emerald-400">{unitSuccess}</p> : null}
      </div>

      {item.baseUnitId !== null ? <UsageUnitsSection itemId={item.itemId} units={units} usageUnits={usageUnits} /> : null}

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Vendor Mappings</p>
        {mappings.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No vendor mappings yet.</p>
        ) : (
          <div className="mt-3 flex flex-col divide-y divide-zinc-800">
            {mappings.map((m, i) => (
              <div key={i} className="py-2 text-sm">
                <p className="font-medium text-zinc-200">{m.vendorName}</p>
                <p className="text-xs text-zinc-500">{m.matchBasis === "VENDOR_SKU" ? m.vendorSku : m.normalizedDescription}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col items-start gap-2">
        <button type="button" onClick={() => setStatusConfirmOpen(true)} className={isActive ? destructiveButtonClass : primaryButtonClass}>
          {isActive ? "Deactivate Item" : "Reactivate Item"}
        </button>
        {statusError ? <p className="text-sm text-red-400">{statusError}</p> : null}
      </div>

      {statusConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <h2 className="text-sm font-semibold text-zinc-100">{isActive ? `Deactivate ${item.name}?` : `Reactivate ${item.name}?`}</h2>
            <p className="mt-2 text-sm text-zinc-400">
              {isActive
                ? "This item will no longer be available for new receiving/withdrawals. Historical records remain unchanged."
                : "This item will become available for matching and receiving again."}
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

/**
 * View/add/deactivate/reprioritize this item's kiosk usage units
 * (approved-plan §8) -- purely a master-data operation, independent of
 * any purchase document. The primary slot is always the item's own base
 * unit (managed above, via Base Unit) and is never editable from here;
 * this section only ever touches the OPTIONAL secondary slot and which
 * of the two active slots is currently primary. Nothing here deletes a
 * historical row -- add/deactivate/reprioritize all soft-transition
 * inventory_item_usage_units rows server-side (20260811100122).
 */
function UsageUnitsSection({ itemId, units, usageUnits }: { itemId: string; units: { id: string; code: string; name: string }[]; usageUnits: ItemUsageUnitSummary[] }) {
  const router = useRouter();
  const primary = usageUnits.find((u) => u.slot === 1) ?? null;
  const secondary = usageUnits.find((u) => u.slot === 2) ?? null;

  const [adding, setAdding] = useState(false);
  const [secondaryUnitCode, setSecondaryUnitCode] = useState("");
  const [secondaryFactor, setSecondaryFactor] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAddSecondary() {
    if (!secondaryUnitCode || !secondaryFactor.trim() || Number(secondaryFactor) <= 0) return;
    setPending(true);
    setError(null);
    const result = await addSecondaryUsageUnitAction(itemId, secondaryUnitCode, Number(secondaryFactor));
    setPending(false);
    if (!result.ok) {
      setError("message" in result ? result.message : "Unable to add secondary usage unit.");
      return;
    }
    setAdding(false);
    setSecondaryUnitCode("");
    setSecondaryFactor("");
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
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Kiosk Usage Units</p>
      <p className="mt-1 text-xs text-zinc-500">What employees can choose when withdrawing this item at the kiosk -- one required primary, one optional secondary.</p>

      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
          <div>
            <p className="text-sm font-medium text-zinc-200">{primary ? `${primary.unitName} (${primary.unitCode})` : "Not configured"}</p>
            <p className="text-[11px] text-zinc-500">Primary</p>
          </div>
        </div>

        {secondary ? (
          <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
            <div>
              <p className="text-sm font-medium text-zinc-200">
                {secondary.unitName} ({secondary.unitCode})
              </p>
              <p className="text-[11px] text-zinc-500">Secondary</p>
            </div>
            <div className="flex gap-3">
              <button type="button" disabled={pending} onClick={() => handleMakePrimary(secondary.usageUnitId)} className="text-xs font-medium text-amber-300 hover:text-amber-200 disabled:opacity-40">
                Make Primary
              </button>
              <button type="button" disabled={pending} onClick={handleDeactivateSecondary} className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-40">
                Deactivate
              </button>
            </div>
          </div>
        ) : adding ? (
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
              <input
                type="number"
                placeholder="Conversion factor"
                value={secondaryFactor}
                onChange={(e) => setSecondaryFactor(e.target.value)}
                className="w-32 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                disabled={pending || !secondaryUnitCode || !secondaryFactor.trim() || Number(secondaryFactor) <= 0}
                onClick={handleAddSecondary}
                className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-zinc-950 disabled:opacity-40"
              >
                {pending ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setAdding(false)} className="text-xs text-zinc-500 hover:text-zinc-300">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="self-start text-xs font-medium text-amber-300 hover:text-amber-200">
            + Add secondary usage unit
          </button>
        )}
      </div>

      {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
    </div>
  );
}
