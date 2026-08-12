"use client";

import { useEffect } from "react";

interface SuccessStateProps {
  onDone: () => void;
  autoReturnMs?: number;
}

/**
 * Always this same calm message, regardless of whether the withdrawal
 * tripped a HIGH_WITHDRAWAL exception -- the employee is never told they
 * triggered a management exception (see CLAUDE.md / the approved plan §1).
 * Dismissible early by tap, not just the timer -- don't force an
 * un-skippable wait.
 */
export function SuccessState({ onDone, autoReturnMs = 3000 }: SuccessStateProps) {
  useEffect(() => {
    const timer = setTimeout(onDone, autoReturnMs);
    return () => clearTimeout(timer);
  }, [onDone, autoReturnMs]);

  return (
    <button
      type="button"
      onClick={onDone}
      className="flex flex-1 flex-col items-center justify-center gap-6 text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-kiosk-amber"
    >
      <span className="flex h-24 w-24 items-center justify-center rounded-full bg-kiosk-green/15 text-5xl text-kiosk-green" aria-hidden="true">
        ✓
      </span>
      <span className="text-3xl font-semibold text-kiosk-text">Withdrawal recorded.</span>
      <span className="text-lg text-kiosk-text-muted">Returning to PIN entry…</span>
    </button>
  );
}
