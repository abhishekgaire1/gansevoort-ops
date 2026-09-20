"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DeliveryResolutionData, DeliveryLineage } from "@/app/lib/purchaseDocuments/deliveryResolution";
import { resolveDeliveryLineage, type DeliveryResolutionDecision } from "@/app/actions/deliveryResolution";

/**
 * Delivery-lineage resolver. Shown in Step 2 when a document's recorded
 * deliveries are ambiguous (multiple effective lineages that cannot be
 * automatically distinguished). The manager declares whether they are separate
 * physical deliveries or duplicate entries; nothing changes inventory -- it
 * writes one append-only resolution the posting path then trusts.
 *
 * Every quantity is shown WITH its unit; quantities in different base units are
 * never summed and never labeled a generic "base".
 */

function fmtQty(qty: number | null, unit: string | null): string {
  if (qty === null) return "—";
  return `${qty}${unit ? ` ${unit}` : ""}`;
}

function fmtWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function conditionLabel(condition: string | null): string | null {
  if (!condition || condition === "RECEIVED_AS_INVOICED") return null;
  return condition.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

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
  const [overDeliveryConfirmed, setOverDeliveryConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstControlRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstControlRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    firstControlRef.current?.focus();
  }, []);

  const lineKeys = data.affectedLineKeys;

  // Per-line facts that are constant across lineages: base unit, invoice qty,
  // and a human label. Pulled from the first lineage that carries the line.
  const lineMeta = useMemo(() => {
    const m = new Map<string, { description: string | null; baseUnitCode: string | null; invoiceQuantity: number | null; invoiceUnit: string | null; receivedUnit: string | null }>();
    for (const lg of data.lineages) {
      for (const l of lg.lines) {
        if (!m.has(l.lineKey)) {
          m.set(l.lineKey, { description: l.description, baseUnitCode: l.baseUnitCode, invoiceQuantity: l.invoiceQuantity, invoiceUnit: l.invoiceUnit, receivedUnit: l.unit });
        }
      }
    }
    return m;
  }, [data.lineages]);

  const canonicalIds = useMemo(() => {
    if (mode === "separate") return new Set(data.lineages.map((l) => l.receiptId));
    if (mode === "duplicate" && retainedReceiptId) return new Set([retainedReceiptId]);
    return new Set<string>();
  }, [mode, retainedReceiptId, data.lineages]);

  // Per-line received quantity summed across the CANONICAL lineages only (what
  // would post). Kept per line-key so each stays in its own unit -- never a
  // cross-unit total.
  const afterByLine = useMemo(() => {
    const m = new Map<string, number>();
    for (const lg of data.lineages) {
      if (!canonicalIds.has(lg.receiptId)) continue;
      for (const l of lg.lines) m.set(l.lineKey, (m.get(l.lineKey) ?? 0) + (l.quantity ?? 0));
    }
    return m;
  }, [canonicalIds, data.lineages]);

  // Separate-delivery safety: does the combined received quantity exceed the
  // invoiced quantity on any line? (Only meaningful for the "separate" choice.)
  const overInvoiceLines = useMemo(() => {
    if (mode !== "separate") return [] as string[];
    const over: string[] = [];
    for (const k of lineKeys) {
      const meta = lineMeta.get(k);
      const combined = afterByLine.get(k) ?? 0;
      if (meta?.invoiceQuantity != null && combined > meta.invoiceQuantity) over.push(k);
    }
    return over;
  }, [mode, lineKeys, lineMeta, afterByLine]);

  const needsOverDeliveryConfirm = mode === "separate" && overInvoiceLines.length > 0;

  const valid =
    reason.trim() !== "" &&
    acknowledged &&
    (mode === "separate" || (mode === "duplicate" && retainedReceiptId !== "")) &&
    (!needsOverDeliveryConfirm || overDeliveryConfirmed);

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

  const renderLineageCard = (lg: DeliveryLineage) => {
    const isRetained = mode === "duplicate" && retainedReceiptId === lg.receiptId;
    return (
      <div
        key={lg.receiptId}
        className={`rounded-md border p-3 ${isRetained ? "border-emerald-500 bg-emerald-950/20" : "border-zinc-700 bg-zinc-950/60"}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {mode === "duplicate" ? (
              <label className="flex items-center gap-1.5 text-xs font-medium text-amber-100">
                <input type="radio" name="retained" checked={retainedReceiptId === lg.receiptId} onChange={() => setRetainedReceiptId(lg.receiptId)} />
                {isRetained ? "Keep as authoritative" : "Mark as duplicate"}
              </label>
            ) : null}
            <span className="font-semibold text-zinc-100">Recorded delivery {lg.ordinal}</span>
            {isRetained ? <span className="rounded-full border border-emerald-500 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">Retained</span> : null}
            <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-500" title="Internal receipt reference">
              #{lg.receiptRef}
            </span>
          </div>
        </div>

        {/* Provenance: original recording, latest correction, actors. */}
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-0.5 text-[11px] text-zinc-400 sm:grid-cols-2">
          <div className="flex justify-between gap-2"><dt>Originally recorded</dt><dd className="text-zinc-300">{fmtWhen(lg.originallyRecordedAt)}{lg.originalActorName ? ` · ${lg.originalActorName}` : ""}</dd></div>
          {lg.wasCorrected ? (
            <div className="flex justify-between gap-2"><dt>Latest correction</dt><dd className="text-zinc-300">{fmtWhen(lg.recordedAt)}{lg.correctingActorName ? ` · ${lg.correctingActorName}` : ""}</dd></div>
          ) : (
            <div className="flex justify-between gap-2"><dt>Corrections</dt><dd className="text-zinc-300">None</dd></div>
          )}
        </dl>
        {lg.note ? <p className="mt-1 text-[11px] text-zinc-400">Note: <span className="text-zinc-300">{lg.note}</span></p> : null}

        <div className="mt-2 flex flex-col gap-1 border-t border-zinc-800 pt-2 text-xs text-zinc-400">
          {lg.lines.map((l) => {
            const cond = conditionLabel(l.condition);
            return (
              <div key={l.lineKey} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="min-w-[9rem] text-zinc-300">{l.description ?? l.lineKey.slice(0, 8)}</span>
                <span className="tabular-nums">Received {fmtQty(l.quantity, l.unit)}</span>
                {l.normalizedBaseQuantity !== null && l.baseUnitCode ? (
                  <span className="tabular-nums">· {l.normalizedBaseQuantity} {l.baseUnitCode} inventory</span>
                ) : null}
                {l.invoiceQuantity !== null ? <span className="tabular-nums text-zinc-500">· Invoiced {fmtQty(l.invoiceQuantity, l.invoiceUnit)}</span> : null}
                {l.location ? <span className="text-zinc-500">· {l.location}</span> : null}
                {cond ? <span className="rounded border border-amber-700 px-1 text-[10px] text-amber-300">{cond}</span> : null}
                {l.note ? <span className="text-zinc-500">· “{l.note}”</span> : null}
              </div>
            );
          })}
          {lg.correctionChain.length > 1 ? (
            <p className="text-[11px] text-zinc-500">Correction history: {lg.correctionChain.length} version{lg.correctionChain.length === 1 ? "" : "s"} (newest first: {lg.correctionChain.join(" ← ")})</p>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <section id="delivery-resolver" className="rounded-lg border border-amber-600 bg-amber-950/20 p-4" aria-labelledby="delivery-resolver-title">
      <h3 id="delivery-resolver-title" className="text-sm font-bold text-amber-200">
        Recorded deliveries need review
      </h3>
      <p className="mt-1 text-sm text-amber-100">
        {data.lineages.length} separate delivery records were found for the same invoice lines. Confirm whether they represent separate physical deliveries or duplicate entries of one delivery. Nothing changes inventory until you post.
      </p>

      <div className="mt-3 flex flex-col gap-2">{data.lineages.map(renderLineageCard)}</div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          ref={firstControlRef}
          type="button"
          onClick={() => { setMode("separate"); setRetainedReceiptId(""); setOverDeliveryConfirmed(false); }}
          aria-pressed={mode === "separate"}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium ${mode === "separate" ? "border-amber-500 bg-amber-500/10 text-amber-200" : "border-zinc-700 text-zinc-200"}`}
        >
          These are separate physical deliveries
        </button>
        <button
          type="button"
          onClick={() => { setMode("duplicate"); setOverDeliveryConfirmed(false); }}
          aria-pressed={mode === "duplicate"}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium ${mode === "duplicate" ? "border-amber-500 bg-amber-500/10 text-amber-200" : "border-zinc-700 text-zinc-200"}`}
        >
          Keep one delivery and mark the others as duplicates
        </button>
      </div>

      {/* ============ SEPARATE: invoice vs combined, with over-delivery guard ============ */}
      {mode === "separate" ? (
        <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Combined effect on each line (all deliveries summed)</p>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-1 pr-3">Line</th>
                  <th className="py-1 pr-3 text-right">Invoiced</th>
                  <th className="py-1 pr-3 text-right">Combined received</th>
                  <th className="py-1 pr-3 text-right">Difference</th>
                  <th className="py-1 pr-3 text-right">Would post</th>
                </tr>
              </thead>
              <tbody className="tabular-nums text-zinc-300">
                {lineKeys.map((k) => {
                  const meta = lineMeta.get(k);
                  const combined = afterByLine.get(k) ?? 0;
                  const unit = meta?.receivedUnit ?? meta?.invoiceUnit ?? null;
                  const diff = meta?.invoiceQuantity != null ? combined - meta.invoiceQuantity : null;
                  const over = diff != null && diff > 0;
                  return (
                    <tr key={k} className="border-t border-zinc-800">
                      <td className="py-1 pr-3 text-zinc-200">{meta?.description ?? k.slice(0, 8)}</td>
                      <td className="py-1 pr-3 text-right">{meta?.invoiceQuantity != null ? fmtQty(meta.invoiceQuantity, meta.invoiceUnit) : "—"}</td>
                      <td className="py-1 pr-3 text-right">{fmtQty(combined, unit)}</td>
                      <td className={`py-1 pr-3 text-right ${over ? "font-semibold text-amber-300" : "text-zinc-500"}`}>{diff != null ? `${diff > 0 ? "+" : ""}${diff} ${unit ?? ""}` : "—"}</td>
                      <td className="py-1 pr-3 text-right text-zinc-200">{fmtQty(combined, meta?.baseUnitCode ?? unit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {needsOverDeliveryConfirm ? (
            <div className="mt-2 rounded-md border border-amber-600 bg-amber-900/30 px-3 py-2">
              <p className="text-xs font-semibold text-amber-200">These records total more than the invoice quantity.</p>
              <p className="mt-0.5 text-[11px] text-amber-100/90">Summing them will post more inventory than the invoice states on {overInvoiceLines.length} line{overInvoiceLines.length === 1 ? "" : "s"}. Only confirm if these were genuinely separate physical deliveries.</p>
              <label className="mt-2 flex items-start gap-2 text-xs text-amber-100">
                <input type="checkbox" checked={overDeliveryConfirmed} disabled={pending} onChange={(e) => setOverDeliveryConfirmed(e.target.checked)} className="mt-0.5" />
                I confirm these were separate physical deliveries and the combined quantity is correct.
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ============ DUPLICATE: before/after per item with its unit ============ */}
      {mode === "duplicate" ? (
        <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            {retainedReceiptId ? "Effect of keeping the selected delivery" : "Select which recorded delivery to keep above"}
          </p>
          {retainedReceiptId ? (
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-zinc-300">
              {lineKeys.map((k) => {
                const meta = lineMeta.get(k);
                const unit = meta?.receivedUnit ?? meta?.invoiceUnit ?? null;
                // Currently counted = every lineage summed; after = retained only.
                let currentlyCounted = 0;
                for (const lg of data.lineages) for (const l of lg.lines) if (l.lineKey === k) currentlyCounted += l.quantity ?? 0;
                const after = afterByLine.get(k) ?? 0;
                return (
                  <li key={k} className="tabular-nums">
                    <span className="text-zinc-200">{meta?.description ?? k.slice(0, 8)}:</span> currently counted {fmtQty(currentlyCounted, unit)} → after {fmtQty(after, unit)}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-zinc-500">A recommendation is not applied automatically — you choose which delivery is authoritative.</p>
          )}
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
