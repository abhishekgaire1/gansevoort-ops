"use client";

interface SetupRequiredNoticeProps {
  onBack: () => void;
}

/**
 * Compact, calm inline notice for an item that isn't ready for withdrawal
 * yet (its base-unit identity mapping is missing) -- deliberately NOT the
 * alarm-styled ErrorState treatment used for network/session failures:
 * this is a master-data setup gap, not something the employee did wrong.
 * The item catalog already excludes items in this state (see
 * app/lib/kiosk/inventoryItems.ts), so reaching this at all is a rare
 * residual/race case. No database/technical terminology.
 */
export function SetupRequiredNotice({ onBack }: SetupRequiredNoticeProps) {
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-3 text-center">
      <span className="rounded-full bg-kiosk-surface-raised px-3 py-1 text-xs font-semibold uppercase tracking-wide text-kiosk-text-subtle">
        Setup required
      </span>
      <p className="text-base text-kiosk-text-muted">
        This item isn&apos;t ready for withdrawal yet. Please choose another item or notify a manager.
      </p>
      <button
        type="button"
        onClick={onBack}
        className="mt-1 rounded-full border border-kiosk-border px-6 py-3 text-base font-medium text-kiosk-text-muted transition hover:bg-kiosk-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
      >
        Choose another item
      </button>
    </div>
  );
}
