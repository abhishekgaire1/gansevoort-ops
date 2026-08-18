import Link from "next/link";
import type { PurchaseDocumentHeaderDraft, PurchaseDocumentLine, RevisionSummary } from "@/app/lib/purchaseDocuments/types";
import { formatMoney } from "@/app/lib/formatMoney";

/**
 * Read-only, terminal-state view for a DISCARDED purchase_document -- no
 * form controls, no editable fields, no actions (discard is one-way).
 * The row, its lines, and its full audit history are preserved and shown
 * here purely for record-keeping; this is reachable only via a direct
 * link (e.g. from another revision's Revision History), never from the
 * normal Receiving Queue.
 */

interface Props {
  purchaseDocumentId: string;
  originalFilename: string;
  header: PurchaseDocumentHeaderDraft;
  lines: PurchaseDocumentLine[];
  revisionNumber: number;
  discardedByName: string | null;
  discardedAt: string | null;
  discardReason: string | null;
  revisions: RevisionSummary[];
}

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  INVOICE: "Invoice",
  RECEIPT: "Receipt",
  CREDIT_MEMO: "Credit Memo",
};

export function DiscardedPurchaseDocumentSummary(props: Props) {
  const typeLabel = props.header.documentType ? (DOCUMENT_TYPE_LABEL[props.header.documentType] ?? props.header.documentType) : "Document";
  const currentRevision = props.revisions.find((r) => r.isCurrentVerified);

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/manager/receiving" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
        ← Receiving Queue
      </Link>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 opacity-90">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold uppercase tracking-wide text-zinc-300">{props.originalFilename}</h1>
            <p className="mt-1 text-sm text-zinc-500">
              {typeLabel}
              {props.header.documentNumber ? ` #${props.header.documentNumber}` : ""}
              {props.revisionNumber > 1 ? ` · Rev ${props.revisionNumber}` : ""}
            </p>
          </div>
          <span className="rounded-full bg-red-400/20 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-300">Discarded</span>
        </div>

        <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">
          <p>
            {props.discardedByName ? `Discarded by ${props.discardedByName}` : "Discarded"}
            {props.discardedAt ? ` on ${new Date(props.discardedAt).toLocaleString()}` : ""}
          </p>
          {props.discardReason ? <p className="mt-1 text-zinc-300">Reason: {props.discardReason}</p> : null}
          {currentRevision ? (
            <p className="mt-2">
              The current verified record for this document is{" "}
              <Link href={`/manager/purchases/${currentRevision.purchaseDocumentId}`} className="underline">
                Revision {currentRevision.revisionNumber}
              </Link>
              .
            </p>
          ) : null}
        </div>

        <div className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Items (as last saved)</h2>
          <div className="flex flex-col divide-y divide-zinc-800 rounded-xl border border-zinc-800">
            {props.lines.length === 0 ? (
              <p className="px-4 py-3 text-sm text-zinc-500">No line items.</p>
            ) : (
              props.lines.map((line) => (
                <div key={line.lineKey ?? line.description} className="flex items-center justify-between gap-4 px-4 py-3">
                  <p className="min-w-0 truncate text-sm text-zinc-300">{line.description ?? "—"}</p>
                  <p className="shrink-0 text-sm text-zinc-400">{formatMoney(line.lineTotal, props.header.currency)}</p>
                </div>
              ))
            )}
          </div>
        </div>

        {props.revisions.length > 1 ? (
          <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Revision History</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {props.revisions.map((revision) => (
                <li key={revision.purchaseDocumentId} className="flex items-center justify-between">
                  <Link
                    href={`/manager/purchases/${revision.purchaseDocumentId}`}
                    className={revision.purchaseDocumentId === props.purchaseDocumentId ? "font-semibold text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}
                  >
                    Revision {revision.revisionNumber}
                  </Link>
                  <span
                    className={
                      revision.isCurrentVerified ? "text-xs text-emerald-400" : revision.status === "DISCARDED" ? "text-xs text-red-400" : "text-xs text-zinc-500"
                    }
                  >
                    {revision.isCurrentVerified ? "Current" : revision.status === "VERIFIED" ? "Superseded" : revision.status.replace(/_/g, " ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
