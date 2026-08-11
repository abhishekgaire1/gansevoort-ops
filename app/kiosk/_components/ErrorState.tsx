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
 */
export function ErrorState({ title, message, primaryAction, secondaryAction }: ErrorStateProps) {
  return (
    <div role="alert" className="rounded-2xl border-2 border-amber-500/40 bg-amber-500/10 px-6 py-5">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 text-2xl">
          ⚠
        </span>
        <div className="flex-1">
          <p className="text-lg font-semibold text-amber-200">{title}</p>
          {message ? <p className="mt-1 text-base text-amber-100/80">{message}</p> : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={primaryAction.onClick}
              className="rounded-full bg-amber-400 px-6 py-3 text-base font-semibold text-zinc-950 transition hover:bg-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-100"
            >
              {primaryAction.label}
            </button>
            {secondaryAction ? (
              <button
                type="button"
                onClick={secondaryAction.onClick}
                className="rounded-full border border-amber-400/50 px-6 py-3 text-base font-medium text-amber-200 transition hover:bg-amber-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-100"
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
