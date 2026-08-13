"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getDocumentDownloadUrl } from "@/app/actions/documentAccess";
import { initiatePurchaseDocumentAmendment } from "@/app/actions/purchaseDocuments";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, RevisionSummary } from "@/app/lib/purchaseDocuments/types";

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  INVOICE: "Invoice",
  RECEIPT: "Receipt",
  CREDIT_MEMO: "Credit Memo",
};

interface Props {
  purchaseDocumentId: string;
  documentId: string;
  originalFilename: string;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
  vendorName: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  preparedByName: string | null;
  uploadedByName: string | null;
  isOriginalUploader: boolean;
  finalCorrectionCount: number;
  revisionNumber: number;
  amendmentReason: string | null;
  isCurrentVerified: boolean;
  revisions: RevisionSummary[];
}

function money(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  const symbol = currency && currency.length <= 3 ? currency : "$";
  return `${symbol}${value.toFixed(2)}`;
}

export function VerifiedPurchaseDocumentSummary(props: Props) {
  const router = useRouter();
  const [downloadPending, setDownloadPending] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [viewPending, setViewPending] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [amendPending, setAmendPending] = useState(false);
  const [amendError, setAmendError] = useState<string | null>(null);
  const [showAmendForm, setShowAmendForm] = useState(false);

  const typeLabel = props.header.documentType ? (DOCUMENT_TYPE_LABEL[props.header.documentType] ?? props.header.documentType) : "Document";

  async function handleDownload() {
    setDownloadPending(true);
    setDownloadError(null);
    const result = await getDocumentDownloadUrl(props.documentId);
    setDownloadPending(false);
    if (!result.ok) {
      setDownloadError(result.message);
      return;
    }
    window.location.href = result.url;
  }

  async function handleViewOriginal() {
    setViewPending(true);
    const result = await getDocumentDownloadUrl(props.documentId);
    setViewPending(false);
    if (result.ok) {
      window.open(result.url, "_blank", "noopener,noreferrer");
    }
  }

  async function handleInitiateAmendment() {
    if (!amendReason.trim()) {
      setAmendError("A reason is required.");
      return;
    }
    setAmendPending(true);
    setAmendError(null);
    const result = await initiatePurchaseDocumentAmendment(props.purchaseDocumentId, amendReason.trim());
    setAmendPending(false);
    if (!result.ok) {
      setAmendError(result.message);
      return;
    }
    router.push(`/manager/purchases/${result.purchaseDocumentId}`);
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/manager/receiving" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
        ← Receiving Queue
      </Link>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold uppercase tracking-wide text-zinc-100">{props.vendorName ?? props.originalFilename}</h1>
            <p className="mt-1 text-sm text-zinc-400">
              {typeLabel}
              {props.header.documentNumber ? ` #${props.header.documentNumber}` : ""}
              {props.header.documentDate ? ` · ${new Date(props.header.documentDate).toLocaleDateString()}` : ""}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="rounded-full bg-emerald-400/20 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-300">
              Verified{!props.isCurrentVerified ? " · Superseded" : props.revisionNumber > 1 ? ` · Rev ${props.revisionNumber} · Current` : ""}
            </span>
            {!props.isCurrentVerified ? <span className="text-xs text-amber-400">A newer revision is current -- see Revision History below.</span> : null}
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Total</p>
          <p className="text-2xl font-semibold text-zinc-50">{money(props.header.total, props.header.currency)}</p>
          <div className="mt-3 grid grid-cols-3 gap-3 text-sm text-zinc-400">
            <div>
              <p className="text-xs text-zinc-500">Subtotal</p>
              <p>{money(props.header.subtotal, props.header.currency)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Tax</p>
              <p>{money(props.header.tax, props.header.currency)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Fees</p>
              <p>{money(props.header.fees, props.header.currency)}</p>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Items</h2>
          <div className="flex flex-col divide-y divide-zinc-800 rounded-xl border border-zinc-800">
            {props.lines.length === 0 ? (
              <p className="px-4 py-3 text-sm text-zinc-500">No line items.</p>
            ) : (
              props.lines.map((line) => (
                <div key={line.lineKey ?? line.description} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-zinc-100">{line.description ?? "—"}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {[line.packageQuantity && line.packageUnit ? `${line.packageQuantity} ${line.packageUnit}` : null, line.measuredQuantity && line.measuredUnit ? `${line.measuredQuantity} ${line.measuredUnit}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                      {line.unitPrice && line.priceBasisUnit ? ` · ${money(line.unitPrice, props.header.currency)} / ${line.priceBasisUnit}` : ""}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-medium text-zinc-100">{money(line.lineTotal, props.header.currency)}</p>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <DetailField label="Vendor" value={props.vendorName} />
          <DetailField label="Document type" value={typeLabel} />
          <DetailField label="Document number" value={props.header.documentNumber} />
          <DetailField label="Document date" value={props.header.documentDate} />
          <DetailField label="PO number" value={props.header.poNumber} />
          <DetailField label="Delivery date" value={props.header.deliveryDate} />
        </div>

        <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Workflow</h2>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <DetailField label="Uploaded by" value={props.uploadedByName} />
            <DetailField label="Prepared by" value={props.preparedByName} />
            <DetailField label="Verified by" value={props.verifiedByName} />
            <DetailField label="Verified at" value={props.verifiedAt ? new Date(props.verifiedAt).toLocaleString() : null} />
          </div>
          {props.amendmentReason ? (
            <p className="mt-3 text-xs text-amber-400">
              Amendment reason (Rev {props.revisionNumber}): {props.amendmentReason}
            </p>
          ) : null}
          {props.finalCorrectionCount > 0 ? (
            <p className="mt-3 text-xs text-amber-400">
              {props.finalCorrectionCount} correction{props.finalCorrectionCount === 1 ? "" : "s"} made during verification.{" "}
              <Link href={`/manager/purchases/${props.purchaseDocumentId}/changes`} className="underline">
                View Changes
              </Link>
            </p>
          ) : null}
        </div>

        {props.revisions.length > 1 ? (
          <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Revision History</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {props.revisions.map((revision) => (
                <li key={revision.purchaseDocumentId} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between">
                    <Link
                      href={`/manager/purchases/${revision.purchaseDocumentId}`}
                      className={revision.purchaseDocumentId === props.purchaseDocumentId ? "font-semibold text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}
                    >
                      Revision {revision.revisionNumber}
                    </Link>
                    <span
                      className={
                        revision.isCurrentVerified
                          ? "text-xs text-emerald-400"
                          : revision.status === "DISCARDED"
                            ? "text-xs text-red-400"
                            : "text-xs text-zinc-500"
                      }
                    >
                      {revision.isCurrentVerified ? "Current" : revision.status === "VERIFIED" ? "Superseded" : revision.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  {revision.status === "DISCARDED" ? (
                    <p className="pl-1 text-xs text-zinc-500">
                      {revision.discardedByName ? `Discarded by ${revision.discardedByName}` : "Discarded"}
                      {revision.discardedAt ? ` on ${new Date(revision.discardedAt).toLocaleString()}` : ""}
                      {revision.discardReason ? ` — ${revision.discardReason}` : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {downloadError ? <p className="mt-4 text-sm text-red-400">{downloadError}</p> : null}
        {amendError ? <p className="mt-4 text-sm text-red-400">{amendError}</p> : null}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleViewOriginal}
            disabled={viewPending}
            className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200 disabled:opacity-40"
          >
            View Original Document
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloadPending}
            className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200 disabled:opacity-40"
          >
            {downloadPending ? "Preparing…" : "Download"}
          </button>
          {props.isCurrentVerified ? (
            <button
              type="button"
              onClick={() => setShowAmendForm((v) => !v)}
              className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950"
            >
              Correct Verified Document
            </button>
          ) : null}
        </div>

        {showAmendForm ? (
          <div className="mt-4 flex flex-col gap-3 rounded-xl border border-amber-800 bg-amber-950/30 p-4">
            <label className="flex flex-col gap-1 text-xs text-amber-200">
              Reason for correction
              <input
                type="text"
                value={amendReason}
                onChange={(event) => setAmendReason(event.target.value)}
                placeholder="e.g. Total transcribed incorrectly"
                className="rounded-lg border border-amber-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
              />
            </label>
            <div>
              <button
                type="button"
                onClick={handleInitiateAmendment}
                disabled={amendPending}
                className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
              >
                {amendPending ? "Starting…" : "Start Correction"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-sm text-zinc-200">{value ?? "—"}</p>
    </div>
  );
}
