"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { previewInventoryCorrectionAction, recordInventoryCorrectionAction } from "@/app/actions/adminItems";
import type { CorrectionMode } from "@/app/lib/inventory/corrections";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { inputClass, selectClass, labelClass } from "@/app/components/manager/surfaces";
import { InventoryImpactPreview } from "./InventoryImpactPreview";

/**
 * The generic "Adjust Inventory" action (spec section 10) -- Admin-only.
 * Never edits current quantity as a plain item-master field: a distinct
 * action, with a mandatory preview + explicit confirmation, exactly like
 * the receipt-correction flow.
 */
export function AdjustInventoryDialog({
  itemId,
  baseUnitCode,
  locations,
  onClose,
}: {
  itemId: string;
  baseUnitCode: string;
  locations: { locationId: string; locationName: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [locationId, setLocationId] = useState(locations[0]?.locationId ?? "");
  const [mode, setMode] = useState<CorrectionMode>("COUNTED");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<"form" | "preview">("form");
  const [previewData, setPreviewData] = useState<{ previousBalance: number; proposedBalance: number; delta: number } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientRequestId] = useState(() => crypto.randomUUID());

  const locationName = locations.find((l) => l.locationId === locationId)?.locationName ?? "";
  const parsedQuantity = quantity.trim() === "" ? null : Number(quantity);
  const canPreview = locationId !== "" && reason.trim() !== "" && parsedQuantity !== null && Number.isFinite(parsedQuantity) && (mode === "DELTA" || parsedQuantity >= 0);

  async function handlePreview() {
    if (!canPreview || pending) return;
    setPending(true);
    setError(null);
    const result = await previewInventoryCorrectionAction(itemId, locationId, mode, mode === "COUNTED" ? parsedQuantity : null, mode === "DELTA" ? parsedQuantity : null);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPreviewData(result.preview);
    setStep("preview");
  }

  async function handleConfirm() {
    if (!acknowledged || pending) return;
    setPending(true);
    setError(null);
    const result = await recordInventoryCorrectionAction(itemId, locationId, mode, mode === "COUNTED" ? parsedQuantity : null, mode === "DELTA" ? parsedQuantity : null, reason, clientRequestId);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
        <h2 className="text-sm font-semibold text-zinc-100">Adjust Inventory</h2>

        {step === "form" ? (
          <div className="mt-4 flex flex-col gap-3">
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Location
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={selectClass}>
                {locations.map((l) => (
                  <option key={l.locationId} value={l.locationId}>
                    {l.locationName}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setMode("COUNTED")} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium ${mode === "COUNTED" ? "border-amber-500 bg-amber-500/10 text-amber-300" : "border-zinc-700 text-zinc-400"}`}>
                Counted quantity
              </button>
              <button type="button" onClick={() => setMode("DELTA")} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium ${mode === "DELTA" ? "border-amber-500 bg-amber-500/10 text-amber-300" : "border-zinc-700 text-zinc-400"}`}>
                Adjustment (+/-)
              </button>
            </div>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              {mode === "COUNTED" ? `Counted quantity (${baseUnitCode})` : `Adjustment delta (${baseUnitCode})`}
              <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputClass} />
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Reason
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={`${inputClass} h-auto py-2`} />
            </label>
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <div className="mt-2 flex justify-end gap-3">
              <button type="button" onClick={onClose} className={secondaryButtonClass}>
                Cancel
              </button>
              <button type="button" disabled={!canPreview || pending} onClick={handlePreview} className={primaryButtonClass}>
                {pending ? "Checking…" : "Review impact"}
              </button>
            </div>
          </div>
        ) : previewData ? (
          <div className="mt-4 flex flex-col gap-3">
            <InventoryImpactPreview
              lines={[{ locationName, previousBalance: previewData.previousBalance, proposedBalance: previewData.proposedBalance, delta: previewData.delta }]}
              baseUnitCode={baseUnitCode}
              valuationEffect={null}
            />
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              I reviewed the inventory impact and confirm this correction is intentional.
            </label>
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <div className="mt-2 flex justify-end gap-3">
              <button type="button" onClick={() => setStep("form")} className={secondaryButtonClass}>
                Back
              </button>
              <button type="button" disabled={!acknowledged || pending} onClick={handleConfirm} className={primaryButtonClass}>
                {pending ? "Applying…" : "Apply inventory correction"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
