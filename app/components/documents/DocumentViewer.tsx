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
