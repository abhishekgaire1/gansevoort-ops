"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getDocumentViewUrl, getDocumentDownloadUrl } from "@/app/actions/documentAccess";
import { retryDocumentExtraction } from "@/app/actions/documentExtraction";
import { createOrOpenPurchaseDocumentDraft } from "@/app/actions/purchaseDocuments";
import { archiveDocument } from "@/app/actions/documentArchive";
import { ExtractionPanel } from "@/app/components/invoiceExtraction/ExtractionPanel";
import { DocumentViewer } from "@/app/components/documents/DocumentViewer";
import { StatusPoller } from "@/app/components/documents/StatusPoller";
import { deriveDocumentStatus, type DocumentDisplayStatus } from "@/app/lib/documents/documentStatus";
import { shouldPollForStatuses } from "@/app/lib/documents/pollingDecision";
import { safeExtractionErrorMessage } from "@/app/lib/documents/extractionErrorMessages";
import { openPendingTab, resolvePendingTab, closePendingTab } from "@/app/lib/browser/pendingTab";
import type { NormalizedInvoiceExtraction, ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import type { PurchaseDocumentStatus } from "@/app/lib/purchaseDocuments/types";

const PURCHASE_DOCUMENT_BUTTON_LABEL: Record<PurchaseDocumentStatus, string> = {
  DRAFT: "Open Draft",
  READY_FOR_VERIFICATION: "View Submission",
  VERIFIED: "View Verified Document",
  // Unreachable -- purchaseDocumentStatus is always the non-discarded
  // "active" revision (see page.tsx's activePurchaseDocument), kept only
  // for Record exhaustiveness.
  DISCARDED: "View Discarded Draft",
};

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
  purchaseDocumentId,
  purchaseDocumentStatus,
  hasDiscardedRevisionOne,
  canRemoveUpload,
  isArchived,
  isUploader,
  attempts,
}: {
  documentId: string;
  originalFilename: string;
  contentType: string;
  purchaseDocumentId: string | null;
  purchaseDocumentStatus: PurchaseDocumentStatus | null;
  /** Revision 1 was discarded -- a new purchase_document can never be
   * created from this document again (partial unique index), so "Create
   * Purchase Document Draft" must not be offered even if extraction
   * otherwise looks NEEDS_REVIEW. */
  hasDiscardedRevisionOne: boolean;
  /** Every purchase_document ever created from this upload (if any) is
   * DISCARDED, and it isn't already archived -- "Remove Upload" may be
   * offered. */
  canRemoveUpload: boolean;
  isArchived: boolean;
  isUploader: boolean;
  attempts: AttemptView[];
}) {
  const router = useRouter();
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [downloadPending, setDownloadPending] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [draftPending, setDraftPending] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [narrowPane, setNarrowPane] = useState<"document" | "extraction">("document");
  const [showArchiveForm, setShowArchiveForm] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [archivePending, setArchivePending] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

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
    // Opened synchronously, before the await below, so Mobile Safari's
    // popup blocker never gets a chance to treat this as a non-gesture-
    // triggered window.open() (see app/lib/browser/pendingTab.ts).
    const pendingTab = openPendingTab();
    setDownloadPending(true);
    setDownloadError(null);
    const result = await getDocumentDownloadUrl(documentId);
    setDownloadPending(false);
    if (!result.ok) {
      closePendingTab(pendingTab);
      setDownloadError(result.message);
      return;
    }
    resolvePendingTab(pendingTab, result.url);
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

  async function handleOpenOrCreateDraft() {
    if (purchaseDocumentId) {
      router.push(`/manager/purchases/${purchaseDocumentId}`);
      return;
    }
    setDraftPending(true);
    setDraftError(null);
    const result = await createOrOpenPurchaseDocumentDraft(documentId);
    setDraftPending(false);
    if (!result.ok) {
      setDraftError(result.message);
      return;
    }
    router.push(`/manager/purchases/${result.purchaseDocumentId}`);
  }

  async function handleArchive() {
    if (!window.confirm("Remove this upload? This cannot be undone.")) {
      return;
    }
    setArchivePending(true);
    setArchiveError(null);
    const result = await archiveDocument(documentId, archiveReason.trim() || undefined);
    setArchivePending(false);
    if (!result.ok) {
      setArchiveError(result.message);
      return;
    }
    router.push("/manager/receiving");
    router.refresh();
  }

  const canRetry = status === "FAILED" || status === "STALLED";
  const showDraftButton = Boolean(purchaseDocumentId) || (status === "NEEDS_REVIEW" && !hasDiscardedRevisionOne);

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
          {showDraftButton ? (
            <button
              type="button"
              onClick={handleOpenOrCreateDraft}
              disabled={draftPending}
              className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
            >
              {draftPending
                ? "Opening…"
                : purchaseDocumentStatus
                  ? PURCHASE_DOCUMENT_BUTTON_LABEL[purchaseDocumentStatus]
                  : "Create Purchase Document Draft"}
            </button>
          ) : null}
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
      {downloadError ? <p className="mt-2 text-sm text-red-400">{downloadError}</p> : null}
      {retryError ? <p className="mt-2 text-sm text-red-400">{retryError}</p> : null}
      {draftError ? <p className="mt-2 text-sm text-red-400">{draftError}</p> : null}

      {isArchived ? (
        <p className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-500">This upload has been removed.</p>
      ) : isUploader && canRemoveUpload ? (
        <div className="mt-3">
          {!showArchiveForm ? (
            <button type="button" onClick={() => setShowArchiveForm(true)} className="text-xs text-red-400 underline">
              Remove Upload
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-red-900 bg-red-950/20 p-3">
              <input
                type="text"
                value={archiveReason}
                onChange={(event) => setArchiveReason(event.target.value)}
                placeholder="Reason (optional)"
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleArchive}
                  disabled={archivePending}
                  className="rounded-full border border-red-700 px-4 py-1.5 text-xs font-semibold text-red-300 disabled:opacity-40"
                >
                  {archivePending ? "Removing…" : "Confirm Remove Upload"}
                </button>
                <button type="button" onClick={() => setShowArchiveForm(false)} className="text-xs text-zinc-400 underline">
                  Cancel
                </button>
              </div>
              {archiveError ? <p className="text-xs text-red-400">{archiveError}</p> : null}
            </div>
          )}
        </div>
      ) : null}

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
