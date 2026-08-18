"use client";

/**
 * Extracted from DocumentDetailView.tsx (Milestone 2A.2) so both
 * /manager/receiving/[documentId] and /manager/purchases/[purchaseDocumentId]
 * can show the original document beside their respective panel. Images via
 * signed-URL <img>; PDFs via a native <embed> -- modern browsers render
 * multi-page PDFs this way natively, no conversion pipeline needed.
 */
export function DocumentViewer({
  viewUrl,
  viewError,
  contentType,
  heightClassName = "h-[70vh]",
}: {
  viewUrl: string | null;
  viewError: string | null;
  contentType: string;
  /** Defaults to a fixed 70vh (the original standalone-page behavior).
   * Callers embedding this inside their own fixed-height, independently-
   * scrollable workspace (the Step 1 Review Invoice split pane) pass
   * "h-full" instead, so the PDF fills its container rather than imposing
   * its own viewport-relative height. */
  heightClassName?: string;
}) {
  if (viewError) {
    return <p className="text-sm text-red-400">{viewError}</p>;
  }
  if (!viewUrl) {
    return <p className="text-sm text-zinc-500">Loading document…</p>;
  }
  if (contentType === "application/pdf") {
    return <embed src={viewUrl} type="application/pdf" className={`${heightClassName} w-full rounded-lg`} />;
  }
  // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, not an optimizable static asset
  return <img src={viewUrl} alt="Original document" className={`max-${heightClassName} w-full rounded-lg object-contain`} />;
}
