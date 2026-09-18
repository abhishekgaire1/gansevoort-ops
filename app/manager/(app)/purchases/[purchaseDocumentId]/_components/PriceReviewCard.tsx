"use client";

import { useState } from "react";
import Link from "next/link";
import { formatMoney } from "@/app/lib/formatMoney";
import { priceChangeLabel } from "@/app/lib/purchasing/priceReviewPolicy";
import { primaryButtonClass, textLinkClass } from "@/app/components/manager/buttonStyles";
import { inputClass } from "@/app/components/manager/surfaces";
import type { LinePriceReviewView } from "@/app/actions/priceReview";

/**
 * The blocking price-review card for a SIGNIFICANT (>=20%) normalized
 * base-unit price change. Factual and operational -- direction-specific
 * plain language, both increases and decreases, never "cheapest"/"best".
 * Acknowledging records only that a review happened; it changes no invoice
 * price or inventory quantity.
 */
export function PriceReviewCard({
  id,
  invoiceDescription,
  review,
  pending,
  onAcknowledge,
  priceHistoryHref,
}: {
  id: string;
  invoiceDescription: string | null;
  review: LinePriceReviewView;
  pending: boolean;
  onAcknowledge: (note: string) => void;
  priceHistoryHref: string | null;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [note, setNote] = useState("");
  const c = review.comparison;
  if (!c) return null;

  const unit = c.baseUnitCode;
  const pct = Math.abs(c.deltaPct).toFixed(1);
  const vendor = c.previous.vendorName ?? "This vendor";

  return (
    <div id={id} tabIndex={-1} className="rounded-lg border border-amber-700/70 bg-amber-950/10 focus:outline-none">
      <div className="border-b border-amber-800/40 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300">Price change requires review</span>
          <span className="text-sm font-semibold text-zinc-100">{invoiceDescription ?? "—"}</span>
        </div>
        <p className="mt-1.5 text-sm text-amber-100">
          {vendor} {c.direction === "increase" ? "increased" : "decreased"} from {formatMoney(c.previous.unitCost, null)}/{unit} to {formatMoney(c.currentUnitCost, null)}/{unit} — {priceChangeLabel(c.direction, c.deltaPct, { requiresReview: true }).replace("Price change requires review: ", "")}.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-3">
        <Field label="Vendor" value={vendor} />
        <Field label="Vendor SKU" value={review.vendorSku ?? "—"} />
        <Field label="Direction" value={`${c.direction === "increase" ? "Increased" : "Decreased"} ${pct}%`} />
        <Field label="Previous price" value={`${formatMoney(c.previous.unitCost, null)}/${unit}`} sub={c.previous.documentDate ? `on ${new Date(`${c.previous.documentDate}T00:00:00`).toLocaleDateString()}` : undefined} />
        <Field label="Current price" value={`${formatMoney(c.currentUnitCost, null)}/${unit}`} />
        <Field label="Difference" value={`${c.deltaAbs >= 0 ? "+" : "−"}${formatMoney(Math.abs(c.deltaAbs), null)}/${unit}`} />
      </div>

      <div className="border-t border-amber-800/40 px-4 py-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-400">
          Review note (optional)
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
            placeholder="Add any context…"
            className={inputClass}
          />
        </label>
        <label className="mt-3 flex items-start gap-2 text-sm text-amber-100">
          <input type="checkbox" checked={acknowledged} disabled={pending} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
          I reviewed this price change and want to continue.
        </label>
        <p className="mt-2 text-[11px] text-zinc-500">Acknowledging records that you reviewed this change. It does not change the invoice price or inventory quantity.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => onAcknowledge(note)}
            disabled={!acknowledged || pending}
            className={primaryButtonClass}
          >
            {pending ? "Saving…" : "Acknowledge price change"}
          </button>
          {priceHistoryHref ? (
            <Link href={priceHistoryHref} className={textLinkClass} target="_blank" rel="noopener noreferrer">
              View price history
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="text-zinc-100 tabular-nums">{value}</p>
      {sub ? <p className="text-[11px] text-zinc-500">{sub}</p> : null}
    </div>
  );
}
