"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { computeExtractionProgress } from "@/app/lib/documents/extractionProgress";
import type { DocumentDisplayStatus } from "@/app/lib/documents/documentStatus";

/**
 * The blocking "Extracting…" screen shown immediately after a fresh upload
 * (scoped by the ?extracting=1 redirect flag, so revisiting an old document
 * never shows it). It polls via the parent's StatusPoller and, on success,
 * the parent auto-creates the draft and routes into the editable wizard --
 * this component just renders the wait, the honest hybrid progress bar, and
 * a graceful failure/escape path so a slow or failed extraction never traps
 * the manager here.
 *
 * The percentage is an honest estimate, never a measurement: see
 * computeExtractionProgress. A local 250ms clock advances it smoothly
 * between the real state anchors the poller refreshes.
 */

const ESCAPE_AFTER_MS = 25_000;

export function ExtractionProgressOverlay({
  filename,
  status,
  attemptStatus,
  requestedAt,
  startedAt,
  pageCount,
  opening,
  errorMessage,
  postSuccessError,
  onRetry,
  retryPending,
  onContinue,
  onManageUpload,
}: {
  filename: string;
  status: DocumentDisplayStatus;
  attemptStatus: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | null;
  requestedAt: string | null;
  startedAt: string | null;
  pageCount: number;
  /** The draft is being created after a successful extraction. */
  opening: boolean;
  /** The extraction itself failed/stalled -- message for that branch. */
  errorMessage: string | null;
  /** Extraction succeeded but auto-creating the draft failed -- keeps the
   * manager unblocked with a manual "Open Draft" instead of a dead 100%. */
  postSuccessError: string | null;
  onRetry: () => void;
  retryPending: boolean;
  /** Retry the draft creation after a post-success failure. */
  onContinue: () => void;
  /** Drop the ?extracting flag and reveal the full document page (Remove
   * Upload, history, manual actions). */
  onManageUpload: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  const progress = computeExtractionProgress({ status, attemptStatus, requestedAt, startedAt, now, opening });

  useEffect(() => {
    // Tick a local clock only while the bar is still moving -- once the
    // extraction is terminal (done/failed) there is nothing left to
    // animate, so no interval is created.
    if (progress.done || progress.failed) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [progress.done, progress.failed]);

  const startedMs = requestedAt ? new Date(requestedAt).getTime() : now;
  const elapsedSeconds = Math.max(0, Math.floor((now - startedMs) / 1000));
  const showEscape = !progress.failed && !progress.done && now - startedMs > ESCAPE_AFTER_MS;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <div className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Reading your invoice</p>
        <h1 className="mt-2 truncate text-lg font-semibold text-zinc-100" title={filename}>
          {filename}
        </h1>

        {progress.failed ? (
          <div className="mt-6 flex flex-col items-center gap-4">
            <p className="text-sm text-red-300">
              {status === "STALLED"
                ? "Extraction is taking too long and appears stalled."
                : (errorMessage ?? "Extraction failed. You can try again or manage this upload.")}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={onRetry}
                disabled={retryPending}
                className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-40"
              >
                {retryPending ? "Retrying…" : "Retry Extraction"}
              </button>
              <button type="button" onClick={onManageUpload} className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200">
                Manage Upload
              </button>
            </div>
            <Link href="/manager/receiving" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300">
              Back to Receiving Queue
            </Link>
          </div>
        ) : progress.done && !opening && postSuccessError ? (
          <div className="mt-6 flex flex-col items-center gap-4">
            <p className="text-sm text-zinc-200">Extraction finished, but opening the draft didn&apos;t go through.</p>
            <p className="text-xs text-red-300">{postSuccessError}</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button type="button" onClick={onContinue} className="rounded-full bg-amber-400 px-5 py-2 text-sm font-semibold text-zinc-950">
                Open Draft
              </button>
              <button type="button" onClick={onManageUpload} className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-200">
                Manage Upload
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-6 h-2.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-amber-400 transition-[width] duration-300 ease-out"
                style={{ width: `${progress.percent}%` }}
                role="progressbar"
                aria-valuenow={progress.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Extraction progress (estimated)"
              />
            </div>
            <p className="mt-3 text-3xl font-semibold tabular-nums text-zinc-100">{progress.percent}%</p>
            <p className="mt-1 text-sm text-zinc-400">{progress.label}</p>
            <p className="mt-4 text-xs text-zinc-500">
              {pageCount} page{pageCount === 1 ? "" : "s"} · {elapsedSeconds}s elapsed
            </p>

            {showEscape ? (
              <div className="mt-6 border-t border-zinc-800 pt-4">
                <p className="text-xs text-zinc-500">Taking longer than usual. You can keep waiting, or come back to it later.</p>
                <Link href="/manager/receiving" className="mt-2 inline-block text-xs text-amber-400 underline underline-offset-2">
                  Back to Receiving Queue
                </Link>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
