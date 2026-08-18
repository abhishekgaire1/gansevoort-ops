import type { ClassificationRunStatus } from "@/app/lib/itemMaster/getClassificationRunStatus";

/**
 * What Step 2's blocking "Matching Items" poll loop should conclude once
 * it stops (either because the run finished, or because the poll cap was
 * reached) -- pulled out as a pure function so the recovery-state decision
 * is directly testable, matching computeReceivingPrefill.ts/
 * continueFromStep1.ts's precedent of keeping safety-relevant decisions
 * out of component state machines.
 *
 * - "resolved": the run is no longer active and didn't fail -- safe to
 *   reload and show the normal Confirm Items summary.
 * - "stillActive": the poll cap was reached but a run is GENUINELY still
 *   claimed -- never start a second, conflicting run here; the recovery
 *   action must only resume checking.
 * - "failed": the run finished with outcome FAILED -- a real failure, not
 *   a timeout, shown distinctly.
 * - "unknown": the status couldn't be determined at all (e.g. a request
 *   error) -- treated the same as a stuck state, offering recovery rather
 *   than spinning forever on unreadable data.
 */
export type MatchingRecoveryPhase = "resolved" | "stillActive" | "failed" | "unknown";

export function decideMatchingOutcome(lastStatus: ClassificationRunStatus | null): MatchingRecoveryPhase {
  if (lastStatus === null) return "unknown";
  if (lastStatus.active) return "stillActive";
  if (lastStatus.outcome === "FAILED") return "failed";
  return "resolved";
}
