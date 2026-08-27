"use client";

import { useEffect, useState } from "react";
import { getDocumentPageViewUrls } from "@/app/actions/documentAccess";

/**
 * Multi-page capture (100127): shared by both document-review surfaces
 * (/manager/receiving/[documentId] and /manager/purchases/[purchaseDocumentId])
 * so a manager can move between every captured page of a document, not
 * just page 1. Deliberately a thin wrapper around the existing
 * `viewUrl`/`viewError`/`contentType` props every downstream viewer
 * (DocumentViewer, FinalReviewView, PreparationWizard) already accepts --
 * those components need no changes at all; this hook just decides WHICH
 * page's URL currently occupies that slot. A single-page document (every
 * document before 100127, and the overwhelming majority after it) never
 * shows page controls at all.
 */
export interface DocumentPageNavigatorState {
  viewUrl: string | null;
  viewError: string | null;
  contentType: string;
  pageNumber: number;
  pageCount: number;
  goToPage: (pageNumber: number) => void;
  goPrev: () => void;
  goNext: () => void;
}

export function useDocumentPageNavigator(documentId: string, fallbackContentType: string): DocumentPageNavigatorState {
  const [pages, setPages] = useState<{ pageNumber: number; url: string; contentType: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);

  useEffect(() => {
    let cancelled = false;
    getDocumentPageViewUrls(documentId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setPages(result.pages);
      } else {
        setError(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const pageCount = pages?.length ?? 1;
  const current = pages?.find((p) => p.pageNumber === pageNumber) ?? pages?.[0] ?? null;

  return {
    viewUrl: current?.url ?? null,
    viewError: error,
    contentType: current?.contentType ?? fallbackContentType,
    pageNumber: current?.pageNumber ?? pageNumber,
    pageCount,
    goToPage: (n: number) => setPageNumber(Math.min(Math.max(n, 1), pageCount)),
    goPrev: () => setPageNumber((n) => Math.max(1, n - 1)),
    goNext: () => setPageNumber((n) => Math.min(pageCount, n + 1)),
  };
}

/** Prev/Next + "Page X of N" -- rendered only when there's more than one
 * page; a single-page document shows nothing here at all. Large touch
 * targets, keyboard-operable native <button>s, and the page count is
 * always stated as text (never conveyed by color/icon alone). */
export function DocumentPageNavigatorControls({
  pageNumber,
  pageCount,
  onPrev,
  onNext,
}: {
  pageNumber: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (pageCount <= 1) return null;

  return (
    <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <button
        type="button"
        onClick={onPrev}
        disabled={pageNumber <= 1}
        aria-label="Previous page"
        className="rounded-full border border-zinc-700 px-3 py-1 text-xs font-semibold text-zinc-200 disabled:opacity-40"
      >
        ← Prev
      </button>
      <p className="text-xs font-medium text-zinc-300">
        Page {pageNumber} of {pageCount}
      </p>
      <button
        type="button"
        onClick={onNext}
        disabled={pageNumber >= pageCount}
        aria-label="Next page"
        className="rounded-full border border-zinc-700 px-3 py-1 text-xs font-semibold text-zinc-200 disabled:opacity-40"
      >
        Next →
      </button>
    </div>
  );
}
