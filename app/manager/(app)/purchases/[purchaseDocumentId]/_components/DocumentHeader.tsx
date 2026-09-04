"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { AmendmentBannerContent } from "@/app/lib/purchaseDocuments/amendmentBanner";
import { panelClass } from "@/app/components/manager/surfaces";

/**
 * The one stable document-identity header (Desktop Application Design
 * System pass) -- breadcrumb, vendor/invoice#/date, status, and (when
 * applicable) amendment context, all in ONE connected panel instead of a
 * plain heading followed by a separately-floating blue amendment card.
 * Stays visible/identical across all three preparation steps so the
 * manager never loses track of which document they're working on.
 */
export function DocumentHeader({
  vendorName,
  documentNumberLabel,
  documentNumber,
  documentDate,
  statusLabel,
  statusTone,
  sourceFilename,
  amendmentBanner,
  actions,
}: {
  vendorName: string | null;
  documentNumberLabel: string;
  documentNumber: string | null;
  documentDate: string | null;
  statusLabel: string;
  statusTone: "neutral" | "warning" | "info";
  sourceFilename: string;
  amendmentBanner: AmendmentBannerContent | null;
  actions?: ReactNode;
}) {
  const statusClass =
    statusTone === "warning" ? "border-amber-700 bg-amber-950/40 text-amber-300" : statusTone === "info" ? "border-sky-700 bg-sky-950/40 text-sky-300" : "border-zinc-700 bg-zinc-800 text-zinc-300";

  return (
    <div className={panelClass}>
      <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0">
          <Link href="/manager/receiving" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
            ← Receiving Queue
          </Link>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h1 className="truncate text-lg font-semibold text-zinc-50">{vendorName ?? sourceFilename}</h1>
            {vendorName ? (
              <span className="text-sm text-zinc-400">
                {documentNumberLabel}
                {documentNumber ?? "—"}
                {documentDate ? ` · ${new Date(documentDate).toLocaleDateString()}` : ""}
              </span>
            ) : null}
            <span className={`inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${statusClass}`}>{statusLabel}</span>
          </div>
          {vendorName ? <p className="mt-1 text-xs text-zinc-600">Source: {sourceFilename}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      {amendmentBanner ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800 bg-sky-950/20 px-4 py-2.5 text-xs text-sky-200">
          <span className="inline-flex items-center gap-1.5 font-semibold text-sky-300">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sky-400" />
            Amendment in progress
          </span>
          <span className="text-sky-300/90">
            {amendmentBanner.originalLabel}
            {amendmentBanner.previousVerifiedAt ? ` · Previously verified ${new Date(amendmentBanner.previousVerifiedAt).toLocaleDateString()}` : ""}
          </span>
          {amendmentBanner.amendmentReason ? <span className="text-sky-300/90">Reason: {amendmentBanner.amendmentReason}</span> : null}
          {amendmentBanner.previousRevisionId ? (
            <Link href={`/manager/purchases/${amendmentBanner.previousRevisionId}`} className="ml-auto shrink-0 underline underline-offset-2 hover:text-sky-100">
              View previous verified version
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
