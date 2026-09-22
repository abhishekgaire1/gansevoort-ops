"use client";

import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Shown in place of Review & Post when a manager navigates there directly
 * (URL / stepper) while one or more invoice lines are still unclassified
 * or unconfirmed. Never silently redirects: it says exactly what blocks
 * and deep-links to the first blocking line.
 */
export function Step3Unavailable({ count, onReviewLine, onBack }: { count: number; onReviewLine: () => void; onBack: () => void }) {
  const noun = `${count} invoice line${count === 1 ? "" : "s"}`;
  return (
    <div role="alert" className="mt-3 rounded-lg border border-red-800/70 bg-red-950/20 px-6 py-10 text-center">
      <p className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border-2 border-red-400 text-lg font-bold text-red-300" aria-hidden>
        !
      </p>
      <h2 className="mt-4 text-xl font-semibold text-zinc-50">Review &amp; Post unavailable — classify {noun}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-zinc-300">You must resolve every invoice line&apos;s classification before you can review and post this invoice.</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={onReviewLine} className={primaryButtonClass}>
          Review line
        </button>
        <button type="button" onClick={onBack} className={secondaryButtonClass}>
          Back to Items &amp; Receiving
        </button>
      </div>
    </div>
  );
}
