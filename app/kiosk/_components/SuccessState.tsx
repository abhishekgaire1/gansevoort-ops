"use client";

interface SuccessStateProps {
  itemCount: number;
  stationName: string;
  onWithdrawMore: () => void;
  onFinish: () => void;
}

/**
 * Always this same calm message, regardless of whether any line tripped
 * a HIGH_WITHDRAWAL exception -- the employee is never told they
 * triggered a management exception (CLAUDE.md). No auto-return timer
 * (2A.5 Part 21 replaced the old single-item auto-advance-to-PIN with an
 * explicit choice): Withdraw More stays authenticated at the same
 * session station for the next item; Finish is the only path back to
 * PIN entry.
 */
export function SuccessState({ itemCount, stationName, onWithdrawMore, onFinish }: SuccessStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <span className="flex h-24 w-24 items-center justify-center rounded-full bg-kiosk-green/15 text-5xl text-kiosk-green" aria-hidden="true">
        ✓
      </span>
      <div>
        <p className="text-3xl font-semibold text-kiosk-text">Withdrawal Recorded</p>
        <p className="mt-2 text-lg text-kiosk-text-muted">
          {itemCount} {itemCount === 1 ? "item" : "items"} · {stationName}
        </p>
      </div>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={onWithdrawMore}
          className="rounded-full bg-kiosk-amber px-8 py-4 text-lg font-semibold text-kiosk-amber-ink transition hover:bg-kiosk-amber-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber-strong"
        >
          Withdraw More
        </button>
        <button
          type="button"
          onClick={onFinish}
          className="rounded-full border border-kiosk-border px-8 py-4 text-lg font-medium text-kiosk-text-muted transition hover:bg-kiosk-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
        >
          Finish
        </button>
      </div>
    </div>
  );
}
