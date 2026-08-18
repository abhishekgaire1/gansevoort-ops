import type { WizardStepId } from "./deriveWizardProgress";

/** URL-backed step navigation (?step=invoice|items|receiving|review) --
 * lets a refresh or the browser Back/Forward button land on the step the
 * manager was actually looking at, without a new persisted workflow-state
 * column: the query param is purely a navigation hint, re-validated on
 * every render against deriveWizardProgress's own furthest-reachable
 * clamp, so it can never be used to skip ahead of genuinely incomplete
 * work. */
export const WIZARD_STEP_SLUGS: Record<WizardStepId, string> = {
  1: "invoice",
  2: "items",
  3: "receiving",
  4: "review",
};

export function wizardStepFromSlug(slug: string | null): WizardStepId | null {
  if (!slug) return null;
  const entry = Object.entries(WIZARD_STEP_SLUGS).find(([, s]) => s === slug);
  return entry ? (Number(entry[0]) as WizardStepId) : null;
}
