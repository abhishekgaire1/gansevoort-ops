"use client";

import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * The ONE consistent action location for every Receiving workflow step
 * (Receiving UX Interaction System pass). Every step footer looks and
 * behaves the same way: Back/context on the left, exactly one primary
 * action on the right, an optional secondary action beside it. This
 * replaces several screens' own ad hoc "Continue" button placement
 * (mid-page, bottom-left, inside a card) with one predictable pattern --
 * see PreparationWizard.tsx/Step1ReviewInvoice.tsx/Step4ReviewSend.tsx/
 * VerifiedPurchaseDocumentSummary.tsx for call sites.
 *
 * Sticky by default so a long invoice never hides the action the manager
 * actually needs -- but it is NEVER itself a warning box: `contextLabel` is
 * a single short line (e.g. "2 items need attention"), not a place to dump
 * every blocking reason. Full reasons belong at the field/row that has
 * them (InlineValidationMessage) -- this footer only summarizes and,
 * optionally, jumps to the first one via `onContextClick`.
 */
export function WorkflowFooter({
  contextLabel,
  contextTone = "neutral",
  onContextClick,
  onBack,
  backLabel = "Back",
  primaryLabel,
  onPrimary,
  primaryDisabled,
  primaryPending,
  primaryPendingLabel,
  primaryTitle,
  secondaryLabel,
  onSecondary,
  secondaryDisabled,
  secondaryPending,
  secondaryPendingLabel,
  sticky = true,
}: {
  contextLabel?: string;
  contextTone?: "neutral" | "warning";
  /** Present only when contextTone is "warning" and there's a first issue
   * to jump to -- makes the summary itself the "scroll to first problem"
   * affordance (Part 7 of the interaction spec), never just inert text. */
  onContextClick?: () => void;
  onBack?: () => void;
  backLabel?: string;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  primaryPending?: boolean;
  primaryPendingLabel?: string;
  primaryTitle?: string;
  secondaryLabel?: string;
  onSecondary?: () => void;
  secondaryDisabled?: boolean;
  secondaryPending?: boolean;
  secondaryPendingLabel?: string;
  sticky?: boolean;
}) {
  const contextClass = contextTone === "warning" ? "text-amber-400" : "text-zinc-500";
  return (
    <div
      // pr reserves space clear of the floating "Ask Gansevoort" launcher
      // (fixed bottom-right, z-40, roughly 11rem wide including its own
      // offset) -- without this, the launcher renders on top of this
      // footer's own primary action in the same bottom-right corner.
      className={`flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 pr-4 backdrop-blur sm:pr-44 ${
        sticky ? "sticky bottom-0 z-10 -mx-4 sm:mx-0 sm:rounded-b-2xl" : "rounded-2xl border"
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        {onBack ? (
          <button type="button" onClick={onBack} className={secondaryButtonClass}>
            {backLabel}
          </button>
        ) : null}
        {contextLabel ? (
          onContextClick ? (
            <button type="button" onClick={onContextClick} className={`text-xs font-medium underline underline-offset-2 ${contextClass}`}>
              {contextLabel}
            </button>
          ) : (
            <span className={`text-xs font-medium ${contextClass}`}>{contextLabel}</span>
          )
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {secondaryLabel && onSecondary ? (
          <button type="button" onClick={onSecondary} disabled={secondaryDisabled || secondaryPending} className={secondaryButtonClass}>
            {secondaryPending ? (secondaryPendingLabel ?? "Working…") : secondaryLabel}
          </button>
        ) : null}
        <button type="button" onClick={onPrimary} disabled={primaryDisabled || primaryPending} title={primaryTitle} className={primaryButtonClass}>
          {primaryPending ? (primaryPendingLabel ?? "Working…") : primaryLabel}
        </button>
      </div>
    </div>
  );
}
