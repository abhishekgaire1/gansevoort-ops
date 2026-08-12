"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getDocumentViewUrl, getDocumentDownloadUrl } from "@/app/actions/documentAccess";
import { retryDocumentExtraction } from "@/app/actions/documentExtraction";
import { ExtractionPanel } from "@/app/components/invoiceExtraction/ExtractionPanel";
import { StatusPoller } from "@/app/components/documents/StatusPoller";
import { deriveDocumentStatus, type DocumentDisplayStatus } from "@/app/lib/documents/documentStatus";
import { shouldPollForStatuses } from "@/app/lib/documents/pollingDecision";
import { safeExtractionErrorMessage } from "@/app/lib/documents/extractionErrorMessages";
import type { NormalizedInvoiceExtraction, ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";

export interface AttemptView {
  id: string;
  attemptNumber: number;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  model: string;
  normalizedExtraction: NormalizedInvoiceExtraction | null;
  reviewFlags: ReviewFlag[];
  errorCode: string | null;
}

const STATUS_LABEL: Record<DocumentDisplayStatus, string> = {
  PROCESSING: "Processing",
  STALLED: "Extraction Stalled",
  NEEDS_REVIEW: "Needs Review (Extracted — Unverified)",
  FAILED: "Extraction Failed",
};

/**
 * Responsive layout: desktop shows the document viewer beside the
 * extraction panel, side by side. Tablet/narrow gets an explicit toggle
 * between full-width document and full-width panel -- not a drawer, since
 * reviewing extraction against the source means repeatedly glancing back
 * at the document, which a closing-on-interaction drawer would fight
 * against.
 */
export function DocumentDetailView({
  documentId,
  originalFilename,
  contentType,
  attempts,
}: {
  documentId: string;
  originalFilename: string;
  contentType: string;
  attempts: AttemptView[];
}) {
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [downloadPending, setDownloadPending] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [narrowPane, setNarrowPane] = useState<"document" | "extraction">("document");

  const latest = attempts[0] ?? null;
  const status = deriveDocumentStatus(latest);

  useEffect(() => {
    let cancelled = false;

    getDocumentViewUrl(documentId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setViewUrl(result.url);
      } else {
        setViewError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  async function handleDownload() {
    setDownloadPending(true);
    const result = await getDocumentDownloadUrl(documentId);
    setDownloadPending(false);
    if (result.ok) {
      window.open(result.url, "_blank", "noopener,noreferrer");
    }
  }

  async function handleRetry() {
    setRetryPending(true);
    setRetryError(null);
    const result = await retryDocumentExtraction(documentId);
    setRetryPending(false);
    if (!result.ok) {
      setRetryError(result.message);
      return;
    }
    window.location.reload();
  }

  const canRetry = status === "FAILED" || status === "STALLED";

  return (
    <div className="mx-auto max-w-6xl">
      <StatusPoller active={shouldPollForStatuses([status])} />
      <Link
        href="/manager/receiving"
        className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
      >
        ← Receiving Queue
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{originalFilename}</h1>
          <p className="mt-1 text-sm text-zinc-500">{STATUS_LABEL[status]}</p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloadPending}
            className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-200 disabled:opacity-40"
          >
            {downloadPending ? "Preparing…" : "Download"}
          </button>
          {canRetry ? (
            <button
              type="button"
              onClick={handleRetry}
              disabled={retryPending}
              className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
            >
              {retryPending ? "Retrying…" : "Retry Extraction"}
            </button>
          ) : null}
        </div>
      </div>
      {retryError ? <p className="mt-2 text-sm text-red-400">{retryError}</p> : null}

      <div className="mt-4 flex gap-2 lg:hidden">
        <button
          type="button"
          onClick={() => setNarrowPane("document")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold ${
            narrowPane === "document" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-300"
          }`}
        >
          Document
        </button>
        <button
          type="button"
          onClick={() => setNarrowPane("extraction")}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold ${
            narrowPane === "extraction" ? "bg-zinc-100 text-zinc-950" : "bg-zinc-800 text-zinc-300"
          }`}
        >
          Extraction
        </button>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className={`rounded-2xl border border-zinc-800 bg-zinc-900 p-4 ${narrowPane === "document" ? "" : "hidden lg:block"}`}>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Original Document</h2>
          <DocumentViewer viewUrl={viewUrl} viewError={viewError} contentType={contentType} />
        </div>

        <div className={`flex flex-col gap-6 ${narrowPane === "extraction" ? "" : "hidden lg:flex"}`}>
          {latest?.normalizedExtraction ? (
            <ExtractionPanel
              title={`Attempt ${latest.attemptNumber}`}
              normalized={latest.normalizedExtraction}
              issues={latest.reviewFlags}
              model={latest.model}
            />
          ) : latest?.status === "FAILED" ? (
            <div className="rounded-2xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">
              {safeExtractionErrorMessage(latest.errorCode)}
            </div>
          ) : (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">
              {status === "STALLED" ? "Extraction stalled. Retry to try again." : "Extraction in progress…"}
            </div>
          )}

          <AttemptHistory attempts={attempts} />
        </div>
      </div>
    </div>
  );
}

function DocumentViewer({
  viewUrl,
  viewError,
  contentType,
}: {
  viewUrl: string | null;
  viewError: string | null;
  contentType: string;
}) {
  if (viewError) {
    return <p className="text-sm text-red-400">{viewError}</p>;
  }
  if (!viewUrl) {
    return <p className="text-sm text-zinc-500">Loading document…</p>;
  }
  if (contentType === "application/pdf") {
    return <embed src={viewUrl} type="application/pdf" className="h-[70vh] w-full rounded-lg" />;
  }
  // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, not an optimizable static asset
  return <img src={viewUrl} alt="Original document" className="max-h-[70vh] w-full rounded-lg object-contain" />;
}

function AttemptHistory({ attempts }: { attempts: AttemptView[] }) {
  if (attempts.length === 0) {
    return null;
  }
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Extraction History</h2>
      <ul className="flex flex-col gap-2 text-xs text-zinc-400">
        {attempts.map((attempt) => (
          <li key={attempt.id} className="flex items-center justify-between gap-4">
            <span>
              Attempt {attempt.attemptNumber} · {attempt.model}
            </span>
            <span>
              {attempt.status} · {new Date(attempt.requestedAt).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
