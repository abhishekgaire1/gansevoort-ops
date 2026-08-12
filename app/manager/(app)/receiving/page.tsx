import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getReceivingQueue } from "@/app/lib/documents/receivingQueue";
import { deriveDocumentStatus, type DocumentDisplayStatus } from "@/app/lib/documents/documentStatus";
import { shouldPollForStatuses } from "@/app/lib/documents/pollingDecision";
import { StatusPoller } from "@/app/components/documents/StatusPoller";
import { UploadDocumentForm } from "./_components/UploadDocumentForm";

/**
 * The first real manager receiving queue -- a document/extraction queue,
 * not yet physical receiving/inventory posting (that starts in a later
 * milestone). Statuses are always derived from each document's latest
 * document_extractions row (see documentStatus.ts); documents itself has
 * no status column.
 */
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<DocumentDisplayStatus, string> = {
  PROCESSING: "Processing",
  STALLED: "Extraction Stalled",
  NEEDS_REVIEW: "Needs Review",
  FAILED: "Extraction Failed",
};

const STATUS_CLASS: Record<DocumentDisplayStatus, string> = {
  PROCESSING: "text-zinc-400",
  STALLED: "text-amber-400",
  NEEDS_REVIEW: "text-emerald-400",
  FAILED: "text-red-400",
};

export default async function ReceivingQueuePage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    // The (app) layout above already redirects unauthenticated/unauthorized
    // requests before this ever renders; this is a defensive fallback only.
    return null;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set");
  }

  const queue = await getReceivingQueue(auth.manager.organizationId);
  const statuses = queue.map((item) => deriveDocumentStatus(item.latestAttempt));

  return (
    <div className="mx-auto max-w-5xl">
      <StatusPoller active={shouldPollForStatuses(statuses)} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Receiving Queue</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Uploaded documents and their extraction status. Not yet a receiving/posting workflow.
          </p>
        </div>
        <UploadDocumentForm supabaseUrl={supabaseUrl} supabasePublishableKey={supabasePublishableKey} />
      </div>

      <div className="mt-8 flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
        {queue.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No documents uploaded yet.</p>
        ) : (
          queue.map((item, index) => {
            const status = statuses[index];
            return (
              <Link
                key={item.documentId}
                href={`/manager/receiving/${item.documentId}`}
                className="flex items-center justify-between gap-4 px-4 py-4 hover:bg-zinc-800/50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-100">
                    {item.latestAttempt?.vendorName ?? item.originalFilename}
                    {item.latestAttempt?.vendorName ? <span className="ml-2 text-xs text-zinc-500">(Extracted — Unverified)</span> : null}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {item.latestAttempt?.invoiceNumber ? `Invoice ${item.latestAttempt.invoiceNumber} · ` : ""}
                    Uploaded {new Date(item.createdAt).toLocaleString()}
                  </p>
                </div>
                <span className={`shrink-0 text-xs font-semibold uppercase tracking-wide ${STATUS_CLASS[status]}`}>
                  {STATUS_LABEL[status]}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
