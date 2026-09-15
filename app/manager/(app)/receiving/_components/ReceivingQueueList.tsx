"use client";

import { useState } from "react";
import Link from "next/link";
import { loadMoreReceivingQueueAction } from "@/app/actions/receiving";
import type { ReceivingQueueFilters, ReceivingQueueItem, ReceivingQueueCursor } from "@/app/lib/documents/receivingQueue";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { EmptyState } from "@/app/components/manager/EmptyState";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { receivingStatusPresentation, viewerRelationshipFor, type ReceivingTabKey } from "../_lib/receivingPresentation";

/**
 * Receiving Queue rows + Load More (Receiving Queue pagination) -- the
 * row markup moved verbatim out of page.tsx so the first page stays
 * fully server-rendered while further (older) pages append client-side
 * via loadMoreReceivingQueueAction, the same ActivityTab pattern every
 * other paginated list in this app uses. Filters/tab remain URL-driven:
 * changing either is a real navigation that re-renders page one, so no
 * cursor-reset state exists here.
 */
export function ReceivingQueueList({
  initialItems,
  initialNextCursor,
  filters,
  tab,
  currentAppUserId,
}: {
  initialItems: ReceivingQueueItem[];
  initialNextCursor: ReceivingQueueCursor | null;
  filters: ReceivingQueueFilters;
  tab: ReceivingTabKey;
  currentAppUserId: string;
}) {
  const [items, setItems] = useState<ReceivingQueueItem[]>(initialItems);
  const [cursor, setCursor] = useState<ReceivingQueueCursor | null>(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLoadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await loadMoreReceivingQueueAction(filters, tab, cursor);
      if (!result.ok) {
        setError("Unable to load more documents.");
        return;
      }
      setItems((prev) => [...prev, ...result.page.items]);
      setCursor(result.page.nextCursor);
    } catch {
      setError("Unable to load more documents.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="mt-6 flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
        {items.length === 0 ? (
          <div className="p-1">
            <EmptyState
              message="No documents match these filters."
              action={
                <Link href="/manager/receiving" className="text-xs text-amber-400 underline">
                  Clear Filters
                </Link>
              }
            />
          </div>
        ) : (
          items.map((item) => {
            const href = item.purchaseDocumentId ? `/manager/purchases/${item.purchaseDocumentId}` : `/manager/receiving/${item.documentId}`;
            const viewer = viewerRelationshipFor(item.createdByAppUserId, currentAppUserId);
            const presentation = receivingStatusPresentation(item.status, viewer, item.postingStatus);
            return (
              <Link key={item.documentId} href={href} className="flex items-center justify-between gap-4 px-4 py-4 hover:bg-zinc-800/50">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-zinc-100">{item.vendorName ?? item.originalFilename}</p>
                    {item.documentType ? <span className="shrink-0 text-xs text-zinc-500">{item.documentType}</span> : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {item.documentNumber ? `#${item.documentNumber} · ` : ""}
                    {item.documentDate ? `${item.documentDate} · ` : ""}
                    Uploaded by {item.uploadedByName} on {new Date(item.createdAt).toLocaleDateString()}
                    {item.verifiedByName ? ` · Verified by ${item.verifiedByName}` : ""}
                    {item.verificationMethod === "SOLE_APPROVER" ? " · Single-manager approval" : ""}
                  </p>
                  {/* Status Language -- Verification: viewer-relative context
                      line, never a fabricated "sent at" time (the queue's own
                      createdAt is the ORIGINAL upload time, not the later
                      submit time -- shown truthfully as "Uploaded by" above). */}
                  {item.status === "READY_FOR_VERIFICATION" && viewer === "preparer" ? (
                    <p className="mt-0.5 text-xs text-zinc-500">Waiting for another manager to verify.</p>
                  ) : null}
                  {item.status === "READY_FOR_VERIFICATION" && viewer === "eligible_verifier" && item.createdByName ? (
                    <p className="mt-0.5 text-xs text-zinc-500">Prepared by {item.createdByName}</p>
                  ) : null}
                  {item.originalVendorName || item.originalDocumentType ? (
                    <p className="mt-0.5 truncate text-xs text-amber-500">
                      Originally selected: {item.originalVendorName ?? ""}
                      {item.originalVendorName && item.originalDocumentType ? " · " : ""}
                      {item.originalDocumentType ?? ""}
                    </p>
                  ) : null}
                </div>
                <span className="flex shrink-0 flex-col items-end gap-1.5">
                  <StatusBadge
                    label={
                      item.isAmendmentInProgress
                        ? `Amendment ${presentation.label} · Rev ${item.revisionNumber}`
                        : !item.isAmendmentInProgress && item.status === "VERIFIED" && item.revisionNumber && item.revisionNumber > 1
                          ? `${presentation.label} · Rev ${item.revisionNumber} · Current`
                          : presentation.label
                    }
                    tone={presentation.tone}
                  />
                  {item.isAmendmentInProgress && item.currentVerifiedRevisionNumber ? (
                    <span className="text-[10px] text-zinc-500">Current verified: Rev {item.currentVerifiedRevisionNumber}</span>
                  ) : null}
                  {presentation.actionLabel ? <span className="text-xs font-medium text-amber-400">{presentation.actionLabel}</span> : null}
                </span>
              </Link>
            );
          })
        )}
      </div>

      {error ? <p className="mt-3 text-xs text-red-300">{error}</p> : null}
      {cursor ? (
        <div className="mt-3">
          <button type="button" onClick={() => void handleLoadMore()} disabled={loading} className={secondaryButtonClass}>
            {loading ? "Loading…" : "Load More"}
          </button>
        </div>
      ) : null}
    </>
  );
}
