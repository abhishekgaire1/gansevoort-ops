"use client";

import { useEffect, useState } from "react";
import { getPostedDeliveryConflict_action, createDeliveryConflictCorrection } from "@/app/actions/deliveryResolution";
import type { PostedDeliveryConflict } from "@/app/lib/inventory/deliveryConflictCorrection";

/**
 * §4 posted-delivery-conflict handoff. When an ambiguous (duplicate) document was
 * already posted, its excess inventory cannot be undone by the append-only
 * resolver -- it must be removed through the audited inventory correction
 * primitive. This panel shows exactly what was posted, what should have been
 * posted, the excess per item/location, current on-hand, the proposed correction,
 * and any negative-stock risk, then lets a manager apply it once (idempotent).
 */
export function PostedDeliveryConflictHandoff({ purchaseDocumentId, onCorrected }: { purchaseDocumentId: string; onCorrected?: () => void }) {
  const [data, setData] = useState<PostedDeliveryConflict | null>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // One stable request id per mount keeps the correction idempotent across retries.
  const [clientRequestId] = useState(() => `dcc-${purchaseDocumentId}-${crypto.randomUUID()}`);

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await getPostedDeliveryConflict_action(purchaseDocumentId);
      if (!active) return;
      setData(res.ok ? res.data : null);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [purchaseDocumentId]);

  if (loading) return null;
  if (!data || !data.isPostedConflict) return null;

  const anyNegative = data.items.some((it) => it.wouldGoNegative);
  const valid = reason.trim() !== "" && acknowledged && !anyNegative && !done;

  async function handleApply() {
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    const res = await createDeliveryConflictCorrection({ purchaseDocumentId, reason: reason.trim(), acknowledged, clientRequestId });
    setPending(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setDone(true);
    onCorrected?.();
  }

  return (
    <section className="rounded-lg border border-red-600 bg-red-950/20 p-4" aria-labelledby="posted-conflict-title">
      <h3 id="posted-conflict-title" className="text-sm font-bold text-red-200">
        Duplicate delivery already posted — inventory correction required
      </h3>
      <p className="mt-1 text-sm text-red-100">
        This document’s duplicate deliveries were already posted, so inventory was added more than once. This cannot be undone by exclusion. Review the excess below and create an audited inventory correction. Original postings are preserved.
      </p>
      <p className="mt-1 text-[11px] text-red-200/80">
        Posted {data.postedAt ? new Date(data.postedAt).toLocaleString() : "—"} · movements {data.movementIds.map((m) => m.slice(0, 8)).join(", ") || "—"}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[11px] uppercase tracking-wide text-red-200/70">
            <tr>
              <th className="py-1 pr-3">Item</th>
              <th className="py-1 pr-3">Location</th>
              <th className="py-1 pr-3 text-right">Lineages</th>
              <th className="py-1 pr-3 text-right">Qty added</th>
              <th className="py-1 pr-3 text-right">Should be</th>
              <th className="py-1 pr-3 text-right">Excess</th>
              <th className="py-1 pr-3 text-right">On hand</th>
              <th className="py-1 pr-3 text-right">Correction</th>
              <th className="py-1 pr-3 text-right">After</th>
            </tr>
          </thead>
          <tbody className="font-[tabular-nums] text-zinc-200">
            {data.items.map((it) => (
              <tr key={`${it.inventoryItemId}:${it.locationId}`} className="border-t border-zinc-800">
                <td className="py-1 pr-3 text-zinc-100">{it.itemName}</td>
                <td className="py-1 pr-3 text-zinc-400">{it.locationName}</td>
                <td className="py-1 pr-3 text-right">{it.lineageCount}×</td>
                <td className="py-1 pr-3 text-right">{it.postedBaseQuantity} {it.baseUnitCode}</td>
                <td className="py-1 pr-3 text-right">{it.intendedBaseQuantity} {it.baseUnitCode}</td>
                <td className="py-1 pr-3 text-right text-amber-300">+{it.excessBaseQuantity} {it.baseUnitCode}</td>
                <td className="py-1 pr-3 text-right">{it.currentOnHand} {it.baseUnitCode}</td>
                <td className="py-1 pr-3 text-right text-red-300">{it.proposedDelta} {it.baseUnitCode}</td>
                <td className={`py-1 pr-3 text-right ${it.wouldGoNegative ? "font-bold text-red-400" : "text-zinc-200"}`}>
                  {it.proposedOnHand} {it.baseUnitCode}{it.wouldGoNegative ? " ⚠" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {anyNegative ? (
        <p className="mt-3 rounded-md border border-red-700 bg-red-900/30 px-3 py-2 text-xs text-red-200">
          Removing the duplicate quantity would drive at least one item below zero on hand. Withdrawals may have already consumed the excess. Investigate before correcting — this correction is blocked.
        </p>
      ) : null}

      {done ? (
        <p className="mt-3 rounded-md border border-emerald-700 bg-emerald-900/20 px-3 py-2 text-sm text-emerald-200">
          Inventory correction recorded. The duplicate quantity has been removed and audited.
        </p>
      ) : (
        <>
          <label className="mt-3 flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending || anyNegative} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm font-normal normal-case text-white" placeholder="Why is this a duplicate posting that must be corrected?" />
          </label>
          <label className="mt-2 flex items-start gap-2 text-sm text-red-100">
            <input type="checkbox" checked={acknowledged} disabled={pending || anyNegative} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
            I confirm this removes duplicate inventory that was posted in error. The server recalculates the excess from current balances when I apply it.
          </label>

          {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}

          <div className="mt-3">
            <button type="button" onClick={handleApply} disabled={!valid || pending} className="rounded-md border border-red-500 bg-red-500/10 px-5 py-2 text-sm font-bold text-red-200 disabled:opacity-40">
              {pending ? "Correcting…" : "Create inventory correction"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
