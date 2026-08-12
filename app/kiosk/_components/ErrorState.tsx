"use client";

interface ErrorAction {
  label: string;
  onClick: () => void;
}

interface ErrorStateProps {
  title: string;
  message?: string;
  primaryAction: ErrorAction;
  secondaryAction?: ErrorAction;
}

/**
 * One generic shape covers every error case in the approved plan's §7
 * table -- errors are always paired with an icon + text, never color alone.
 *
 * Coral/red is reserved for the alert chrome (border/icon/title/message)
 * only -- it signals "something's wrong," never "tap here." The primary
 * action is still amber: it's a recovery step (retry/dismiss/try again),
 * not itself destructive, so it stays the same brand/action color used for
 * Continue/Confirm everywhere else. The secondary action is neutral
 * charcoal, matching every other secondary/cancel button in the kiosk.
 */
export function ErrorState({ title, message, primaryAction, secondaryAction }: ErrorStateProps) {
  return (
    <div role="alert" className="rounded-2xl border-2 border-kiosk-coral/40 bg-kiosk-coral/10 px-6 py-5">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 text-2xl text-kiosk-coral">
          ⚠
        </span>
        <div className="flex-1">
          <p className="text-lg font-semibold text-kiosk-coral-strong">{title}</p>
          {message ? <p className="mt-1 text-base text-kiosk-coral-strong/80">{message}</p> : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={primaryAction.onClick}
              className="rounded-full bg-kiosk-amber px-6 py-3 text-base font-semibold text-kiosk-amber-ink transition hover:bg-kiosk-amber-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber-strong"
            >
              {primaryAction.label}
            </button>
            {secondaryAction ? (
              <button
                type="button"
                onClick={secondaryAction.onClick}
                className="rounded-full border border-kiosk-border px-6 py-3 text-base font-medium text-kiosk-text-muted transition hover:bg-kiosk-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
              >
                {secondaryAction.label}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
