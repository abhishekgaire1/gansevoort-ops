"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DeliveryResolutionData } from "@/app/lib/purchaseDocuments/deliveryResolution";
import { resolveDeliveryLineage, type DeliveryResolutionDecision } from "@/app/actions/deliveryResolution";

/**
 * Delivery-lineage resolver. Shown in Step 2 when a document's recorded
 * deliveries are ambiguous (multiple effective lineages that cannot be
 * automatically distinguished). The manager declares whether they are separate
 * physical deliveries or duplicate entries; nothing changes inventory -- it
 * writes one append-only resolution the posting path then trusts.
 */
export function DeliveryResolver({
  purchaseDocumentId,
  data,
  onResolved,
}: {
  purchaseDocumentId: string;
  data: DeliveryResolutionData;
  onResolved: () => void;
}) {
  const [mode, setMode] = useState<"" | "separate" | "duplicate">("");
  const [retainedReceiptId, setRetainedReceiptId] = useState<string>("");
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstControlRef = useRef<HTMLButtonElement>(null);

  // Auto-scroll to the resolver and focus the first decision (no discovery click).
  useEffect(() => {
    firstControlRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    firstControlRef.current?.focus();
  }, []);

  const lineKeys = data.affectedLineKeys;
  const before = useMemo(() => {
    const m = new Map<string, { qty: number; unit: string | null }>();
    for (const lg of data.lineages) for (const l of lg.lines) {
      const cur = m.get(l.lineKey) ?? { qty: 0, unit: l.unit };
      m.set(l.lineKey, { qty: cur.qty + (l.quantity ?? 0), unit: l.unit ?? cur.unit });
    }
    return m;
  }, [data.lineages]);

  const canonicalIds = useMemo(() => {
    if (mode === "separate") return new Set(data.lineages.map((l) => l.receiptId));
    if (mode === "duplicate" && retainedReceiptId) return new Set([retainedReceiptId]);
    return new Set<string>();
  }, [mode, retainedReceiptId, data.lineages]);

  const after = useMemo(() => {
    const m = new Map<string, { qty: number; unit: string | null }>();
    for (const lg of data.lineages) {
      if (!canonicalIds.has(lg.receiptId)) continue;
      for (const l of lg.lines) {
        const cur = m.get(l.lineKey) ?? { qty: 0, unit: l.unit };
        m.set(l.lineKey, { qty: cur.qty + (l.quantity ?? 0), unit: l.unit ?? cur.unit });
      }
    }
    return m;
  }, [canonicalIds, data.lineages]);

  const valid = reason.trim() !== "" && acknowledged && (mode === "separate" || (mode === "duplicate" && retainedReceiptId !== ""));

  async function handleSave() {
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    const decisions: DeliveryResolutionDecision[] = data.lineages.map((lg) =>
      canonicalIds.has(lg.receiptId)
        ? { receiptId: lg.receiptId, decision: "CANONICAL", duplicateOfReceiptId: null }
        : { receiptId: lg.receiptId, decision: "DUPLICATE", duplicateOfReceiptId: retainedReceiptId },
    );
    const result = await resolveDeliveryLineage({ purchaseDocumentId, expectedFingerprint: data.fingerprint, reason: reason.trim(), acknowledged, decisions });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onResolved();
  }

  if (data.status !== "AMBIGUOUS") return null;

  return (
    <section id={`delivery-resolver`} className="rounded-lg border border-amber-600 bg-amber-950/20 p-4" aria-labelledby="delivery-resolver-title">
      <h3 id="delivery-resolver-title" className="text-sm font-bold text-amber-200">
        Recorded deliveries need review
      </h3>
      <p className="mt-1 text-sm text-amber-100">
        Multiple delivery records were found for the same invoice lines. Confirm whether they represent separate physical deliveries or duplicate entries.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {data.lineages.map((lg) => (
          <div key={lg.receiptId} className="rounded-md border border-zinc-700 bg-zinc-950/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm">
                {mode === "duplicate" ? (
                  <label className="flex items-center gap-1.5 text-xs text-amber-100">
                    <input type="radio" name="retained" checked={retainedReceiptId === lg.receiptId} onChange={() => setRetainedReceiptId(lg.receiptId)} />
                    Keep this one
                  </label>
                ) : null}
                <span className="font-semibold text-zinc-100">Receipt {lg.receiptRef}</span>
                <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400">
                  {lg.isLegacy ? "Legacy delivery" : `Event ${lg.deliveryEventId?.slice(0, 8)}`}
                </span>
              </div>
              <span className="text-[11px] text-zinc-500">
                {lg.recordedAt ? new Date(lg.recordedAt).toLocaleString() : "—"} · {lg.recordedByName ?? "—"}
              </span>
            </div>
            <div className="mt-1.5 flex flex-col gap-0.5 text-xs text-zinc-400">
              {lg.lines.map((l) => (
                <div key={l.lineKey} className="flex flex-wrap gap-x-3">
                  <span className="text-zinc-300">{l.description ?? l.lineKey.slice(0, 8)}</span>
                  <span>{l.quantity ?? "—"} {l.unit ?? ""}</span>
                  {l.normalizedBaseQuantity !== null ? <span>· {l.normalizedBaseQuantity} base</span> : null}
                  {l.location ? <span>· {l.location}</span> : null}
                </div>
              ))}
              {lg.correctionChain.length > 1 ? <span className="text-[11px] text-zinc-500">Correction history: {lg.correctionChain.join(" ← ")}</span> : null}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          ref={firstControlRef}
          type="button"
          onClick={() => { setMode("separate"); setRetainedReceiptId(""); }}
          aria-pressed={mode === "separate"}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium ${mode === "separate" ? "border-amber-500 bg-amber-500/10 text-amber-200" : "border-zinc-700 text-zinc-200"}`}
        >
          These are separate physical deliveries
        </button>
        <button
          type="button"
          onClick={() => setMode("duplicate")}
          aria-pressed={mode === "duplicate"}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium ${mode === "duplicate" ? "border-amber-500 bg-amber-500/10 text-amber-200" : "border-zinc-700 text-zinc-200"}`}
        >
          Keep one delivery and mark the others as duplicates
        </button>
      </div>

      {mode ? (
        <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Effect on each line</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-zinc-300">
            {lineKeys.map((k) => (
              <li key={k}>
                Currently counted: {before.get(k)?.qty ?? 0} {before.get(k)?.unit ?? ""} → After resolution: {after.get(k)?.qty ?? 0} {after.get(k)?.unit ?? ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label className="mt-3 flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm font-normal normal-case text-white" placeholder="Why are these separate deliveries / duplicates?" />
      </label>
      <label className="mt-2 flex items-start gap-2 text-sm text-amber-100">
        <input type="checkbox" checked={acknowledged} disabled={pending} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
        I confirm this resolution is correct. It records how these deliveries count and does not change inventory until the invoice is posted.
      </label>

      {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}

      <div className="mt-3">
        <button type="button" onClick={handleSave} disabled={!valid || pending} className="rounded-md border border-amber-500 bg-amber-500/10 px-5 py-2 text-sm font-bold text-amber-300 disabled:opacity-40">
          {pending ? "Saving…" : "Save delivery resolution"}
        </button>
      </div>
    </section>
  );
}
