"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setVendorPurchasePackageAction } from "@/app/actions/adminItems";
import type { VendorPackageSummary, ReceivingBehavior } from "@/app/lib/admin/vendorPackages";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { inputClass, selectClass, labelClass, inlineNeutralClass } from "@/app/components/manager/surfaces";

const BEHAVIORS: { value: ReceivingBehavior; label: string }[] = [
  { value: "SAME_UNIT", label: "Same as base unit" },
  { value: "FIXED_CONVERSION", label: "Fixed conversion" },
  { value: "MEASURE_EACH_DELIVERY", label: "Measure each delivery" },
  { value: "COUNT_EACH_DELIVERY", label: "Count each delivery" },
];

/**
 * Edit a vendor's purchase package for an already-confirmed item (spec
 * section 7) -- defaults to future receipts only: the RPC always
 * supersedes (deactivate old + insert new), never mutates a historical
 * row. This dialog has no "apply to past receipts" option at all --
 * that's the separate, explicit ReceiptCorrectionFlow.
 */
export function EditVendorPackageDialog({ pkg, baseUnitCode, onClose }: { pkg: VendorPackageSummary; baseUnitCode: string; onClose: () => void }) {
  const router = useRouter();
  const [purchaseUnitCode, setPurchaseUnitCode] = useState(pkg.package?.purchaseUnitCode ?? baseUnitCode);
  const [receivingBehavior, setReceivingBehavior] = useState<ReceivingBehavior>(pkg.package?.receivingBehavior ?? "SAME_UNIT");
  const [conversionFactor, setConversionFactor] = useState(pkg.package?.conversionFactor?.toString() ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requiresMeasurement = receivingBehavior === "MEASURE_EACH_DELIVERY" || receivingBehavior === "COUNT_EACH_DELIVERY";
  const canSave = purchaseUnitCode.trim() !== "" && (receivingBehavior !== "FIXED_CONVERSION" || (conversionFactor.trim() !== "" && Number(conversionFactor) > 0));

  async function handleSave() {
    if (!canSave || pending) return;
    setPending(true);
    setError(null);
    const result = await setVendorPurchasePackageAction(
      pkg.vendorItemMappingId,
      purchaseUnitCode.trim().toUpperCase(),
      receivingBehavior,
      receivingBehavior === "FIXED_CONVERSION" ? Number(conversionFactor) : null,
      requiresMeasurement
    );
    setPending(false);
    if (!result.ok) {
      setError("message" in result ? result.message : "Unable to save the package.");
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
        <h2 className="text-sm font-semibold text-zinc-100">Edit purchase package -- {pkg.vendorName}</h2>
        <p className="mt-1 text-xs text-zinc-500">{pkg.matchBasis === "VENDOR_SKU" ? pkg.vendorSku : pkg.normalizedDescription}</p>

        <div className="mt-4 flex flex-col gap-3">
          <label className={`flex flex-col gap-1 ${labelClass}`}>
            Purchase unit code
            <input value={purchaseUnitCode} onChange={(e) => setPurchaseUnitCode(e.target.value.toUpperCase())} className={inputClass} placeholder="e.g. PACK" />
          </label>
          <label className={`flex flex-col gap-1 ${labelClass}`}>
            Receiving behavior
            <select value={receivingBehavior} onChange={(e) => setReceivingBehavior(e.target.value as ReceivingBehavior)} className={selectClass}>
              {BEHAVIORS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          {receivingBehavior === "FIXED_CONVERSION" ? (
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Conversion factor -- 1 {purchaseUnitCode || "unit"} =
              <div className="flex items-center gap-2">
                <input type="number" value={conversionFactor} onChange={(e) => setConversionFactor(e.target.value)} className={inputClass} />
                <span className="text-sm text-zinc-400">{baseUnitCode}</span>
              </div>
            </label>
          ) : null}

          <div className={inlineNeutralClass}>
            Future transactions only. This change will apply to new receipts. Previously posted transactions and current inventory will not be recalculated.
          </div>

          {error ? <p className="text-sm text-red-400">{error}</p> : null}

          <div className="mt-2 flex justify-end gap-3">
            <button type="button" onClick={onClose} className={secondaryButtonClass}>
              Cancel
            </button>
            <button type="button" disabled={!canSave || pending} onClick={handleSave} className={primaryButtonClass}>
              {pending ? "Saving…" : "Apply to future transactions only"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
