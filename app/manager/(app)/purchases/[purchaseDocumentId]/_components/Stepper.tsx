"use client";

import type { WizardStepId, WizardStepState } from "@/app/lib/purchaseDocuments/deriveWizardProgress";

/**
 * Compact desktop workflow bar (Desktop Application Design System pass)
 * -- ONE connected row, never three separate large glowing boxes: each
 * segment is a plain button with a small state dot + word (never color
 * alone) and a one-line truthful progress message, divided by restrained
 * 1px separators. Deliberately lighter-weight than the actual work it
 * sits above -- the stepper orients, it doesn't compete for attention.
 */
const STEP_LABELS: Record<WizardStepId, string> = {
  1: "Review Invoice",
  2: "Items & Receiving",
  3: "Review & Post",
};

const STATE_WORD: Record<WizardStepState, string> = {
  complete: "Complete",
  current: "In progress",
  not_started: "Not started",
  needs_attention: "Needs attention",
};

const STATE_DOT_CLASS: Record<WizardStepState, string> = {
  complete: "bg-emerald-400",
  current: "bg-amber-400",
  not_started: "bg-zinc-600",
  needs_attention: "bg-amber-500",
};

const STATE_TEXT_CLASS: Record<WizardStepState, string> = {
  complete: "text-emerald-400",
  current: "text-amber-300",
  not_started: "text-zinc-500",
  needs_attention: "text-amber-400",
};

export function Stepper({
  steps,
  activeStep,
  furthestReachableStep,
  onNavigate,
  stepStatusText,
}: {
  steps: { id: WizardStepId; state: WizardStepState }[];
  activeStep: WizardStepId;
  furthestReachableStep: WizardStepId;
  onNavigate: (step: WizardStepId) => void;
  /** Extra status line under a specific step (e.g. "7 of 9 complete" or
   * "3 issues remaining") -- reported by that step's own panel, never
   * recomputed here. */
  stepStatusText?: Partial<Record<WizardStepId, string>>;
}) {
  return (
    <nav aria-label="Invoice preparation steps" className="flex overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
      {steps.map((step, index) => {
        const clickable = step.id <= furthestReachableStep;
        const status = stepStatusText?.[step.id];
        const isActive = step.id === activeStep;
        return (
          <button
            key={step.id}
            type="button"
            onClick={() => clickable && onNavigate(step.id)}
            disabled={!clickable}
            aria-current={isActive ? "step" : undefined}
            className={`flex min-w-0 flex-1 items-center gap-2.5 px-4 py-2.5 text-left transition-colors disabled:cursor-not-allowed ${
              index > 0 ? "border-l border-zinc-800" : ""
            } ${isActive ? "bg-zinc-800/60" : clickable ? "hover:bg-zinc-800/30" : ""}`}
          >
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT_CLASS[step.state]}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="text-[13px] font-semibold text-zinc-100">
                  {step.id} · {STEP_LABELS[step.id]}
                </span>
                <span className={`text-[11px] font-medium ${STATE_TEXT_CLASS[step.state]}`}>{STATE_WORD[step.state]}</span>
              </span>
              {status ? <span className="mt-0.5 block truncate text-[11px] text-zinc-500">{status}</span> : null}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
