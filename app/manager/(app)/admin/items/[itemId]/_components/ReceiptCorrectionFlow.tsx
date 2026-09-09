"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listReceiptsUsingVendorPackageAction, correctReceiptPackageFactorAction } from "@/app/actions/adminItems";
import type { ReceiptUsingPackageVersion } from "@/app/lib/admin/vendorPackages";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { inputClass, labelClass, tableWrapClass, tableClass, tableHeadClass, tableHeadCellClass, tableRowClass, tableCellClass } from "@/app/components/manager/surfaces";
import { InventoryImpactPreview, type ImpactLine } from "./InventoryImpactPreview";

/**
 * "Correct inventory from previous receipts" (spec section 7) -- the
 * flagship "current inventory will change" workflow. Manager selects
 * specific already-posted receipts that used this package version, sees
 * the exact delta, and confirms. Never applied automatically; never
 * rewrites the original receipt/movement rows.
 */
export function ReceiptCorrectionFlow({ vendorItemPurchaseUnitId, baseUnitCode, onClose }: { vendorItemPurchaseUnitId: string; baseUnitCode: string; onClose: () => void }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [receipts, setReceipts] = useState<ReceiptUsingPackageVersion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newConversionFactor, setNewConversionFactor] = useState("");
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<"pick" | "preview">("pick");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    listReceiptsUsingVendorPackageAction(vendorItemPurchaseUnitId).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) setReceipts(result.receipts);
    });
    return () => {
      cancelled = true;
    };
  }, [vendorItemPurchaseUnitId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const factor = Number(newConversionFactor);
  const canPreview = selected.size > 0 && newConversionFactor.trim() !== "" && Number.isFinite(factor) && factor > 0 && reason.trim() !== "";

  const selectedReceipts = receipts.filter((r) => selected.has(r.postingLineId));
  const impactLines: ImpactLine[] = selectedReceipts.map((r) => {
    const newQuantity = (r.originalReceivedPackageQuantity ?? 0) * factor;
    return {
      locationName: r.locationName,
      previousBalance: r.originalNormalizedBaseQuantity,
      proposedBalance: newQuantity,
      delta: newQuantity - r.originalNormalizedBaseQuantity,
    };
  });

  async function handleConfirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await correctReceiptPackageFactorAction(Array.from(selected), vendorItemPurchaseUnitId, reason, clientRequestId);
    setPending(false);
    if (!result.ok) {
      setError("message" in result ? result.message : "Unable to apply correction.");
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div role="dialog" aria-modal="true" className="w-full max-w-2xl rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
        <h2 className="text-sm font-semibold text-zinc-100">Correct inventory from previous receipts</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Select the affected receipts below and enter the corrected conversion factor -- each selected receipt&rsquo;s normalized quantity is re-derived from that factor against its original
          received quantity. The original receipt and posting records are never rewritten.
        </p>

        {step === "pick" ? (
          <div className="mt-4 flex flex-col gap-3">
            {loading ? (
              <p className="text-sm text-zinc-500">Loading receipts…</p>
            ) : receipts.length === 0 ? (
              <p className="text-sm text-zinc-500">No posted receipts used this package version.</p>
            ) : (
              <div className={tableWrapClass}>
                <table className={tableClass}>
                  <thead className={tableHeadClass}>
                    <tr>
                      <th className={tableHeadCellClass}></th>
                      <th className={tableHeadCellClass}>Document</th>
                      <th className={tableHeadCellClass}>Date</th>
                      <th className={tableHeadCellClass}>Location</th>
                      <th className={tableHeadCellClass}>Received</th>
                      <th className={tableHeadCellClass}>Posted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipts.map((r) => (
                      <tr key={r.postingLineId} className={tableRowClass}>
                        <td className={tableCellClass}>
                          <input type="checkbox" checked={selected.has(r.postingLineId)} onChange={() => toggle(r.postingLineId)} />
                        </td>
                        <td className={tableCellClass}>{r.documentNumber ?? "—"}</td>
                        <td className={tableCellClass}>{new Date(r.documentDate).toLocaleDateString()}</td>
                        <td className={tableCellClass}>{r.locationName}</td>
                        <td className={tableCellClass}>
                          {r.originalReceivedPackageQuantity} {r.originalPackageUnit}
                        </td>
                        <td className={tableCellClass}>
                          {r.originalNormalizedBaseQuantity} {baseUnitCode}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Corrected conversion factor -- 1 package =
              <div className="flex items-center gap-2">
                <input type="number" value={newConversionFactor} onChange={(e) => setNewConversionFactor(e.target.value)} className={inputClass} />
                <span className="text-sm text-zinc-400">{baseUnitCode}</span>
              </div>
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Reason
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={`${inputClass} h-auto py-2`} />
            </label>

            <div className="mt-2 flex justify-end gap-3">
              <button type="button" onClick={onClose} className={secondaryButtonClass}>
                Cancel
              </button>
              <button type="button" disabled={!canPreview} onClick={() => setStep("preview")} className={primaryButtonClass}>
                Review impact
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <InventoryImpactPreview lines={impactLines} baseUnitCode={baseUnitCode} valuationEffect={null} />
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <div className="mt-2 flex justify-end gap-3">
              <button type="button" onClick={() => setStep("pick")} className={secondaryButtonClass}>
                Back
              </button>
              <button type="button" disabled={pending} onClick={handleConfirm} className={primaryButtonClass}>
                {pending ? "Applying…" : "Apply inventory correction"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
